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

fn rules(max_hops: usize, host_rule: RedirectHostRule) -> RedirectRules {
    RedirectRules {
        max_hops,
        host_rule,
    }
}

fn hop_result(
    max_hops: usize,
    host_rule: RedirectHostRule,
    previous: &[&str],
    next: &str,
) -> Result<(), RedirectRejection> {
    let previous: Vec<Url> = previous.iter().map(|p| Url::parse(p).unwrap()).collect();
    let next = Url::parse(next).unwrap();
    evaluate_redirect_hop(&rules(max_hops, host_rule), &previous, &next)
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
    ] {
        assert!(
            !is_publicly_routable(raw.parse().unwrap()),
            "{raw} must NOT be routable"
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
