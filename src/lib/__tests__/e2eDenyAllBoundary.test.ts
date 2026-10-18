// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Boundary contract of the E2E deny-all fallback (tests/e2e/netpolicy.ts).
 *
 * The deny-all route exists so a surprise request in a test FAILS LOUDLY
 * (route.abort) instead of silently leaking to the live network. Its one
 * carve-out is the local dev/CSP test server, which must stay reachable.
 * The carve-out used to be a bare prefix lookahead, so any host that
 * merely STARTED with "localhost" or "127.0.0.1" (localhost.evil.com,
 * 127.0.0.1.evil.com, a userinfo trick like localhost:80@evil.com)
 * slipped past the fallback and leaked instead of failing. The pattern is
 * now boundary-exact, and this suite pins the full matrix so the prefix
 * regression can never come back quietly.
 *
 * These tests run the EXACT regex object installNetworkPolicy() hands to
 * page.route() - imported, not re-declared - so the suite cannot drift
 * from production behavior.
 */
import { describe, expect, it } from 'vitest';
import { DENY_ALL_ROUTE_RE } from '../../../tests/e2e/netpolicy';

/** Requests the deny-all must NOT match (loopback carve-out holds: the
 * local dev server and CSP test server stay reachable). */
const ALLOWED = [
  'http://localhost:4173/',
  'http://localhost:4173/catalog?filter=free#top',
  'http://127.0.0.1:8899/csp-report',
  'http://127.0.0.1/',
  'http://localhost',
];

/** Requests the deny-all MUST match (aborted, never leaked): hosts that
 * merely start with a loopback token, userinfo tricks, and everything
 * plainly external. */
const DENIED = [
  'https://localhost.evil.com/exfil',
  'https://127.0.0.1.evil.com/exfil',
  'http://localhostity.example/',
  'https://127.0.0.127.evil.com/',
  'http://localhost:80@evil.com/',
  'http://127.0.0.1:80@evil.com/',
  'https://example.com',
  'https://api.github.com/repos/localsend/localsend/releases/latest',
];

describe('E2E deny-all fallback boundary (DENY_ALL_ROUTE_RE)', () => {
  it('keeps the loopback carve-out reachable (dev server, CSP test server)', () => {
    for (const url of ALLOWED) {
      expect(DENY_ALL_ROUTE_RE.test(url), `must NOT be denied: ${url}`).toBe(false);
    }
  });

  it('denies lookalike hosts that merely start with a loopback token', () => {
    for (const url of DENIED) {
      expect(DENY_ALL_ROUTE_RE.test(url), `must be denied: ${url}`).toBe(true);
    }
  });

  it('is a stateless matcher (no global flag - page.route re-tests every URL)', () => {
    // A /g regex keeps lastIndex between .test() calls and would
    // intermittently stop matching inside page.route's repeated probes.
    expect(DENY_ALL_ROUTE_RE.flags).not.toContain('g');
  });
});
