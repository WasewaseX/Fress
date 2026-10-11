// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT

//! Regression tests for the network policy: URL admission per request
//! class, redirect-hop decisions (downgrades, credentials, loops, hop
//! budgets, host rules), and the connect-time public-address filter.
//! No test touches the live network.

use super::*;

// ---------------------------------------------------------------------------
// Admission: executable downloads
// ---------------------------------------------------------------------------

#[test]
fn accepts_a_valid_https_download_url() {
    let url = UrlPolicy::executable_download()
        .validate("https://example.com/downloads/app-1.2.3-setup.exe")
        .expect("plain https URL must validate");
    assert_eq!(url.raw().scheme(), "https");
    assert_eq!(url.raw().host_str(), Some("example.com"));
}

#[test]
fn accepts_https_with_query_fragment_and_port_443() {
    // Default ports are normalized away by the WHATWG parser; query and
    // fragment are harmless and must survive.
    let url = UrlPolicy::executable_download()
        .validate("https://example.com:443/dl/x.exe?mirror=eu#sha256")
        .expect("https URL with query/fragment must validate");
    assert!(url.as_str().contains("/dl/x.exe?mirror=eu"));
}

#[test]
fn normalizes_scheme_and_host_case() {
    let url = UrlPolicy::executable_download()
        .validate("HTTPS://EXAMPLE.COM/Setup.EXE")
        .expect("case-insensitive scheme/host must validate");
    assert_eq!(url.as_str(), "https://example.com/Setup.EXE");
}

#[test]
fn accepts_public_ip_literal_downloads() {
    for raw in [
        "https://1.1.1.1/file.bin",
        "https://[2606:4700:4700::1111]/file.bin",
    ] {
        UrlPolicy::executable_download()
            .validate(raw)
            .unwrap_or_else(|e| panic!("{raw} must validate: {e}"));
    }
}

#[test]
fn rejects_http_downloads() {
    let err = UrlPolicy::executable_download()
        .validate("http://example.com/setup.exe")
        .expect_err("http must be refused for downloads");
    assert_eq!(
        err,
        PolicyError::InsecureScheme {
            scheme: "http".to_string()
        }
    );
}

#[test]
fn rejects_non_https_schemes() {
    for raw in [
        "ftp://example.com/setup.exe",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hi",
    ] {
        let err = UrlPolicy::executable_download()
            .validate(raw)
            .err()
            .unwrap_or_else(|| panic!("{raw} must be refused"));
        assert_eq!(
            err,
            PolicyError::InsecureScheme {
                scheme: raw.split(':').next().unwrap_or("").to_string()
            },
            "{raw}"
        );
    }
}

#[test]
fn rejects_malformed_urls_without_panicking() {
    for raw in [
        "",
        "   ",
        "notaurl",
        "https://",
        "https://exa mple.com/x",
        "https://[not-an-ip]/x",
        "https://example.com:port/x",
        "https://exa\u{0}mple.com/x",
        "%https://example.com",
        "https://example.com:99999999999999999999/",
    ] {
        let result = UrlPolicy::executable_download().validate(raw);
        assert!(result.is_err(), "\"{raw}\" must be refused");
    }
}

#[test]
fn whatwg_parser_leniency_is_understood_not_accidental() {
    // The WHATWG parser tolerates extra slashes: "https:///path" parses
    // with host "path" (a single-label hostname), so it is NOT malformed.
    // It still goes through every other rule; whether such a host resolves
    // at all is then decided by DNS, and whatever it resolves to is
    // filtered by the public-address-only resolver at connect time.
    let url = UrlPolicy::executable_download()
        .validate("https:///path")
        .expect("WHATWG parser accepts extra slashes");
    assert_eq!(url.raw().host_str(), Some("path"));
}

#[test]
fn rejects_urls_with_embedded_credentials() {
    for raw in [
        "https://user:pass@example.com/setup.exe",
        "https://user@example.com/setup.exe",
        "https://:pass@example.com/setup.exe",
        "https://user:pass@example.com@real.example/setup.exe",
    ] {
        assert_eq!(
            UrlPolicy::executable_download().validate(raw).err(),
            Some(PolicyError::EmbeddedCredentials),
            "{raw}"
        );
    }
}

#[test]
fn credential_trick_looking_like_a_trusted_host_is_refused() {
    // The classic look-alike: everything before the @ is USERINFO; the real
    // host is real.example. The credential rule catches it.
    assert_eq!(
        UrlPolicy::api_github()
            .validate("https://api.github.com@evil.example/repos/x/releases/latest")
            .err(),
        Some(PolicyError::EmbeddedCredentials),
    );
}

#[test]
fn rejects_private_address_literal_downloads() {
    for raw in [
        "https://127.0.0.1/setup.exe",
        "https://[::1]/setup.exe",
        "https://10.1.2.3/setup.exe",
        "https://172.16.0.5/setup.exe",
        "https://172.31.255.255/setup.exe",
        "https://192.168.1.10/setup.exe",
        "https://169.254.169.254/latest/meta-data/",
        "https://100.64.0.1/setup.exe",
        "https://0.0.0.0/setup.exe",
        "https://255.255.255.255/setup.exe",
        "https://224.0.0.1/setup.exe",
        "https://[fe80::1]/setup.exe",
        "https://[fc00::1]/setup.exe",
        "https://[fd12:3456::1]/setup.exe",
        "https://[::ffff:127.0.0.1]/setup.exe",
        "https://[::ffff:10.0.0.1]/setup.exe",
        "https://[64:ff9b::1.2.3.4]/setup.exe",
        "https://[2001:db8::1]/setup.exe",
    ] {
        assert!(
            matches!(
                UrlPolicy::executable_download().validate(raw),
                Err(PolicyError::PrivateAddress { .. })
            ),
            "{raw} must be refused as a private/local address literal"
        );
    }
}

#[test]
fn rejects_localhost_hostnames() {
    for raw in [
        "https://localhost/setup.exe",
        "https://LOCALHOST/setup.exe",
        "https://sub.localhost/setup.exe",
    ] {
        assert!(
            matches!(
                UrlPolicy::executable_download().validate(raw),
                Err(PolicyError::PrivateAddress { .. })
            ),
            "{raw}"
        );
    }
}

// ---------------------------------------------------------------------------
// Admission: resolver manifests
// ---------------------------------------------------------------------------

#[test]
fn resolver_accepts_allowlisted_hosts() {
    for raw in [
        "https://download.kde.org/stable/krita/",
        "https://www.zotero.org/download/client/dl?channel=release&platform=win-x64",
        "https://updates.signal.org/desktop/latest.yml",
        "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/i/Inkscape/Inkscape",
    ] {
        UrlPolicy::resolver_manifest()
            .validate(raw)
            .unwrap_or_else(|e| panic!("{raw} must validate: {e}"));
    }
}

#[test]
fn resolver_rejects_unlisted_hosts() {
    assert_eq!(
        UrlPolicy::resolver_manifest()
            .validate("https://example.com/manifest.json")
            .err(),
        Some(PolicyError::DisallowedHost {
            host: "example.com".to_string()
        })
    );
    // Suffix and prefix look-alikes are NOT the allowlisted host.
    for raw in [
        "https://evil-download.kde.org/x",
        "https://download.kde.org.evil.example/x",
    ] {
        assert!(
            matches!(
                UrlPolicy::resolver_manifest().validate(raw),
                Err(PolicyError::DisallowedHost { .. })
            ),
            "{raw}"
        );
    }
}

#[test]
fn resolver_rejects_http_and_credentials_even_on_allowlisted_hosts() {
    assert!(UrlPolicy::resolver_manifest()
        .validate("http://download.kde.org/stable/krita/")
        .is_err());
    assert_eq!(
        UrlPolicy::resolver_manifest()
            .validate("https://user:pass@download.kde.org/stable/krita/")
            .err(),
        Some(PolicyError::EmbeddedCredentials)
    );
}

// ---------------------------------------------------------------------------
// Admission: pinned API hosts
// ---------------------------------------------------------------------------

#[test]
fn github_api_is_pinned_to_api_github_com() {
    UrlPolicy::api_github()
        .validate("https://api.github.com/repos/WasewaseX/Fress/releases/latest")
        .expect("api.github.com must validate");
    // The plain website host is not the API host; the slug cannot steer the
    // request off the API endpoint.
    assert!(UrlPolicy::api_github()
        .validate("https://github.com/WasewaseX/Fress/releases/latest")
        .is_err());
}

#[test]
fn fdroid_api_is_pinned_with_exact_match() {
    UrlPolicy::api_fdroid()
        .validate("https://f-droid.org/api/v1/packages/org.videolan.vlc")
        .expect("f-droid.org must validate");
    for lookalike in [
        "https://f-droid.org.evil.example/api/v1/packages/x",
        "https://api-f-droid.org/api/v1/packages/x",
    ] {
        assert!(
            UrlPolicy::api_fdroid().validate(lookalike).is_err(),
            "{lookalike}"
        );
    }
}

// ---------------------------------------------------------------------------
// Redirect decisions
// ---------------------------------------------------------------------------

fn hop_result(
    max_hops: usize,
    host_rule: RedirectHostRule,
    previous: &[&str],
    next: &str,
) -> Result<(), RedirectRejection> {
    hop_result_flagged(max_hops, host_rule, true, previous, next)
}

/// Same decision with an explicit private-literal flag (the external-link
/// policy deliberately allows private destinations - browser-context
/// semantics).
fn hop_result_flagged(
    max_hops: usize,
    host_rule: RedirectHostRule,
    block_private_literals: bool,
    previous: &[&str],
    next: &str,
) -> Result<(), RedirectRejection> {
    let previous: Vec<Url> = previous.iter().map(|p| Url::parse(p).unwrap()).collect();
    let next = Url::parse(next).unwrap();
    evaluate_redirect_hop(
        &RedirectRules {
            max_hops,
            host_rule,
            block_private_literals,
        },
        &previous,
        &next,
    )
}

#[test]
fn redirects_follow_within_policy() {
    // Download policy follows any https host (GitHub release assets bounce
    // to their asset CDN).
    assert!(hop_result(
        8,
        RedirectHostRule::AnyHttps,
        &["https://github.com/x/y/releases/download/v1/app.exe"],
        "https://release-assets.githubusercontent.com/xx/app.exe"
    )
    .is_ok());
}

#[test]
fn redirects_refuse_https_to_http_downgrade() {
    assert_eq!(
        hop_result(
            8,
            RedirectHostRule::AnyHttps,
            &["https://example.com/app.exe"],
            "http://mirror.example.com/app.exe"
        )
        .err(),
        Some(RedirectRejection::InsecureScheme {
            scheme: "http".to_string()
        })
    );
}

#[test]
fn redirects_refuse_credentials_on_hops() {
    assert_eq!(
        hop_result(
            8,
            RedirectHostRule::AnyHttps,
            &["https://example.com/app.exe"],
            "https://user:pass@mirror.example.com/app.exe"
        )
        .err(),
        Some(RedirectRejection::EmbeddedCredentials)
    );
}

#[test]
fn redirects_refuse_loops_immediately() {
    // A -> B -> A: on the second visit of A the loop is visible in the
    // visited chain and is refused with a dedicated reason, not a budget
    // exhaustion.
    let chain = ["https://a.example/one", "https://b.example/two"];
    assert_eq!(
        hop_result(
            8,
            RedirectHostRule::AnyHttps,
            &chain,
            "https://a.example/one"
        )
        .err(),
        Some(RedirectRejection::Loop)
    );
    // A -> A self-loop too.
    assert_eq!(
        hop_result(
            8,
            RedirectHostRule::AnyHttps,
            &["https://a.example/one"],
            "https://a.example/one"
        )
        .err(),
        Some(RedirectRejection::Loop)
    );
}

#[test]
fn redirects_enforce_the_hop_budget() {
    // origin + 7 hops = 8 visited URLs: the budget is spent, the ninth hop
    // must be refused.
    let previous: Vec<&str> = vec![
        "https://origin.example/f",
        "https://hop.example/f",
        "https://hop.example/f",
        "https://hop.example/f",
        "https://hop.example/f",
        "https://hop.example/f",
        "https://hop.example/f",
        "https://hop.example/f",
    ];
    // 8 visited URLs: the budget is spent, the ninth hop must be refused.
    assert_eq!(
        hop_result(
            8,
            RedirectHostRule::AnyHttps,
            &previous,
            "https://final.example/f"
        )
        .err(),
        Some(RedirectRejection::TooManyHops { limit: 8 })
    );
    // One under the budget still follows.
    assert!(hop_result(
        8,
        RedirectHostRule::AnyHttps,
        &previous[..7],
        "https://final.example/f"
    )
    .is_ok());
}

#[test]
fn redirects_keep_resolver_fetches_on_the_allowlist() {
    // Legitimate, observed hop: Zotero's dl endpoint -> download.zotero.org.
    assert!(hop_result(
        5,
        RedirectHostRule::Allowlist(RESOLVER_ALLOWED_HOSTS),
        &["https://www.zotero.org/download/client/dl?channel=release&platform=win-x64"],
        "https://download.zotero.org/client/release/10.0.6/Zotero-10.0.6_x64_setup.exe"
    )
    .is_ok());

    // A hostile (or newly broken) vendor bounce off the allowlist fails.
    assert_eq!(
        hop_result(
            5,
            RedirectHostRule::Allowlist(RESOLVER_ALLOWED_HOSTS),
            &["https://download.kde.org/stable/krita/"],
            "https://mirror.evil.example/stable/krita/"
        )
        .err(),
        Some(RedirectRejection::LeftAllowlist {
            host: "mirror.evil.example".to_string()
        })
    );
}

#[test]
fn redirects_pin_api_requests_to_their_origin_host() {
    assert!(hop_result(
        3,
        RedirectHostRule::PinToOrigin,
        &["https://api.github.com/repos/x/y/releases/latest"],
        "https://api.github.com/repos/x/y/releases/tag/v2"
    )
    .is_ok());

    assert_eq!(
        hop_result(
            3,
            RedirectHostRule::PinToOrigin,
            &["https://api.github.com/repos/x/y/releases/latest"],
            "https://github.com/x/y/releases/latest"
        )
        .err(),
        Some(RedirectRejection::HostMismatch {
            host: "github.com".to_string()
        })
    );
}

#[test]
fn every_policy_builds_a_client() {
    for policy in [
        UrlPolicy::external_link(),
        UrlPolicy::api_github(),
        UrlPolicy::api_fdroid(),
        UrlPolicy::resolver_manifest(),
        UrlPolicy::executable_download(),
    ] {
        policy
            .http_client()
            .unwrap_or_else(|e| panic!("client for {} must build: {e}", policy.label));
    }
}

// ---------------------------------------------------------------------------
// Connect-time public-address filter
// ---------------------------------------------------------------------------

#[test]
fn routability_matrix_v4() {
    for raw in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "151.101.1.140"] {
        assert!(
            is_publicly_routable(raw.parse().unwrap()),
            "{raw} must be routable"
        );
    }

    for raw in [
        "0.0.0.0",
        "0.1.2.3",
        "10.0.0.1",
        "100.64.0.1",
        "100.127.255.255",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.254",
        "192.0.0.1",
        "192.0.2.1",
        "192.88.99.1",
        "192.168.0.1",
        "198.18.0.1",
        "198.19.255.255",
        "198.51.100.7",
        "203.0.113.7",
        "224.0.0.22",
        "240.0.0.1",
        "255.255.255.255",
    ] {
        assert!(
            !is_publicly_routable(raw.parse().unwrap()),
            "{raw} must NOT be routable"
        );
    }
}

#[test]
fn routability_matrix_v6() {
    for raw in [
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
        "2620:fe::fe",
    ] {
        assert!(
            is_publicly_routable(raw.parse().unwrap()),
            "{raw} must be routable"
        );
    }
    for raw in [
        "::",
        "::1",
        "::ffff:8.8.8.8", // IPv4-mapped: rejected outright
        "::ffff:127.0.0.1",
        "64:ff9b::808:808",   // NAT64: translated destination refused
        "64:ff9b:1::808:808", // local-use NAT64
        "fc00::1",
        "fd00::1",
        "fe80::1",
        "ff02::1",
        "2001:db8::1",
        // 2001::/23 (IETF protocol assignments): the boundary rows.
        // (2001:200::1, the first global block ABOVE /23, is exercised in
        // the public list below.)
        "2001::1",
        "2001:1ff:ffff::1",
        // 6to4 and 6bone (decommissioned)
        "2002:c000:201::1",
        "3ffe::1",
        // 3fff::/20 documentation (RFC 9637): the whole /20, not just /28.
        "3fff::1",
        "3fff:1::1",
        "3fff:f::1",
        "3fff:fff:ffff::1",
        // 5f00::/16 SRv6
        "5f00::1",
    ] {
        assert!(
            !is_publicly_routable(raw.parse().unwrap()),
            "{raw} must NOT be routable"
        );
    }
    // Public rows that flank the special ranges: the first global block
    // above 2001::/23, and the first blocks just above 3fff::/20 (bits
    // 16-19 nonzero, still inside 2000::/3). Blocks at 4000:: and beyond
    // are refused by the 2000::/3 gate itself and sit in the refused list.
    for raw in ["2001:200::1", "3fff:8000::1", "3fff:ffff::1"] {
        assert!(
            is_publicly_routable(raw.parse().unwrap()),
            "{raw} must be routable"
        );
    }
}

#[test]
fn filter_keeps_only_public_addresses() {
    let to_sa = |raw: &str| {
        let ip: IpAddr = raw.parse().unwrap();
        SocketAddr::new(ip, 443)
    };
    // Mixed set: private records must not leak into the connect set.
    let mixed = vec![
        to_sa("192.168.1.1"),
        to_sa("8.8.8.8"),
        to_sa("::1"),
        to_sa("2606:4700:4700::1111"),
    ];
    let filtered = filter_public_addrs(mixed.into_iter(), "mixed.example").expect("public exists");
    assert_eq!(filtered.len(), 2);

    // All-private: refuse the request entirely.
    let private = vec![to_sa("127.0.0.1"), to_sa("10.0.0.2")];
    assert!(filter_public_addrs(private.into_iter(), "private.example").is_err());

    // Empty resolution (should not happen upstream, but stay safe).
    let none: Vec<SocketAddr> = Vec::new();
    assert!(filter_public_addrs(none.into_iter(), "empty.example").is_err());
}

#[test]
fn local_hostname_detection() {
    for host in ["localhost", "LOCALHOST", "sub.localhost", "Sub.LOCALHOST"] {
        assert!(is_local_hostname(host), "{host}");
    }
    for host in ["notlocalhost", "localhost.example.com", "example.com"] {
        assert!(!is_local_hostname(host), "{host}");
    }
}

// ---------------------------------------------------------------------------
// Adversarial admission: ambiguous / look-alike host forms (table-driven)
// ---------------------------------------------------------------------------

#[test]
fn ambiguous_host_forms_are_handled_predictably() {
    let policy = UrlPolicy::api_github();
    // Trailing dot: a normalization trick that would bypass a naive
    // equality check. The WHATWG parser keeps it, so it is NOT the pinned
    // host and must be refused.
    assert!(
        matches!(
            policy.validate("https://api.github.com./repos/x/y"),
            Err(PolicyError::DisallowedHost { .. })
        ),
        "trailing-dot host is not the pinned host"
    );
    // Uppercase is normalized by the parser and therefore admitted as the
    // genuine host (the connection target is really api.github.com).
    policy
        .validate("https://API.GITHUB.COM/repos/x/y")
        .expect("case-normalized pinned host must validate");
    // Percent-encoding in the host is decoded BEFORE the allowlist
    // comparison, so an encoded form of the pinned host IS the pinned host
    // (no bypass in either direction).
    policy
        .validate("https://api.github%2Ecom/repos/x/y")
        .expect("percent-decoded host is the genuine pinned host");
    // A punycode host that is NOT the pinned host is refused byte-exactly.
    assert!(policy.validate("https://xn--80ak6aa92e.com/x").is_err());
    // The port is not part of the host: a pinned-host URL on a different
    // port still connects to the pinned host's addresses. Documented so
    // the behavior is a decision, not an accident.
    policy
        .validate("https://api.github.com:8443/repos/x/y")
        .expect("port variations of the pinned host stay on the pinned host");
}

#[test]
fn userinfo_disguises_are_refused_across_policies() {
    // "https://trusted.example:443@evil.example/" reads like the trusted
    // host but everything before the @ is USERINFO.
    for raw in [
        "https://api.github.com:443@evil.example/repos/x/y",
        "https://api.github.com@evil.example/repos/x/y",
        "https://f-droid.org@api.github.com/x",
    ] {
        let result = UrlPolicy::api_github().validate(raw);
        assert!(
            matches!(result, Err(PolicyError::EmbeddedCredentials)),
            "{raw} must be refused as embedded credentials"
        );
    }
}

#[test]
fn ipv6_zone_ids_are_not_admitted() {
    // Scoped addresses ("[fe80::1%25eth0]") name a machine-local interface.
    // The WHATWG host parser rejects the zone id outright, so the URL is
    // refused at admission (either as malformed or as private - both are
    // safe; the invariant is: never admitted, never connected).
    let result = UrlPolicy::executable_download().validate("https://[fe80::1%25eth0]/x");
    assert!(result.is_err(), "zone-id host must be refused");
}

#[test]
fn every_strict_policy_refuses_private_redirect_literals_consistently() {
    // Guards against future drift: any policy that refuses private
    // address literals at admission must refuse them on redirect hops
    // too. external_link deliberately allows them (browser-context
    // semantics, see its constructor docs).
    for policy in [
        UrlPolicy::api_github(),
        UrlPolicy::api_fdroid(),
        UrlPolicy::resolver_manifest(),
        UrlPolicy::executable_download(),
    ] {
        assert!(
            policy.redirects.block_private_literals,
            "policy {} must refuse private redirect literals",
            policy.label
        );
        assert!(
            policy.block_private_addrs,
            "policy {} must refuse private literals at admission",
            policy.label
        );
    }
    assert!(!UrlPolicy::external_link().redirects.block_private_literals);
}

// ---------------------------------------------------------------------------
// Redirect destinations: private literals vs. legitimate public hosts
// ---------------------------------------------------------------------------

#[test]
fn redirects_refuse_private_and_metadata_address_literals() {
    // The cloud-metadata address is THE SSRF prize; every private family
    // must get the same named refusal.
    for next in [
        "https://169.254.169.254/latest/meta-data/",
        "https://10.0.0.5/setup.exe",
        "https://192.168.1.1/setup.exe",
        "https://127.0.0.1/setup.exe",
        "https://[fe80::1]/setup.exe",
        "https://[fd00::1]/setup.exe",
        "https://[::ffff:10.0.0.1]/setup.exe",
        "https://[64:ff9b::10.0.0.1]/setup.exe",
    ] {
        assert_eq!(
            hop_result(
                8,
                RedirectHostRule::AnyHttps,
                &["https://origin.example/setup.exe"],
                next
            )
            .err(),
            Some(RedirectRejection::PrivateDestination {
                host: host_of(next).to_string()
            }),
            "{next}"
        );
    }
}

#[test]
fn redirects_still_follow_legitimate_public_hosts_and_literals() {
    // Public IP literals and public hostnames must NOT be broken by the
    // private-literal rule (vendors bounce installers across CDNs).
    for next in [
        "https://93.184.216.34/setup.exe",
        "https://[2606:4700:4700::1111]/setup.exe",
        "https://release-assets.githubusercontent.com/xx/setup.exe",
    ] {
        assert!(
            hop_result(
                8,
                RedirectHostRule::AnyHttps,
                &["https://github.com/x/y/releases/download/v1/setup.exe"],
                next
            )
            .is_ok(),
            "{next} must be followed"
        );
    }
}

#[test]
fn external_link_redirects_deliberately_allow_private_literals() {
    // The external-link policy is a browser-context rule: it never fetches
    // natively, so a user pasting a private URL as a project link is not
    // attack surface. The permissive flag is documented behavior.
    assert!(
        hop_result_flagged(
            5,
            RedirectHostRule::AnyHttps,
            false,
            &["https://router.example/admin"],
            "https://192.168.1.1/admin"
        )
        .is_ok(),
        "external-link policy follows private literals by design"
    );
}

/// Host part of a test URL, used to build expected PrivateDestination
/// values without hand-copying strings.
fn host_of(raw: &str) -> String {
    let url = Url::parse(raw).unwrap();
    url.host_str().unwrap_or("").to_string()
}

// ---------------------------------------------------------------------------
// Connect-time resolver: scripted DNS answer sets (no network anywhere)
// ---------------------------------------------------------------------------

fn sa(raw: &str) -> SocketAddr {
    SocketAddr::new(raw.parse().expect("test ip"), 443)
}

async fn resolve_with(
    answers: Result<Vec<SocketAddr>, String>,
    host: &str,
) -> Result<Vec<SocketAddr>, String> {
    use std::str::FromStr;
    let resolver = PublicOnlyResolver::scripted(move |_| {
        let answers = answers.clone();
        Box::pin(async move { answers }) as LookupFuture
    });
    let name = reqwest::dns::Name::from_str(host).expect("test name");
    let resolving = Resolve::resolve(&resolver, name);
    let result = resolving.await;
    match result {
        Ok(iter) => Ok(iter.collect()),
        Err(e) => Err(e.to_string()),
    }
}

#[tokio::test]
async fn resolver_hands_out_only_the_public_part_of_mixed_answers() {
    let answers = vec![
        sa("192.168.1.1"),
        sa("8.8.8.8"),
        sa("::1"),
        sa("fe80::1"),
        sa("2606:4700:4700::1111"),
        sa("2002::1"), // 6to4: refused by the classification
    ];
    let public = resolve_with(Ok(answers), "mixed.example")
        .await
        .expect("a mixed answer set still has public addresses");
    assert_eq!(public.len(), 2);
    assert!(public.contains(&sa("8.8.8.8")));
    assert!(public.contains(&sa("2606:4700:4700::1111")));
}

#[tokio::test]
async fn resolver_fails_the_request_when_nothing_public_remains() {
    let answers = vec![sa("127.0.0.1"), sa("10.0.0.2"), sa("fd00::1")];
    let err = resolve_with(Ok(answers), "private.example")
        .await
        .expect_err("an all-private answer set must fail the request");
    assert!(
        err.contains("only resolves to private or local network addresses"),
        "unexpected error: {err}"
    );
}

#[tokio::test]
async fn resolver_rechecks_every_lookup_so_rebinding_cannot_slip_through() {
    use std::str::FromStr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    // First lookup: public. Second lookup (what reqwest would issue for
    // the next connection attempt - a redirect hop, a reconnect): private.
    // The resolver must re-filter per call; caching would let hop two
    // connect into private space.
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    let resolver = PublicOnlyResolver::scripted(move |_| {
        let call = CALLS.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if call == 0 {
                Ok(vec![sa("93.184.216.34")])
            } else {
                Ok(vec![sa("169.254.169.254")])
            }
        }) as LookupFuture
    });
    let name = || reqwest::dns::Name::from_str("rebind.example").expect("test name");
    let first = Resolve::resolve(&resolver, name()).await;
    assert!(first.is_ok(), "the first lookup is public and passes");

    let second = Resolve::resolve(&resolver, name()).await;
    assert!(
        second.is_err(),
        "the re-resolved private answer must be refused, not cached"
    );
}

#[tokio::test]
async fn resolver_surfaces_lookup_failures_to_the_caller() {
    let err = resolve_with(Err("resolver is down".to_string()), "dead.example")
        .await
        .expect_err("a failed lookup must surface as a failed request");
    assert!(err.contains("resolver is down"), "unexpected error: {err}");
}

#[test]
fn scripted_resolvers_only_exist_in_tests() {
    // Guardrail for the injection point: the production constructor is
    // Default (system resolver), and `scripted` is cfg(test) so release
    // builds cannot be built with a scripted DNS answer set.
    let _ = PublicOnlyResolver::default();
}

// ---------------------------------------------------------------------------
// Ports: the scheme is the boundary, not the port (documented decision)
// ---------------------------------------------------------------------------

#[test]
fn non_443_https_ports_are_a_documented_decision() {
    // TLS semantics do not depend on the port; vendors occasionally serve
    // from non-default ports. The current decision admits https on any
    // port and refuses http on any port - pinning it so a future
    // restriction has to be a conscious change, not an accident.
    UrlPolicy::executable_download()
        .validate("https://vendor.example:8443/app.exe")
        .expect("https on a non-default port is admissible for downloads");
    UrlPolicy::resolver_manifest()
        .validate("https://download.kde.org:8443/manifest.yml")
        .expect("allowlist matching is by host, independent of port");
    UrlPolicy::executable_download()
        .validate("https://api.github.com:8443/repos/x/y/releases/latest")
        .expect("pinned API hosts are likewise port-independent");

    // Cleartext on the DEFAULT port is still cleartext.
    let err = UrlPolicy::executable_download()
        .validate("http://example.com:443/app.exe")
        .expect_err("http on port 443 must stay refused");
    assert_eq!(
        err,
        PolicyError::InsecureScheme {
            scheme: "http".to_string()
        }
    );
}

// ---------------------------------------------------------------------------
// End-to-end wiring: the policy-built client really runs every redirect
// hop through the validation function. The first hop below is cleartext
// LOOPBACK purely so a plain test server can answer it (admission is a
// separate, tested layer); production first hops are https by admission.
// No test here reaches a non-loopback address: the refused hops are cut
// at the policy decision, before any connection is attempted.
// ---------------------------------------------------------------------------

/// Answers exactly one request with `response`, on an ephemeral loopback
/// port. Returns the port.
fn spawn_one_shot_http(response: &'static [u8]) -> u16 {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("local addr").port();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(response);
            let _ = stream.flush();
        }
    });
    port
}

/// Collect an error's Display plus its whole source chain, so policy
/// reasons are asserted wherever reqwest decided to put them.
fn error_chain_text(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        text.push_str("; caused by: ");
        text.push_str(&s.to_string());
        source = s.source();
    }
    text
}

#[tokio::test]
async fn the_policy_client_refuses_a_redirect_to_a_private_address_literal() {
    // The redirect points at the cloud-metadata address. A plain client
    // would try to CONNECT there; the policy client must refuse at the
    // hop decision, which is observable as a redirect-kind error naming
    // the private destination.
    let port = spawn_one_shot_http(
        b"HTTP/1.1 302 Found\r\n\
          Location: https://169.254.169.254/latest/meta-data/\r\n\
          Content-Length: 0\r\n\
          Connection: close\r\n\r\n",
    );
    let client = UrlPolicy::executable_download()
        .http_client()
        .expect("policy client builds");
    let err = client
        .get(format!("http://127.0.0.1:{port}/payload"))
        .send()
        .await
        .expect_err("a redirect to a private literal must be refused");
    assert!(
        err.is_redirect(),
        "the refusal must come from the redirect policy, got: {err}"
    );
    let text = error_chain_text(&err);
    assert!(
        text.contains("private or local address"),
        "the named reason must surface: {text}"
    );
}

#[tokio::test]
async fn the_policy_client_refuses_a_downgrade_redirect() {
    let port = spawn_one_shot_http(
        b"HTTP/1.1 302 Found\r\n\
          Location: http://example.com/payload\r\n\
          Content-Length: 0\r\n\
          Connection: close\r\n\r\n",
    );
    let client = UrlPolicy::executable_download()
        .http_client()
        .expect("policy client builds");
    let err = client
        .get(format!("http://127.0.0.1:{port}/payload"))
        .send()
        .await
        .expect_err("a https-to-http downgrade redirect must be refused");
    assert!(err.is_redirect(), "got: {err}");
    let text = error_chain_text(&err);
    assert!(
        text.contains("non-https"),
        "the downgrade reason must surface: {text}"
    );
}

#[tokio::test]
async fn address_literal_requests_never_consult_the_resolver() {
    // hyper resolves hostnames only: a loopback-literal URL must reach
    // the socket WITHOUT a DNS lookup. This is the documented split from
    // the module docs - the private-space guard for literals lives in
    // admission and the per-hop check, not in the resolver. The test
    // fails (request errors, or the call counter moves) if a future
    // reqwest starts routing literals through the resolver, which would
    // silently relocate where the guard lives.
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = Arc::new(AtomicUsize::new(0));
    let watcher = Arc::clone(&calls);
    let resolver = PublicOnlyResolver::scripted(move |host| {
        let calls = Arc::clone(&watcher);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(format!(
                "resolver must not be consulted, was asked for {host}"
            ))
        }) as LookupFuture
    });
    let client = UrlPolicy::executable_download()
        .http_client_with_resolver(resolver)
        .expect("policy client builds");
    let port =
        spawn_one_shot_http(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    let resp = client
        .get(format!("http://127.0.0.1:{port}/payload"))
        .send()
        .await
        .expect("a literal-host request must reach the loopback server");
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "the DNS resolver must never be consulted for an address literal"
    );
}
