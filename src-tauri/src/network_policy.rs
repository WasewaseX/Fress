// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT

//! Authoritative network security policy for Fress's native layer.
//!
//! The React side validates URLs for usability; this module is the layer the
//! native commands actually trust. Every outbound request the webview cannot
//! make on its own (software downloads, resolver manifest reads, GitHub /
//! F-Droid API calls) goes through a policy from here, and each policy is
//! enforced at THREE independent layers:
//!
//!   1. ADMISSION (`UrlPolicy::validate`) - the input string is parsed into a
//!      typed [`ValidatedUrl`] exactly once, before any side effect (no file
//!      is created, no task spawned, no client built until this passes).
//!      Malformed URLs, cleartext schemes, embedded credentials, private
//!      address literals and hosts the policy does not admit are rejected
//!      here with an understandable error instead of a panic.
//!
//!   2. REDIRECTS (`UrlPolicy::redirect_policy`) - reqwest clients built by
//!      [`http_client`] follow redirects only while every hop re-satisfies
//!      the scheme / credential / host rules of the policy. A HTTPS download
//!      can never be silently downgraded to HTTP, a resolver fetch can never
//!      be bounced off the vendor allowlist, and redirect loops are detected
//!      and refused instead of burning the hop budget quietly.
//!
//!   3. CONNECTIONS (`PublicOnlyResolver`) - the custom DNS resolver used by
//!      every policy-built client resolves the host and hands reqwest ONLY
//!      publicly routable addresses (IPv4 and IPv6). The address the socket
//!      actually connects to is therefore always constrained by this module's
//!      decision - a hostname that resolves solely to loopback / private /
//!      link-local (including cloud-metadata) space fails the request. This
//!      is also what makes the decision rebinding-resistant: reqwest calls
//!      the resolver for every connection (and every redirect hop), so a
//!      DNS-rebinding switcheroo between "validation" and "connection" has
//!      nothing to slip through - there is no separate unfiltered lookup.
//!
//! The six request classes have deliberately different rules; see
//! [`UrlPolicy::external_link`], [`UrlPolicy::api_github`],
//! [`UrlPolicy::api_fdroid`], [`UrlPolicy::resolver_manifest`],
//! [`UrlPolicy::self_update_feed`] and [`UrlPolicy::executable_download`]
//! for the reasoning behind each. The self-update feed class is also the
//! ONLY policy that may read the release's artifact-signature documents
//! (the `.sig` sidecars verified by `verify_self_update_signature`): they
//! are release assets like SHA256SUMS.txt, so they ride the same
//! three-host allowlist and per-hop checks (including the github.com
//! repo-path pin) rather than growing a new client.
//!
//! # Ports
//!
//! The scheme is the security boundary, not the port. `https` on ANY port
//! is admissible (vendors do serve downloads from non-default ports, e.g.
//! `https://mirror.example:8443/app.exe`), and `http` on ANY port -
//! including 443 - is refused. TLS semantics do not depend on the port
//! number, the connect-time public-address filter applies to every port
//! equally, and the resolver/API allowlists match by HOST, independent of
//! port. A future port restriction would have to be a conscious policy
//! change; tests pin the current decision.
//!
//! # Browser links are not a native request path
//!
//! `UrlPolicy::external_link` exists to give catalog links one shared
//! vocabulary; it never fetches. Opening a project/release link goes
//! through the Tauri opener plugin straight from the webview (scoped to
//! `https://**` in the capability manifest, owned by the bridge/packaging
//! owner), which hands the URL to the USER'S BROWSER - no native HTTP
//! client is built for it. The permissive `external_link` rules (private
//! literals allowed, any HTTPS host) therefore cannot become a native
//! fetch path that bypasses the strict policies: the only HTTP clients
//! that exist are the ones `http_client()` builds from the strict
//! policies, and every outbound call site in `lib.rs` constructs its
//! client through one of them.
//!
//! # Address literals skip DNS - by design
//!
//! reqwest/hyper resolve only hostnames; a URL whose host is an address
//! literal never consults [`PublicOnlyResolver`] (pinned by a test). The
//! literal therefore cannot lean on the connect-time filter - which is
//! why [`UrlPolicy::validate`] and every redirect hop
//! ([`evaluate_redirect_hop`]) parse and classify literals themselves.
//! Both halves of that split are load-bearing and tested.
//!
//! # Residual limitations (documented, not ignored)
//!
//! - **DNS answers are trusted for reachability, not for identity.** The
//!   public-address filter refuses answers that point into private space,
//!   but a resolver (or attacker on the resolver path) answering with a
//!   DIFFERENT public address cannot be detected at this layer; identity
//!   rests on TLS certificate validation and, for the API and manifest
//!   classes, on the exact host allowlists.
//! - **The download class is destination-host-agnostic by design** (see
//!   [`UrlPolicy::executable_download`]): any public HTTPS host may serve
//!   an installer. Trust in the FILE comes from publisher checksums and
//!   the transactional engine, not from the host name.
//! - **Address literals never reach the resolver** (see above), so their
//!   private-space guard lives entirely in admission and the per-hop
//!   check - both tested; a future reqwest that routed literals through
//!   the resolver would be caught by the regression test, not silently
//!   change behavior.
//! - **Redirect hops see literals only.** A hop to a HOSTNAME that
//!   resolves into private space passes the hop decision and is refused
//!   at connect time by [`PublicOnlyResolver`] instead - the refusal
//!   message is then a connect failure rather than the early, named
//!   redirect refusal. No path exists that connects to such a target.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Name, Resolve, Resolving};
use reqwest::redirect::{Attempt, Policy as RedirectPolicy};
use reqwest::Url;

/// User agent shared by every policy-built client (same format the native
/// layer has always used, now defined in one place).
pub fn user_agent() -> String {
    format!(
        "Fress/{} (+https://github.com/WasewaseX/Fress)",
        env!("CARGO_PKG_VERSION")
    )
}

/// Connect timeout shared by all policies (matches the previous behavior).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Whole-request timeout for the short-lived API / manifest clients (matches
/// the previous `api_client()`). Download clients deliberately have NONE -
/// `Client::timeout` covers the entire body stream and would kill large
/// installers; the download runner enforces its own 60s stall window instead.
const API_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Hosts the resolver-manifest policy may READ from (and be redirected to).
///
/// Every app in the catalog whose downloads do NOT live on GitHub resolves
/// through a small manifest or directory index on the project's own
/// infrastructure (KDE's mirror router, Tor's update manifests, Signal's
/// electron-updater feeds, Proton's version.json, ...). This list names
/// exactly those hosts, so the generic text fetch can never be turned into
/// an open proxy: anything not listed is refused before a request is made.
///
/// Redirect destinations are covered by the SAME list. This is justified by
/// observed vendor behavior (probed 2026-10): every resolver entry point in
/// `officialResolvers.ts` answers directly with zero redirects except
/// Zotero's `www.zotero.org/download/client/dl`, which redirects within the
/// allowlist to `download.zotero.org`. KDE's router redirects in-path on the
/// same host (`download.kde.org/stable/... -> download.kde.org/Attic/...`).
/// If a vendor ever bounces manifests to a NEW host, the fetch fails closed
/// and the fix is adding that exact host here - never loosening the scheme
/// or credential rules, and never weakening the webview CSP.
const RESOLVER_ALLOWED_HOSTS: &[&str] = &[
    "get.videolan.org",
    "www.videolan.org",
    "download.blender.org",
    "download.kde.org",
    "download.documentfoundation.org",
    "www.gimp.org",
    "download.gimp.org",
    "inkscape.org",
    "media.inkscape.org",
    "www.zotero.org",
    "download.zotero.org",
    "updates.signal.org",
    "aus1.torproject.org",
    "dist.torproject.org",
    "proton.me",
    "packages.element.io",
    "download.nextcloud.com",
    "gitlab.com",
    "www.sumatrapdfreader.org",
    "api.github.com",
    "raw.githubusercontent.com",
];

/// Why a URL was refused by [`UrlPolicy::validate`].
///
/// The `Display` messages are user-facing (they travel straight into
/// `Result<_, String>` of the Tauri commands), so they name the problem and
/// the remedy without leaking internal detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    /// The string is not a parseable URL at all.
    Malformed(String),
    /// The scheme is not HTTPS (http:, ftp:, file:, javascript:, ...).
    InsecureScheme { scheme: String },
    /// The URL carries no hostname (impossible for most special schemes, but
    /// defense in depth costs one line).
    MissingHost,
    /// The URL embeds a username and/or password. This also defeats
    /// look-alike tricks like `https://api.github.com@evil.example/`, where
    /// the "trusted" text is only the userinfo and the real host is evil.
    EmbeddedCredentials,
    /// The host is a loopback / private / link-local / otherwise
    /// non-routable address literal (IPv4 or IPv6), or names the local
    /// machine (`localhost`, `*.localhost`).
    PrivateAddress { host: String },
    /// The host is not admitted by this policy (resolver allowlist or
    /// pinned API host).
    DisallowedHost { host: String },
    /// The host is admitted, but the path does not match the document
    /// SHAPE the policy scopes it to (github.com release documents).
    DisallowedPath { host: String, path: String },
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PolicyError::Malformed(detail) => write!(f, "Not a valid URL: {detail}"),
            PolicyError::InsecureScheme { scheme } => {
                write!(f, "Only https URLs are allowed, not \"{scheme}\"")
            }
            PolicyError::MissingHost => write!(f, "URL has no host"),
            PolicyError::EmbeddedCredentials => {
                write!(f, "URL must not embed a username or password")
            }
            PolicyError::PrivateAddress { host } => {
                write!(f, "Refusing private or local address: {host}")
            }
            PolicyError::DisallowedHost { host } => {
                write!(f, "Host {host} is not on the resolver allowlist")
            }
            PolicyError::DisallowedPath { host, path } => {
                write!(f, "Path {path} is not a release document of {host}")
            }
        }
    }
}

/// A URL that has passed one policy's admission checks.
///
/// The newtype exists so downstream code cannot accidentally skip
/// validation: the only constructor is [`UrlPolicy::validate`], and callers
/// pass the validated object onward instead of re-parsing strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedUrl {
    url: Url,
}

impl ValidatedUrl {
    /// The underlying parsed URL (normalized by the WHATWG parser: scheme
    /// and host lowercased, default ports elided, path percent-encoded).
    pub fn raw(&self) -> &Url {
        &self.url
    }

    /// Wrap a raw URL WITHOUT admission. Test-only: the download engine's
    /// mock-server suite drives loopback http URLs, which no real policy
    /// would ever admit. Production code can only obtain a `ValidatedUrl`
    /// through [`UrlPolicy::validate`]; this constructor does not exist
    /// outside `cargo test` builds.
    #[cfg(test)]
    pub(crate) fn for_tests(raw: Url) -> Self {
        ValidatedUrl { url: raw }
    }

    /// The normalized serialization of the validated URL.
    pub fn as_str(&self) -> &str {
        self.url.as_str()
    }
}

/// What a redirect hop must satisfy to be followed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RedirectHostRule {
    /// Every hop must stay on the host the request started from (API
    /// requests: the URL was constructed locally from a validated input, so
    /// any host change is hostile or broken and nothing legitimate depends
    /// on following it).
    PinToOrigin,
    /// Every hop must be on the resolver allowlist (manifest fetches; see
    /// the probe evidence on [`RESOLVER_ALLOWED_HOSTS`]).
    Allowlist(&'static [&'static str]),
    /// Any HTTPS host may be followed (executable downloads: vendors
    /// legitimately bounce installers across CDNs and mirror pools - GitHub
    /// release assets land on release-assets.githubusercontent.com, KDE and
    /// VLC route through rotating mirrors - so an exact host allowlist would
    /// be unmaintainable and would break real downloads; safety comes from
    /// the HTTPS + credential + hop-budget checks plus the connect-time
    /// public-address resolver).
    AnyHttps,
}

/// A path pin re-checked on every redirect hop whose destination is the
/// pinned host. The command layer pins the self-update feed's github.com
/// path to this repository at admission; without the hop-side twin, a
/// redirect chain that re-enters `github.com` OUTSIDE the pinned path would
/// pass the host allowlist and return a document the admission pin refuses.
#[derive(Debug, Clone, Copy)]
struct PathPin {
    host: &'static str,
    /// Paths on `host` must start with this prefix...
    prefix: &'static str,
    /// ...or be exactly this (the bare repository root).
    bare: &'static str,
}

impl PathPin {
    fn admits(&self, url: &Url) -> bool {
        url.host_str().map(|h| h.to_ascii_lowercase()).as_deref() != Some(self.host)
            || url.path().starts_with(self.prefix)
            || url.path() == self.bare
    }
}

/// A path SHAPE re-checked at admission and on every redirect hop that
/// lands on the shape's host. Unlike [`PathPin`] (one fixed prefix), this
/// admits a FAMILY of paths with a validated segment structure - the
/// GitHub release documents of ANY repository:
///
///   - `/{owner}/{repo}/releases.atom`
///   - `/{owner}/{repo}/releases/tag/{tag}/expanded_assets` (the classic
///     per-tag fragment path)
///   - `/{owner}/{repo}/releases/expanded_assets/{tag}` (the fragment URL
///     GitHub's release pages lazy-load since the 2026-10 rollout - the
///     classic path began answering a page shell that references THIS URL
///     instead of carrying the anchors itself)
///
/// This is the load-bearing gate of the rate-limit-proof release-lookup
/// fallback: github.com is admitted ONLY for these release-document shapes,
/// so the generic resolver-manifest allowlist keeps its pinned invariant
/// (github.com stays off it - see the signature-document test in
/// `network_policy/tests.rs`) and nothing else on github.com - a checksum
/// document, a repository file, an arbitrary page - is readable through
/// this class. Segments are the URL's percent-encoded path segments,
/// validated against the charset GitHub itself uses for owner/repository
/// and percent-encoded tags; anything else fails closed.
#[derive(Debug, Clone, Copy)]
struct ReleasesDocShape {
    host: &'static str,
}

impl ReleasesDocShape {
    fn segment_ok(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 120
            && s != "."
            && s != ".."
            && s.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'~' | b'+' | b'%')
            })
    }

    fn admits(&self, url: &Url) -> bool {
        if url.host_str().map(|h| h.to_ascii_lowercase()).as_deref() != Some(self.host) {
            // The shape rule binds only its own host; other hosts (if a
            // policy ever combines them) are governed by their own rules.
            return true;
        }
        let segments: Vec<&str> = url.path().split('/').filter(|s| !s.is_empty()).collect();
        match segments.as_slice() {
            [owner, repo, "releases.atom"] => Self::segment_ok(owner) && Self::segment_ok(repo),
            [owner, repo, "releases", "tag", tag, "expanded_assets"] => {
                Self::segment_ok(owner) && Self::segment_ok(repo) && Self::segment_ok(tag)
            }
            [owner, repo, "releases", "expanded_assets", tag] => {
                Self::segment_ok(owner) && Self::segment_ok(repo) && Self::segment_ok(tag)
            }
            _ => false,
        }
    }
}

/// Per-redirect-hop rules plus the hop budget.
#[derive(Debug, Clone, Copy)]
struct RedirectRules {
    max_hops: usize,
    host_rule: RedirectHostRule,
    /// Refuse hops whose destination is a private/loopback/link-local
    /// address LITERAL (IPv4 or IPv6). Hostnames that merely resolve into
    /// private space are caught at connect time by [`PublicOnlyResolver`]
    /// regardless - this admission check exists so a redirect to e.g.
    /// `https://169.254.169.254/` fails with a precise reason at the hop
    /// decision instead of surfacing as a DNS/connect failure afterwards.
    block_private_literals: bool,
    /// When set, every hop landing on the pinned host must stay inside the
    /// pinned path (mirrors an admission-time pin that lives in the command
    /// layer). `None` for every policy that has no path-scoped admission.
    path_pin: Option<PathPin>,
    /// When set, every hop landing on the shape's host must match the
    /// documented path SHAPE (mirrors the admission-time shape rule).
    /// `None` for every policy without a shape-scoped admission.
    path_shape: Option<ReleasesDocShape>,
}

/// The request classes Fress's native layer makes, each with its own rules.
#[derive(Debug, Clone, Copy)]
pub struct UrlPolicy {
    label: &'static str,
    admission: AdmissionRule,
    redirects: RedirectRules,
    /// Refuse loopback/private/link-local address literals and local
    /// hostnames at admission time (clear early error). Hostnames that
    /// merely RESOLVE to such addresses are caught at connect time by
    /// [`PublicOnlyResolver`] regardless of this flag.
    block_private_addrs: bool,
    /// `None` = no whole-request timeout (downloads).
    request_timeout: Option<Duration>,
}

impl UrlPolicy {
    /// Human-readable request-class label ("executable-download",
    /// "resolver-manifest", ...), usable for diagnostics and logs.
    pub fn label(&self) -> &'static str {
        self.label
    }

    /// Ordinary external links (catalog `websiteUrl`, `githubUrl`, release
    /// pages...). These are opened in the USER'S BROWSER via the opener
    /// plugin, not fetched by native code; the policy exists so any future
    /// native path that touches a link uses the same vocabulary.
    ///
    /// HTTPS is required because every catalog and vendor page link is
    /// HTTPS today; a browser context additionally gets HSTS/upgrade
    /// semantics for free. Private-network addresses are NOT restricted:
    /// a person pasting `http://localhost:3000` as their project's website
    /// link is not a network attack surface in a browser context.
    pub fn external_link() -> Self {
        UrlPolicy {
            label: "external-link",
            admission: AdmissionRule::AnyHttps,
            redirects: RedirectRules {
                max_hops: 5,
                host_rule: RedirectHostRule::AnyHttps,
                block_private_literals: false,
                path_pin: None,
                path_shape: None,
            },
            block_private_addrs: false,
            request_timeout: Some(API_REQUEST_TIMEOUT),
        }
    }

    /// GitHub REST API requests (`fetch_latest_release`,
    /// `fetch_recent_releases`, Inkscape's winget manifest lookup). The URL
    /// is constructed locally from a caller-supplied repo slug, so the ONLY
    /// thing that can go wrong is the slug steering the path elsewhere -
    /// pinning the host to `api.github.com` makes even a hostile slug
    /// unable to move the request off GitHub's API.
    pub fn api_github() -> Self {
        UrlPolicy {
            label: "api-github",
            admission: AdmissionRule::Exact("api.github.com"),
            redirects: RedirectRules {
                max_hops: 3,
                host_rule: RedirectHostRule::PinToOrigin,
                block_private_literals: true,
                path_pin: None,
                path_shape: None,
            },
            block_private_addrs: true,
            request_timeout: Some(API_REQUEST_TIMEOUT),
        }
    }

    /// F-Droid API requests (`fetch_fdroid_package`). Same construction
    /// pattern as [`Self::api_github`], pinned to `f-droid.org`. Exact
    /// comparison defeats suffix look-alikes like `f-droid.org.evil.example`.
    pub fn api_fdroid() -> Self {
        UrlPolicy {
            label: "api-fdroid",
            admission: AdmissionRule::Exact("f-droid.org"),
            redirects: RedirectRules {
                max_hops: 3,
                host_rule: RedirectHostRule::PinToOrigin,
                block_private_literals: true,
                path_pin: None,
                path_shape: None,
            },
            block_private_addrs: true,
            request_timeout: Some(API_REQUEST_TIMEOUT),
        }
    }

    /// GitHub's own quota-free release documents (`fetch_github_release_doc`):
    /// the `releases.atom` feed and the per-tag `expanded_assets` fragments
    /// the rate-limit-proof release-lookup fallback reads when the REST API
    /// fails. A dedicated request class - NOT a widening of the
    /// resolver-manifest allowlist - because the pinned audit invariant
    /// "github.com stays off the generic resolver-manifest policy" is what
    /// keeps the self-update checksum document unreachable through any
    /// generic text fetch. Here github.com is admitted for exactly the two
    /// document shapes above (every redirect hop re-checked), with the
    /// standard scheme/credential/private-address rules unchanged.
    pub fn github_releases_doc() -> Self {
        UrlPolicy {
            label: "github-releases-doc",
            admission: AdmissionRule::Exact("github.com"),
            redirects: RedirectRules {
                max_hops: 3,
                host_rule: RedirectHostRule::PinToOrigin,
                block_private_literals: true,
                path_pin: None,
                path_shape: Some(ReleasesDocShape { host: "github.com" }),
            },
            block_private_addrs: true,
            request_timeout: Some(API_REQUEST_TIMEOUT),
        }
    }

    /// Resolver manifest / directory-index reads (`fetch_text`). The first
    /// request AND every redirect hop must land on the vendor allowlist -
    /// probe evidence for why that is safe to enforce per-hop lives on
    /// [`RESOLVER_ALLOWED_HOSTS`]. Response bodies are additionally capped
    /// by the caller (2 MiB) before they reach the webview.
    pub fn resolver_manifest() -> Self {
        UrlPolicy {
            label: "resolver-manifest",
            admission: AdmissionRule::Allowlist(RESOLVER_ALLOWED_HOSTS),
            redirects: RedirectRules {
                max_hops: 5,
                host_rule: RedirectHostRule::Allowlist(RESOLVER_ALLOWED_HOSTS),
                block_private_literals: true,
                path_pin: None,
                path_shape: None,
            },
            block_private_addrs: true,
            request_timeout: Some(API_REQUEST_TIMEOUT),
        }
    }

    /// Self-update feed reads (`fetch_self_update_text`): the Fress
    /// releases.atom fallback and the release's `SHA256SUMS.txt` checksum
    /// file. These are github.com pages that do NOT answer CORS, so the
    /// WebView cannot read them (the CSP `connect-src` entry was never the
    /// blocking layer) and the reads are routed through this native command
    /// instead.
    ///
    /// The allowlist is exactly the three GitHub-owned hosts the feed can
    /// touch: the request starts on `github.com` and the release-asset
    /// redirect lands on `release-assets.githubusercontent.com`
    /// (`objects.githubusercontent.com` is the older asset host, kept so a
    /// historic manifest shape cannot fail closed into an unverified
    /// update). Every hop is re-checked against the same three hosts, so the
    /// fetch can never be bounced anywhere else. Request bodies are capped
    /// by the caller (2 MiB, like `fetch_text`).
    ///
    /// The github.com PATH is pinned to this repository - at admission by
    /// the command (`lib.rs`), and on every hop by the [`PathPin`] below, so
    /// even a redirect chain that leaves and re-enters `github.com` outside
    /// `/WasewaseX/Fress/` is refused. Asset-CDN hosts keep opaque token
    /// paths, so the pin binds the `github.com` origin only. As with every
    /// policy, the port is not part of the host decision (see the module
    /// "Ports" note): a pinned-path hop on github.com:8443 is admitted by
    /// the pin and by the allowlist - TLS, not the port, pins identity.
    pub fn self_update_feed() -> Self {
        const SELF_UPDATE_ALLOWED_HOSTS: &[&str] = &[
            "github.com",
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
        ];
        UrlPolicy {
            label: "self-update-feed",
            admission: AdmissionRule::Allowlist(SELF_UPDATE_ALLOWED_HOSTS),
            redirects: RedirectRules {
                max_hops: 3,
                host_rule: RedirectHostRule::Allowlist(SELF_UPDATE_ALLOWED_HOSTS),
                // Integration fix (orchestrator): Agent 3's redirect-literal
                // guard (PR #16) made this field load-bearing on every
                // policy. The self-update feed is a strict allowlist class,
                // so a redirect to a private/LITERAL destination is named
                // and refused here exactly like the other strict classes;
                // hostname hops stay guarded by the allowlist plus the
                // connect-time resolver.
                block_private_literals: true,
                // The command layer pins the github.com path at admission;
                // the hop-side twin keeps a redirect that re-enters
                // github.com outside the repository from slipping past the
                // host allowlist (N-3, native-integrity audit 2026-10).
                path_pin: Some(PathPin {
                    host: "github.com",
                    prefix: "/WasewaseX/Fress/",
                    bare: "/WasewaseX/Fress",
                }),
                path_shape: None,
            },
            block_private_addrs: true,
            request_timeout: Some(API_REQUEST_TIMEOUT),
        }
    }

    /// Executable / installer downloads (`start_download` -> `run_download`).
    ///
    /// HTTPS is mandatory (the payload is code the user will run), but the
    /// destination host is deliberately NOT allowlisted: the catalog
    /// legitimately downloads from dozens of vendor domains and rotating
    /// mirror/CDN hosts. Trust in the FILE comes from the existing layers
    /// (publisher checksum verification, staging+rename, Content-Length
    /// accounting); trust in the TRANSPORT comes from this policy (HTTPS,
    /// no credentials, hop budget, public-address-only connections).
    pub fn executable_download() -> Self {
        UrlPolicy {
            label: "executable-download",
            admission: AdmissionRule::AnyHttps,
            redirects: RedirectRules {
                max_hops: 8,
                host_rule: RedirectHostRule::AnyHttps,
                block_private_literals: true,
                path_pin: None,
                path_shape: None,
            },
            block_private_addrs: true,
            request_timeout: None,
        }
    }

    /// Parse and admit `raw` under this policy, or explain why it is
    /// refused. Never panics: every failure mode of the WHATWG parser is a
    /// returned error.
    pub fn validate(&self, raw: &str) -> Result<ValidatedUrl, PolicyError> {
        let url = Url::parse(raw).map_err(|e| PolicyError::Malformed(e.to_string()))?;

        // Downloads are code the user will execute; manifests and API calls
        // feed the URLs users will execute. Cleartext is refused everywhere.
        if url.scheme() != "https" {
            return Err(PolicyError::InsecureScheme {
                scheme: url.scheme().to_string(),
            });
        }

        let host = url
            .host_str()
            .filter(|h| !h.is_empty())
            .ok_or(PolicyError::MissingHost)?
            .to_ascii_lowercase();

        // A userinfo component means the "host" the user reads may only be
        // the username. Refuse outright - nothing legitimate in the catalog
        // needs basic auth, and the credential trick is the classic way to
        // make a hostile host LOOK like a trusted one.
        if !url.username().is_empty() || url.password().is_some() {
            return Err(PolicyError::EmbeddedCredentials);
        }

        // Admission per policy class. URL hosts are already normalized to
        // lowercase (and to punycode for IDN), so exact comparison is safe.
        match self.admission {
            AdmissionRule::Exact(pinned) => {
                if host != pinned {
                    return Err(PolicyError::DisallowedHost { host });
                }
            }
            AdmissionRule::Allowlist(list) => {
                if !list.contains(&host.as_str()) {
                    return Err(PolicyError::DisallowedHost { host });
                }
            }
            AdmissionRule::AnyHttps => {}
        }

        // Early, precise rejection of address literals that name this
        // machine or private networks. Hostnames that merely RESOLVE to
        // such addresses are caught later, at connection time, by
        // `PublicOnlyResolver` - the early check here exists so a user
        // pasting `http://127.0.0.1:9000/setup.exe` gets one clear error
        // instead of a DNS/connect failure.
        if self.block_private_addrs {
            if let Ok(ip) = host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
            {
                if !is_publicly_routable(ip) {
                    return Err(PolicyError::PrivateAddress { host });
                }
            } else if is_local_hostname(&host) {
                return Err(PolicyError::PrivateAddress { host });
            }
        }

        // Path-shape admission: when a policy scopes its host to a
        // document SHAPE (github.com release documents), a well-formed
        // host on a shape-violating path is refused here, before any
        // client exists - the hop-side twin keeps redirect chains to the
        // same contract.
        if let Some(shape) = self.redirects.path_shape {
            if !shape.admits(&url) {
                return Err(PolicyError::DisallowedPath {
                    host: host.clone(),
                    path: url.path().to_string(),
                });
            }
        }

        Ok(ValidatedUrl { url })
    }

    /// The reqwest redirect policy for this request class. Each hop is
    /// evaluated by [`evaluate_redirect_hop`] (pure, unit-tested); the
    /// closure only maps the decision onto reqwest's follow/error actions.
    pub fn redirect_policy(&self) -> RedirectPolicy {
        let rules = self.redirects;
        RedirectPolicy::custom(move |attempt: Attempt| {
            match evaluate_redirect_hop(&rules, attempt.previous(), attempt.url()) {
                Ok(()) => attempt.follow(),
                Err(reason) => attempt.error(reason.to_message()),
            }
        })
    }

    /// A reqwest client enforcing this policy end to end: shared user
    /// agent, connect timeout, redirect policy, and the public-address-only
    /// DNS resolver that constrains what the socket actually connects to.
    pub fn http_client(&self) -> Result<reqwest::Client, String> {
        self.http_client_with_resolver(PublicOnlyResolver::default())
    }

    /// Same client with an explicit resolver (test injection point).
    fn http_client_with_resolver(
        &self,
        resolver: PublicOnlyResolver,
    ) -> Result<reqwest::Client, String> {
        let mut builder = reqwest::Client::builder()
            .user_agent(user_agent())
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(self.redirect_policy())
            .dns_resolver(Arc::new(resolver));
        if let Some(timeout) = self.request_timeout {
            builder = builder.timeout(timeout);
        }
        builder.build().map_err(|e| e.to_string())
    }
}

/// Evaluate ONE redirect hop against the policy rules.
///
/// Kept pure (no reqwest types in the decision) so the full rule set is
/// unit-testable without a network: `previous` is the chain of URLs already
/// visited (original first), `next` is the hop being decided.
fn evaluate_redirect_hop(
    rules: &RedirectRules,
    previous: &[Url],
    next: &Url,
) -> Result<(), RedirectRejection> {
    // Hop budget. reqwest would eventually stop counting too, but an
    // explicit check keeps the message understandable and the limit under
    // this module's control.
    if previous.len() >= rules.max_hops {
        return Err(RedirectRejection::TooManyHops {
            limit: rules.max_hops,
        });
    }

    // HTTPS on every hop. A https -> http downgrade is the classic
    // redirect-chain attack on a downloader; nothing legitimate in the
    // catalog needs it.
    if next.scheme() != "https" {
        return Err(RedirectRejection::InsecureScheme {
            scheme: next.scheme().to_string(),
        });
    }

    // Credentials on a hop are the same look-alike trick as at admission.
    if !next.username().is_empty() || next.password().is_some() {
        return Err(RedirectRejection::EmbeddedCredentials);
    }

    // Explicit loop detection: if the next hop was already visited, the
    // chain is cycling. Refusing immediately explains the failure instead
    // of masking it as "too many redirects" after burning the budget.
    if previous.iter().any(|visited| visited == next) {
        return Err(RedirectRejection::Loop);
    }

    // Private/local address literals are refused as redirect destinations
    // for the policies that refuse them at admission. The connect-time
    // resolver would refuse the CONNECTION anyway (the literal parses to
    // exactly one address), so this is early-and-precise rather than the
    // only line of defense - but a hop to e.g. the cloud metadata address
    // deserves its own named reason.
    if rules.block_private_literals {
        if let Some(host) = next.host_str() {
            if let Ok(ip) = host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
            {
                if !is_publicly_routable(ip) {
                    return Err(RedirectRejection::PrivateDestination {
                        host: host.to_string(),
                    });
                }
            }
        }
    }

    // Destination-host rule for this request class.
    match rules.host_rule {
        RedirectHostRule::PinToOrigin => {
            let origin = previous
                .first()
                .and_then(|u| u.host_str())
                .unwrap_or_default();
            if next.host_str().map(|h| h.to_ascii_lowercase()).as_deref() != Some(origin) {
                return Err(RedirectRejection::HostMismatch {
                    host: next.host_str().unwrap_or("").to_string(),
                });
            }
        }
        RedirectHostRule::Allowlist(list) => {
            let host = next.host_str().unwrap_or("").to_ascii_lowercase();
            if !list.contains(&host.as_str()) {
                return Err(RedirectRejection::LeftAllowlist { host });
            }
        }
        RedirectHostRule::AnyHttps => {}
    }

    // Path pin for the policies that scope one host to one path: the host
    // allowlist alone would let a redirect chain leave the pinned path and
    // re-enter the same host somewhere else (see [`PathPin`]).
    if let Some(pin) = rules.path_pin {
        if !pin.admits(next) {
            return Err(RedirectRejection::OffPinnedPath {
                host: next.host_str().unwrap_or("").to_string(),
                path: next.path().to_string(),
            });
        }
    }

    // Path-shape twin for the policies that scope one host to a document
    // SHAPE (see [`ReleasesDocShape`]): same contract as the admission
    // check, applied to every hop.
    if let Some(shape) = rules.path_shape {
        if !shape.admits(next) {
            return Err(RedirectRejection::OffDocumentShape {
                host: next.host_str().unwrap_or("").to_string(),
                path: next.path().to_string(),
            });
        }
    }

    Ok(())
}

/// Host admission rule for the FIRST request of a policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AdmissionRule {
    /// Exactly this host, byte-exact after URL normalization (pinned API
    /// hosts - defeats suffix/prefix look-alikes).
    Exact(&'static str),
    /// Any host on the resolver allowlist.
    Allowlist(&'static [&'static str]),
    /// Any host, as long as the rest of the policy holds (downloads:
    /// vendors legitimately use dozens of domains and rotating mirrors).
    AnyHttps,
}

/// Why a redirect hop was refused. Static, comparable messages keep the
/// decisions testable and the client-side errors understandable.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RedirectRejection {
    TooManyHops { limit: usize },
    InsecureScheme { scheme: String },
    EmbeddedCredentials,
    Loop,
    HostMismatch { host: String },
    LeftAllowlist { host: String },
    PrivateDestination { host: String },
    OffPinnedPath { host: String, path: String },
    OffDocumentShape { host: String, path: String },
}

impl RedirectRejection {
    fn to_message(&self) -> String {
        match self {
            RedirectRejection::TooManyHops { limit } => {
                format!("too many redirects (more than {limit})")
            }
            RedirectRejection::InsecureScheme { scheme } => {
                format!("redirect downgraded to non-https scheme \"{scheme}\"")
            }
            RedirectRejection::EmbeddedCredentials => {
                "redirect URL embeds a username or password".to_string()
            }
            RedirectRejection::Loop => "redirect loop detected".to_string(),
            RedirectRejection::HostMismatch { host } => {
                format!("redirect left the pinned API host (landed on {host})")
            }
            RedirectRejection::LeftAllowlist { host } => {
                format!("Host {host} is not on the resolver allowlist")
            }
            RedirectRejection::PrivateDestination { host } => {
                format!("Redirect to a private or local address ({host}) is not allowed")
            }
            RedirectRejection::OffPinnedPath { host, path } => {
                format!("Redirect left the pinned repository path on {host} ({path})")
            }
            RedirectRejection::OffDocumentShape { host, path } => {
                format!("Redirect left the release-document path shape on {host} ({path})")
            }
        }
    }
}

/// True when `host` names the local machine. The IP-literal forms are
/// handled by the routability check; this covers the conventional names.
fn is_local_hostname(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost")
}

/// True when `ip` is a globally routable unicast address a download or
/// manifest fetch is allowed to connect to.
///
/// This is the connect-time enforcement point: [`PublicOnlyResolver`] feeds
/// reqwest ONLY addresses that pass here, so the address the socket binds
/// to is always one of this module's validated decisions. IPv4 and IPv6 are
/// both covered, including the translation families that can smuggle an
/// IPv4 destination inside an IPv6 literal.
pub fn is_publicly_routable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_publicly_routable_v4(v4),
        IpAddr::V6(v6) => is_publicly_routable_v6(v6),
    }
}

fn is_publicly_routable_v4(ip: std::net::Ipv4Addr) -> bool {
    let b = ip.octets();
    !matches!(b[0], 0 | 10 | 127) // this-network, private, loopback
        && !(b[0] == 100 && (64..=127).contains(&b[1])) // 100.64/10 CGNAT
        && !(b[0] == 169 && b[1] == 254) // 169.254/16 link-local (+ cloud metadata)
        && !(b[0] == 172 && (16..=31).contains(&b[1])) // 172.16/12 private
        && !(b[0] == 192 && b[1] == 0 && b[2] == 0) // 192.0.0.0/24 IETF protocol assignments
        && !(b[0] == 192 && b[1] == 0 && b[2] == 2) // 192.0.2.0/24 TEST-NET-1
        && !(b[0] == 192 && b[1] == 88 && b[2] == 99) // 192.88.99.0/24 deprecated 6to4 relay
        && !(b[0] == 192 && b[1] == 168) // 192.168/16 private
        && !(b[0] == 198 && b[1] == 18) // 198.18/15 benchmarking (b[1] 18 or 19)
        && !(b[0] == 198 && b[1] == 19)
        && !(b[0] == 198 && b[1] == 51 && b[2] == 100) // 198.51.100.0/24 TEST-NET-2
        && !(b[0] == 203 && b[1] == 0 && b[2] == 113) // 203.0.113.0/24 TEST-NET-3
        && b[0] < 224 // multicast 224/4, reserved 240/4, broadcast 255.255.255.255
}

fn is_publicly_routable_v6(ip: std::net::Ipv6Addr) -> bool {
    let s = ip.segments();
    // Globally routable unicast lives in 2000::/3. Every other top-level
    // block is special-purpose: 0::/8 holds the unspecified/loopback
    // addresses and the TRANSLATION families (::/96 IPv4-compatible,
    // ::ffff:0:0/96 IPv4-mapped, 64:ff9b::/96 + 64:ff9b:1::/48 NAT64) whose
    // effective destination is an IPv4 address this module never evaluated;
    // 100::/8 is discard-only/reserved; 200::/7, 400::/6, 800::/5 and
    // 1000::/4 are reserved by the IETF; fc00::/7 is unique-local;
    // fe80::/10 is link-local; ff00::/8 is multicast. One gate refuses all
    // of it - a TCP destination must be NATIVE global unicast.
    s[0] & 0xe000 == 0x2000
        // Inside 2000::/3, the IANA special-purpose assignments are refused
        // explicitly (IANA IPv6 Special-Purpose Address Registry, RFC 6890
        // and successors, as of 2026-10):
        && !(s[0] == 0x2001 && (s[1] & 0xfe00) == 0) // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID + ORCHIDv2, AS112, ...)
        && !(s[0] == 0x2001 && s[1] == 0x0db8) // 2001:db8::/32 documentation
        && !(s[0] == 0x2002) // 2002::/16 6to4 (decommissioned RFC 7526; embedded IPv4 never evaluated)
        && !(s[0] == 0x3ffe) // 3ffe::/16 former 6bone (returned to IANA)
        && !(s[0] == 0x3fff && (s[1] & 0xf000) == 0) // 3fff::/20 documentation (RFC 9637): top 4 bits of s[1] complete the /20 prefix
        && !(s[0] == 0x5f00) // 5f00::/16 SRv6 segment-routing SIDs
}

/// Filter a resolved address set down to publicly routable addresses.
/// Returns an error when NOTHING public is left, so the caller fails the
/// request instead of silently connecting to a private address.
fn filter_public_addrs<I>(addrs: I, host: &str) -> Result<Vec<SocketAddr>, String>
where
    I: Iterator<Item = SocketAddr>,
{
    let public: Vec<SocketAddr> = addrs.filter(|a| is_publicly_routable(a.ip())).collect();
    if public.is_empty() {
        return Err(format!(
            "Host {host} only resolves to private or local network addresses; refusing to connect"
        ));
    }
    Ok(public)
}

/// DNS resolver handed to reqwest: resolve normally, then connect ONLY to
/// publicly routable addresses.
///
/// This is what makes the private-network decision authoritative rather
/// than advisory: reqwest asks THIS resolver for every connection attempt
/// (initial request, each redirect hop, and every automatic re-connect),
/// so a hostname that re-resolves into private space mid-session - DNS
/// rebinding - is re-filtered at exactly the moment it would be used. There
/// is no separate "validated earlier" address set to drift away from; the
/// validation and the connection share this single code path, and no
/// resolved address is ever cached between attempts.
///
/// The lookup function is injectable so the test suite can script DNS
/// answer sets (mixed public/private, re-resolve flips, lookup failures)
/// deterministically without any network; production builds use the
/// system resolver through `tokio::net::lookup_host`.
#[derive(Clone, Default)]
struct PublicOnlyResolver {
    /// `None` = production system resolver. `Some` = scripted lookup for
    /// tests. The shape (host -> future of SocketAddr list or reason) is
    /// the same either way; only the source of the answer differs.
    lookup: Option<ScriptedLookup>,
}

/// The injectable lookup: host -> future of the resolved SocketAddr set
/// (or a failure reason). Test-only construction.
type LookupFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<SocketAddr>, String>> + Send>>;
#[derive(Clone)]
struct ScriptedLookup(Arc<dyn Fn(String) -> LookupFuture + Send + Sync>);

impl PublicOnlyResolver {
    /// A resolver driven by a scripted lookup (unit tests only).
    #[cfg(test)]
    fn scripted<F>(f: F) -> Self
    where
        F: Fn(String) -> LookupFuture + Send + Sync + 'static,
    {
        PublicOnlyResolver {
            lookup: Some(ScriptedLookup(Arc::new(f))),
        }
    }
}

impl Resolve for PublicOnlyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let lookup = self.lookup.clone();
        Box::pin(async move {
            // Port 0 is a placeholder; hyper combines the resolved IP with
            // the URL's port when it opens the socket.
            let looked_up: Vec<SocketAddr> = match lookup {
                Some(scripted) => scripted.0(host.clone()).await?,
                None => tokio::net::lookup_host((host.as_str(), 0))
                    .await
                    .map_err(|e| format!("DNS lookup failed for {host}: {e}"))?
                    .collect(),
            };
            let public = filter_public_addrs(looked_up.into_iter(), &host)?;
            Ok(Box::new(public.into_iter()) as Box<dyn Iterator<Item = SocketAddr> + Send>)
        })
    }
}

/// Render a reqwest send error for user-facing command results, naming
/// redirect-policy refusals for what they are instead of a generic
/// connection failure.
pub fn describe_network_error(e: &reqwest::Error) -> String {
    if e.is_redirect() {
        format!("Network error: insecure redirect refused ({e})")
    } else {
        format!("Network error: {e}")
    }
}

/// Same as [`describe_network_error`] with the download runner's wording.
pub fn describe_download_error(e: &reqwest::Error) -> String {
    if e.is_redirect() {
        format!("Insecure redirect blocked: {e}")
    } else {
        format!("Connection failed: {e}")
    }
}

#[cfg(test)]
mod tests;
