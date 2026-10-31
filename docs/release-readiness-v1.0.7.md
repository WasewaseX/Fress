# Fress v1.0.7 (stable) — release readiness gate

Status: **OPEN — the next stable release is not cut until every gate below
closes.** This checklist was written 2026-10-31 from the release verdict and
re-verified against live repository state on the same day. Every "current"
claim names its evidence source; nothing is assumed from memory.

---

## 1. Current state (verified 2026-10-31)

| Fact | Value | Evidence |
| --- | --- | --- |
| Current stable release | `v1.0.6` (2026-10-19T00:23Z, prerelease=false, 22 assets) | releases API |
| Newest beta release | `v1.0.9-beta` (2026-10-12); the beta track ends at `v1.0.12-beta` (2026-10-13) | releases API |
| `main` tip | `b10bc4b` (2026-10-19, merge of PR #126) | commits API |
| Open release PR | **#130** — silent-prerelease gate (`/releases/latest` oracle + textual filter), head `f3a87b4`, base `b10bc4b`, mergeable state `clean` | pulls API |
| CI on the PR head | **13/13 check runs success** (CI, author guard ×2) | check-runs API, run 41203402616 |
| Unit suite on the PR head | **943 passed / 2 intentionally skipped (945 total, 61 files)** | CI job log, job 124543558592 |
| Dependency audit on the PR head | **171 packages audited, 0 vulnerabilities** (`npm audit --omit=dev --audit-level=high`) | CI job log, job 124543558592 |
| Dependency state | Vite **6.4.5** in the lockfile; `@tailwindcss/vite` and every build plugin in `devDependencies`; the launch-editor advisory chain no longer resolves | `package-lock.json` on `f3a87b4` |
| Scheduled smoke fix | The workflow starts `scripts/api-mock/server.mjs` (readiness-polled) and Bruno runs `--env mock`, so `{{mockBase}}` resolves — the 2026-10-26 six-red-mock gap is fixed in PR #130 | `.github/workflows/network-smoke.yml` on `f3a87b4` |
| Scheduled security scan on `main` | **failing by construction** until #130 merges (the Vite fix rides the PR branch; latest scheduled run 40324663449 is red on `b10bc4b`) | workflow runs API |
| Physical smoke matrix | **NOT RUN** — all 24 rows (Windows W1–W5, macOS M1–M5, Linux L1–L7, Android A1–A7) | docs/testing/*.md |

The three defects from the v1.0.6 bug-hunt (self-update deadline, text-path
`Retry-After`, escaped release-asset slug) are **already merged into `main`**
via PR #126 and are present on the PR branch as well — verified by reading
`src/lib/selfUpdate.ts`, `src-tauri/src/api_resilience.rs` and
`src/lib/release/atomReleases.ts` on both SHAs.

## 2. The gate sequence (the release verdict's order, unchanged)

1. **Independent human review of PR #130.** The PR description now documents
   the implemented fail-closed contract (an oracle failure refuses the scan;
   the API stage that brackets every atom call owns the verified answer) with
   the evidence above. The review must land on the diff of `f3a87b4` — no
   merge without it.
2. **Merge PR #130** after the review, with all checks green on the exact
   merged head. `main` then carries the silent-prerelease gate, the dependency
   fixes and the mock-smoke fix, and the scheduled security scan goes green
   again on its next run.
3. **Physical smoke matrix.** All 24 rows in `docs/testing/` — Windows
   (W1–W5), macOS (M1–M5), Linux (L1–L7), Android (A1–A7). The
   highest-value row is Android's real FileProvider → system
   package-installer handoff (A-rows): mocked tests do not establish real OS
   behavior, and the README says so. Record each row with the OS version it
   ran on, or leave it honestly pending — do not pre-mark.
4. **Release documentation.** The README refresh of 2026-10-31 (this branch)
   updates the stable-release claims to `v1.0.6` with re-verified evidence:
   the 22-file inventory and 5 sidecars (releases API), the 21-entry
   `SHA256SUMS.txt` (downloaded and re-counted), `latest.json` (version
   1.0.6, 8 platform entries, every embedded signature byte-equal to its
   published sidecar — downloaded and compared), and the Windows
   no-signing path (build log of release run 39179162111:
   `FRESS_SIGNING_CONFIGURED: false`). Historical audit records
   (`docs/release-readiness.md`, `CODE_SIGNING.md`) are intentionally NOT
   rewritten — they are evidence, not living docs.
5. **Version bump to `1.0.7`.** Applied consistently across the authoritative
   surfaces (`package.json`, `package-lock.json` root + `packages[""]`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
   including the `tauri-plugin-fress-open` entry, and the discovered plugin
   manifests under `src-tauri/plugins/*/Cargo.toml`); `npm run
   validate:versions` is the arbiter (8 fields on the current tree). **The
   bump and the `## 1.0.7` CHANGELOG entry must land in the same commit:**
   the What's-new modal renders its fallback body when the installed version
   has no changelog notes, and `uiRegressionsRound8`'s disclosure tests pin
   the non-fallback rendering — verified 2026-10-31 (a bump without the
   entry turned `the details toggle declares aria-controls` red; docs-only
   trees stay green). That is why this checklist does not pre-bump: the bump
   belongs to the release round that writes the release notes. `main`
   carrying 1.0.7 while `v1.0.6` is the newest published release is the
   designed development state.
6. **Release run and independent verification.** Tag `v1.0.7` → the release
   workflow builds and publishes; then the release round must re-verify the
   published bytes independently (all 22 assets downloaded and re-hashed
   against `SHA256SUMS.txt`, the five sidecars minisign-verified against the
   published key, `latest.json` cross-checked — same method as the v1.0.0
   and round-9 audits). Publication claims stay unproven until that pass.

## 3. Known, accepted limitations (documented, not hidden)

- **Windows Authenticode: absent.** Verified on the current stable's build
  log (see §1). The free-route options (e.g. SignPath Foundation) are
  documented in `CODE_SIGNING.md`; until one is configured, the release body
  and README carry the honest warning. This is a documented acceptance, not
  a silent gap.
- **macOS: unsigned and unnotarized.** First launch needs right-click →
  Open; documented in the README and `CODE_SIGNING.md`.
- **VirusTotal overlay:** skipped unless `VIRUSTOTAL_API_KEY` is configured;
  a skipped scan is never reported as a pass.
- **Branch-protection enforcement:** unverifiable without admin scope; green
  CI and merge discipline are evidence of process, not of enforcement.

## 4. What closes this checklist

All six sequence items recorded with their own evidence (review identity,
merged head SHA, per-row smoke results with OS versions, the release run ID,
and the independent artifact-audit output). Only then does `v1.0.7` carry
the "stable" name.
