# Release signing and verification

This document records, per platform and per artifact, what each release
actually carries: which files are signed, by what, what each layer proves,
and where Fress intentionally falls back to the official Releases page.
It is scoped to the published releases — the numbers below were re-verified
against release `v1.0.9-beta` (published 2026-10-12) on 2026-10-13, from the
release's actual bytes and its CI build run.

## What each release mechanism actually establishes

Four independent mechanisms touch a Fress release, and they answer four
different questions. Do not conflate them:

| Mechanism | Question it answers | Establishes | Consumed by | Current status (evidence: release v1.0.9-beta) |
| --- | --- | --- | --- | --- |
| `SHA256SUMS.txt` | "Is this file byte-for-byte what CI built?" | Integrity: a checksum comparison against CI's manifest, delivered over HTTPS from the release page | The in-app self-update (verifies before offering the installer) and any manual `sha256sum -c` | On every release (back to v1.0.0-beta); since v1.0.7-beta the in-app updater reads it through the native `fetch_self_update_text` command, fail-closed (`planUpdateDelivery`); every entry checked on v1.0.9-beta matched the published bytes |
| Minisign `.sig` + `latest.json` + embedded public key | "Who authorized this updater artifact?" | Authenticity: a signature that only the holder of the private key (a repository secret) can produce | The native `verify_self_update_signature` command, called by the real delivery flow (`src/features/selfUpdate/updateDelivery.ts`) after every completed update download and before any "verified" state is shown | Produced for the Windows installers and Linux bundles; the MSI, macOS dmgs, portable zips and all APKs ship WITHOUT updater artifacts — those platforms are therefore NOT delivered in-app (releases-page fallback) |
| Authenticode (Windows) | "Is the publisher accountable to a certificate authority Windows trusts?" | Publisher identity for Explorer/SmartScreen; tamper evidence tied to that identity | Windows itself at install time | **Not applied today** — no signing secrets are configured (the v1.0.9-beta build ran the workflow's "no signing certificate" path), and the published installers carry no Authenticode certificate table (byte-verified). This is why Windows shows "Unknown publisher" |
| APK signature (Android) | "Will Android accept this APK as an update of the installed app?" | OS-enforced same-signer rule: the package installer refuses an update signed with a different key | Android's package installer at install time | Applied by CI from the persistent keystore secret; on v1.0.9-beta CI restored the persistent keystore and signed all five APKs with it |

A checksum proves the file matches the manifest but not who made the manifest;
a minisign signature proves who authorized the artifact but is only visible to
the verifier that embeds the public key; Authenticode proves a publisher
identity to Windows but says nothing about update integrity by itself; the
Android package signature is enforced by the OS on update-over-install and is
unrelated to the other three. A SHA-256 match also says nothing about
publisher identity if BOTH the file and the manifest came from the same
compromised release account — that is exactly the gap the minisign layer
closes for the artifacts it covers.

## Verify a download manually

```bash
sha256sum -c SHA256SUMS.txt        # integrity: matches what CI built
```

A passing checksum tells you the file is exactly the bytes CI published — it
does NOT tell you who published them (if the release account itself were
compromised, both the file and the manifest would match). The updater
signatures close that gap for the artifacts they cover; if you want the same
publisher check the app performs, verify the minisign signature yourself:

```bash
minisign -V -p fress-updater.key.pub -s Fress_<version>_<arch>-setup.exe.sig \
  -m Fress_<version>_<arch>-setup.exe
```

`fress-updater.key.pub` is the public verification key published in this
repository and embedded in every Fress build since v1.0.8-beta (see the
rotation notes below). A successful verification means the file was signed by
the holder of the release private key — the same property the in-app updater
checks before it calls an update "verified". The MSI, the macOS dmgs, the
portable zips and the APKs have no `.sig` sidecar on the releases; for those,
the checksum plus the distribution channel (this repository only) is what is
available, and for the APKs Android additionally enforces the signing-key
identity at install time.

## Windows: signing and the "Unknown Publisher" warning

### Why Windows shows the blue warning

When you run the installer, Windows checks whether the publisher is vouched
for by a certificate authority it already trusts.

- No signature at all (what CI ships today): Windows says "Unknown
 Publisher". No build flag or setting changes this. The warning is Windows
 doing its job.
- A self-signed signature (if a self-signed certificate is ever configured):
 still "Unknown Publisher", because the certificate vouches for itself.

The warning goes away when the installer is signed with a certificate that
chains to a root Windows already trusts. There is a free way to get there.

### The free route: SignPath Foundation

The [SignPath Foundation](https://signpath.org) signs binaries for open-source
projects at no cost. Two things worth knowing:

- No personal identification is required. They verify that binaries were built
 from this repository, not who you are.
- There are no fees for open-source projects, including re-issues.

One trade-off: the certificate is issued to SignPath Foundation, so Windows
lists *SignPath Foundation* as the verified publisher rather than "Fress".

Fress meets their published conditions:

| Condition | Fress status |
| --- | --- |
| No malware or unwanted programs | plain catalog app |
| OSI-approved license, no dual-licensing | MIT |
| No proprietary components | entirely MIT |
| Actively maintained | ongoing releases |
| Already released in the form to be signed | v1.0.0-beta |
| Documented on the download page | README and release notes |

### Steps

1. Apply at [signpath.org/apply](https://signpath.org/apply) with the
 repository URL `https://github.com/WasewaseX/Fress`.
2. Wait for their review (a few days to a couple of weeks).
3. After approval you get a SignPath.io organization. From its dashboard
 collect the API token, organization ID, project ID, and signing policy ID.
4. Add them as repository secrets under **Settings -> Secrets and variables ->
 Actions**: `SIGNPATH_API_TOKEN`, `SIGNPATH_ORG_ID`, `SIGNPATH_PROJECT_ID`,
 `SIGNPATH_SIGNING_POLICY_ID`.
5. The Windows build job then signs the installer through their service
 (`submit-signing-request` GitHub Action; the key stays on their HSM), and
 the signed installer is uploaded to the release with the next version tag.

### The persistent publisher certificate (CI default once configured)

CI is wired to reuse ONE persistent certificate for every release instead of
generating a throwaway self-signed certificate per build (a fresh identity
every build proves nothing and accumulates no reputation with Defender or
SmartScreen). The steps run ONLY when the secrets exist — with no secrets set,
the installers ship unsigned, which is the state every release so far
(through v1.0.9-beta) actually shipped in:

- `WINDOWS_PFX_B64`, the `.pfx` (certificate + private key), base64-encoded
- `WINDOWS_PFX_PASSWORD`, the .pfx export password

Creating one on your own machine (run once, keep the .pfx backed up):

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Fress" `
 -KeyUsage DigitalSignature -KeySpec Signature -KeyAlgorithm RSA -KeyLength 3072 `
 -NotAfter (Get-Date).AddYears(5) -CertStoreLocation "Cert:\CurrentUser\My"
$pwd = ConvertTo-SecureString -String "your-export-password" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath "fress-sign.pfx" -Password $pwd
[Convert]::ToBase64String([IO.File]::ReadAllBytes("fress-sign.pfx")) | Set-Clipboard
```

Then set `WINDOWS_PFX_B64` to the clipboard contents and `WINDOWS_PFX_PASSWORD`
to the export password. Every Windows installer build (x64 + ARM64) is then
Authenticode-signed with the same publisher identity, and each installer's
updater `.sig` is regenerated over the signed bytes (see the sequencing notes
below). The portable zips are never signed — they are plain archives of the
built exe, in every configuration.

Honesty note: a self-signed publisher still shows "Unknown publisher", only
a certificate chaining to a trusted root (SignPath Foundation, Azure
Trusted Signing, or a paid CA) removes it. What the persistent signature does
buy: identical publisher across releases, tamper evidence, and a stable
identity for allow-lists and Microsoft's false-positive reporting.

### The paid alternative: Azure Trusted Signing

Microsoft's own signing service costs a small monthly fee and shows your own
name as the publisher. `release.yml` already contains the
`azure/trusted-signing-action` path, gated on six secrets: `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_CODESIGNING_ENDPOINT`,
`AZURE_CODESIGNING_ACCOUNT`, `AZURE_CODESIGNING_PROFILE`. Setup order: create
the Azure account and Trusted Signing resource, complete identity validation
on a Public Trust profile, create an Entra app registration with a client
secret, add the six secrets, push a tag. When configured it takes precedence
over the .pfx path.

### Antivirus false positives (Trojan:Win32/Bearfoos.A!ml)

Microsoft Defender's machine-learning heuristics flag clean, low-reputation
Windows binaries, unsigned installers that download other installers are a
classic trigger, and release builds were additionally stripped (`strip = true`
in Cargo.toml), which makes them look even more packer-like. Countermeasures
in place: release builds are unstripped, the updater signature is persistent,
Fress is distributed only through GitHub Releases with SHA256SUMS.txt, and a
`virustotal` CI job scans every release asset when the `VIRUSTOTAL_API_KEY`
secret is set (it is configured). One honest caveat: through v1.0.9-beta the
job's scan-links section has not appeared on any published release page (the
body edit does not survive the release pipeline), so treat the multi-engine
links as unavailable and verify with `SHA256SUMS.txt` and, for the signed
artifacts, the minisign signature instead. If a build is still flagged,
submit it at <https://www.microsoft.com/en-us/wdsi/filesubmission> and check
the SHA256 against `SHA256SUMS.txt` before running anything.

### Android: the persistent keystore

Same rule as Windows: the keystore is stored ONCE as a repository secret
(`ANDROID_KEYSTORE_B64`, base64 of `fress.keystore`, alias `fress`) and
reused for every release, because a fresh keystore per release would make
Android refuse update-over-install (signature mismatch), forcing users to
uninstall first. The store/key password is a signing secret: it lives in CI
secrets next to the keystore and is NEVER written into this repository or
its documentation. If a password was ever committed anywhere, rotate the
keystore and treat every past release as publisher-unverified on Android.
(Repository hygiene note: an earlier revision of this document named the
keystore password in plaintext; that reference has been removed, and the
release workflow now reads the password from the `ANDROID_KEYSTORE_PASSWORD`
Actions secret instead of hardcoding it - every keystore command fails
closed when the secret is absent or wrong. Maintainers should still rotate
that password to a strong value and update the secret, because the old
value appeared in command lines of past CI runs.)

The keystore path is not just configured but enforced: the release workflow
refuses to build the APKs at all when the keystore secret is absent, checks
the certificate fingerprint of the restored keystore against the expected
permanent Fress key, and signs with `apksigner`. On the v1.0.9-beta run the
"Restore the persistent signing keystore" step executed and all five APKs
(universal, arm64, arm, x64, x86) were signed with it. Consequence for
users: release-to-release APK upgrades install normally (same signing
identity), while an APK obtained from any other build source will refuse to
update-over-install — Android enforcing the same-signer rule.

## In-app updates: the Tauri updater key

Fress ships two update paths. Today the app checks GitHub Releases itself,
downloads the matching installer and verifies its SHA256 against
`SHA256SUMS.txt` (see `src/lib/selfUpdate.ts`); since the checksum document
became readable through the native `fetch_self_update_text` command, that
verification actually runs on every platform-matched update, and an update
whose checksum cannot be established is NOT downloaded — the app opens the
releases page instead.

The SECOND layer is artifact authenticity, and it is part of the real
delivery flow. The delivery lifecycle in
`src/features/selfUpdate/updateDelivery.ts` runs every in-app update
through three gates and only calls the result "verified" when all three
pass:

1. **Plan gate (fail-closed, shared by the header pill and the footer
   button):** the release must carry a platform-matched asset, a published
   SHA-256 entry for its exact filename in `SHA256SUMS.txt`, AND a
   well-formed minisign signature sidecar (`<asset>.sig`) for that exact
   filename. A missing sidecar routes the update to the official Releases
   page with the explicit "unsigned" reason — it is never delivered
   in-app and never described as publisher-authenticated.
2. **Checksum gate (native download engine):** the file streams through the
   download manager with the published digest attached; a mismatch deletes
   the file and reports an integrity failure instead of a completed
   download.
3. **Signature gate (native verifier, post-download):** once the engine
   reports completion — and before any verified state is rendered — the
   flow invokes `verify_self_update_signature` with the ENGINE-reported
   completion path (correlated through the download manager's own
   id→url records, never a UI label) and the sidecar document fetched in
   step 1. A rejection is an explained failure with the Releases-page
   fallback; it is never a verified outcome and never "no update".

The app embeds the updater public key at compile time; the native
`verify_self_update_signature` command (`src-tauri/src/lib.rs`) streams the
completed file through minisign verification against it — and only accepts
paths the download engine itself committed to its completed-artifact
registry, so the command is not a general filesystem API — refusing legacy
(non-prehashed) signatures, and returns ok/error without ever exposing file
contents. The command is unit-tested (genuine signature verifies; one
flipped bit, one extra byte, a foreign key and malformed documents all fail
closed) and exercised by the real application flow, with frontend
integration tests (`selfUpdateDelivery.test.ts`) and E2E Workflow I
contracts covering the verified path, the rejected-signature fallback,
cancellation, download failure and signature-fetch retry.

The header pill tells the same truth as the delivery state: busy phases
name the live step (downloading / checking checksum / verifying
signature), only the all-gates-passed state says "ready", a retryable
failure offers the retry, and a plan-level refusal ('no-asset' |
'unverifiable' | 'unsigned') flips the pill to the see-releases label —
it never reverts to the plain "Update v…" available label, which would
imply in-app delivery is still on the table after the planner proved it
is not. The reason itself is explained by the localized refusal toast
that accompanies the fallback, and a cancelled transfer returns the pill
to its quiet available state (a cancellation is a user decision, not a
failure).

What verification does NOT do: a passing signature establishes trust in the
bytes. The app never auto-launches the installer — the verified state offers
"reveal the file", and the user decides when (and whether) to run it.

The release pipeline is already wired for signatures: every `tauri-action`
build in `release.yml` produces the updater artifacts (`latest.json`,
`.AppImage.sig`, `*-setup.exe.sig`) when the repository has the update key
configured. **The keypair was generated and the secrets were set on
2026-09-22**, so every recent release ships the manifests and signatures
automatically.

Current status at a glance (evidence: release v1.0.9-beta, published
2026-10-12, and its CI run):

| Item | State |
| --- | --- |
| Private key | `TAURI_SIGNING_PRIVATE_KEY` secret (backup in the private `fress-state` repo, `updater-key-backup/`) |
| Key password | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret (same backup) |
| Public key | `fress-updater.key.pub` in this repo, embedded into every app build via `include_str!`, also recorded below |
| Updater signatures on releases | Windows installers (regenerated post-build) and Linux bundles; **the MSI, macOS dmgs, portable zips and APKs ship without updater artifacts** — `latest.json` therefore carries no darwin or android entries |
| First released build that embeds the key | v1.0.8-beta (verification command present, not yet wired into the delivery flow) |
| First released build that verifies in the delivery flow | v1.0.9-beta (key embedded + three-gate delivery wired) |
| In-app signature verification | native command + real delivery-flow wiring (three-gate plan → verified download → post-download verify); unsigned platforms route to the Releases page |
| In-app updater plugin | not wired yet (the plugin would replace the app's own flow; see the endpoint note below) |

Public key (safe to distribute; embedded in the binary at compile time from
`fress-updater.key.pub`):

```text
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU2MzhDNjgxMjNGQjYzM0IKUldRN1kvc2pnY1k0VnNHRXkyL2UycG5NZFhvdUFLM3I0YXNsYTN4c2sxUlc4YVUyRktUdDM4Vk4K
```

### Release signature audit (v1.0.9-beta, verified 2026-10-13)

Every artifact class on the newest published release was checked from the
release's actual published bytes. Method: all downloaded artifacts were
verified against the release's `SHA256SUMS.txt`; every signed artifact was
additionally verified against the repository's published public key with an
INDEPENDENT implementation (pure-Python RFC 8032 Ed25519 + BLAKE2b-512
prehash over the exact artifact bytes, self-checked against the RFC 8032 test
vectors before touching release data — the same algorithm the app's
`verify_signature_over_file` runs). The Windows installers' PE certificate
tables were inspected for Authenticode. What was checked:

| Artifact (exact name on v1.0.9-beta) | SHA-256 vs `SHA256SUMS.txt` | Updater `.sig` | Minisign verification | Authenticode |
| --- | --- | --- | --- | --- |
| `Fress_1.0.9-beta_x64-setup.exe` | match | yes | **PASS** | no certificate table |
| `Fress_1.0.9-beta_arm64-setup.exe` | match | yes | **PASS** | no certificate table |
| `Fress_1.0.9-beta_amd64.AppImage` | match | yes | **PASS** | n/a |
| `Fress_1.0.9-beta_amd64.deb` | match | yes | **PASS** | n/a |
| `Fress-1.0.9-beta-1.x86_64.rpm` | match | yes | **PASS** | n/a |
| `Fress_1.0.9-beta_x64_en-US.msi` | match | no | n/a | no signature stream |
| `Fress_1.0.9-beta_x64-portable.zip` | match | no | n/a | n/a (and never Authenticode-signed either) |
| `Fress_1.0.9-beta_arm64-portable.zip` | on release | no | n/a | n/a |
| `Fress_1.0.9-beta_x64.dmg` / `_aarch64.dmg` | match / on release | no | n/a | n/a |
| `Fress_1.0.9-beta_{universal,arm64,arm,x64,x86}.apk` | on release | no | n/a | verified by Android's package installer (same-signer rule) instead |

Rows marked "on release" were present on the release and are covered by CI's
`verify-release` job, which re-hashes every uploaded asset against
`SHA256SUMS.txt` before the release is downloadable (that job passed on the
v1.0.9-beta run); this audit additionally re-downloaded and re-hashed the
rows marked "match" directly.

`latest.json` on v1.0.9-beta carries exactly eight platform entries —
windows-x86_64(-nsis), windows-aarch64(-nsis), linux-x86_64(-appimage/-deb/
-rpm) — all with versioned `releases/download/v1.0.9-beta/...` URLs and no
darwin/android entries, and `SHA256SUMS.txt` covers the other 21 assets with
no drift. The five signed artifacts verify byte-for-byte end to end. This
proves the RELEASE pipeline's signatures are genuine and that the in-app
verifier's algorithm accepts the real artifacts. Also note what a signature
establishes and what it does not: the macOS dmgs and Android APKs are NOT
delivered through the in-app path (no publisher signature exists for them),
and a SHA-256 match remains an integrity guarantee, not publisher proof.
(Earlier audits: v1.0.7-beta's five signed artifacts and the v1.0.8-beta
artifacts passed the same verification when they were the newest releases;
the per-artifact signing policy has not changed since.)

### Notes for the release pipeline (hand-off items, not documentation gaps)

1. **macOS updater pair gap (unchanged).** The macOS build jobs pass the
   updater config when the key secret exists, but every release so far
   (through v1.0.9-beta) has shipped dmgs WITHOUT the `.app.tar.gz` + `.sig`
   updater pair, so the manifest job has no darwin entries to embed. If
   macOS updates are ever to be delivered in-app, that gap needs a CI
   investigation (Agent 6's workstream) and `release.yml` must publish
   minisign `.sig` sidecars for the dmg artifacts under the exact
   `<asset>.sig` naming convention (the in-app updater binds each signature
   to the artifact's exact filename). The same applies to the APKs.
2. **VirusTotal links do not land on the release pages.** The `virustotal`
   job runs (its secret is configured) but its scan-links section is absent
   from every published release body through v1.0.9-beta. The docs above
   therefore do not promise those links; the CI job's body-edit step needs
   a look (Agent 6).
3. **Per-artifact signature policy is unchanged:** Windows setup exes and
   the Linux bundles are signed; everything else is intentionally not, and
   those platforms correctly route to the Releases page.

### Rotation caveats

The deployed keypair was generated 2026-09-22. Builds since **v1.0.8-beta**
embed the public key, and builds since **v1.0.9-beta** enforce its
signature in the real delivery flow — so rotation is no longer free: for
every installed app at v1.0.8 or newer, a key change means artifacts signed
by the new key are refused until each user performs one manual reinstall
(older installs update to a new release first and inherit the same
migration). To rotate (also the recovery procedure if the key is ever
exposed):

```bash
npx tauri signer generate -w fress-updater.key
```

You are asked for an optional password (recommended). Then add two repository
secrets under **Settings -> Secrets and variables -> Actions**:

| Secret | Content |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the full content of `fress-updater.key` (it is a text file) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you chose (empty if none) |

Back the key up with the same care as the Windows `.pfx` and the Android
keystore. If it is lost, a new key can be generated, but already-installed
updaters will not trust artifacts signed by the new key, that migration needs
one manual reinstall for everyone.

### What CI does with it

- `updater-overrides.json` (repo root) turns on `bundle.createUpdaterArtifacts`
 via `--config`, but only when the key secret exists. On macOS and Linux the
 `tauri-action` builds pass it conditionally and sign the updater bundles at
 build time - safe there, because nothing rewrites those binaries afterwards.
 Observed so far (through v1.0.9-beta): the Linux releases carry their `.sig`
 files, while the macOS releases ship dmgs WITHOUT the `.app.tar.gz` + `.sig`
 updater pair, so the manifest job has no darwin entries to embed (see the
 pipeline notes above) — until then macOS updates flow through the
 releases-page fallback, never through `latest.json`.
- The Windows jobs build WITHOUT updater artifacts: Authenticode (Trusted
 Signing or the .pfx) signs the installer AFTER the build, rewriting the exe
 bytes, so a build-time `.sig` would no longer match the shipped installer.
 Instead, the last step of each Windows job runs `npx tauri signer sign` over
 the FINAL (signed or unsigned) installer and uploads that `.sig`. With no
 certificate configured today, that signature describes the unsigned
 installer exactly as published.
- The `updater-manifest` job then assembles `latest.json` from the `.sig`
 files that are actually on the release - Windows entries from the
 regenerated signatures, Linux entries from tauri-action's - and uploads it
 before the checksum pass, so `SHA256SUMS.txt` covers the manifest too.
 Its platform URLs use the versioned `releases/download/<tag>/<asset>` form,
 not the `releases/latest/download/<asset>` alias, which only resolves for
 stable releases and would 404 while Fress publishes prereleases (confirmed
 on v1.0.9-beta: every `latest.json` URL is versioned).

### Delivery wiring: landed

The layers now look like this:

- **Release signing (done):** `updater-overrides.json` + the key secret make
 CI produce `.sig` sidecars and `latest.json` for the Windows installers and
 Linux bundles; the signatures on v1.0.9-beta verify against the published
 key (see the audit above).
- **In-app verification (done, tested):** the public key is embedded in the
 binary at compile time and the native `verify_self_update_signature`
 command verifies a completed download's bytes against a release's `.sig`
 document — scoped to artifacts the engine itself committed.
- **Delivery wiring (done):** the update-delivery lifecycle
 (`src/features/selfUpdate/updateDelivery.ts`) runs the three-gate plan
 (platform asset + published checksum + signature sidecar for the exact
 filename), fetches the sidecar through the authorized native text path,
 downloads through the existing verified download engine, and invokes the
 native verifier against the completed artifact BEFORE any verified state is
 rendered. Missing/unreachable/malformed signatures, checksum failures,
 download failures and cancellations all have explicit, distinct UI states
 and localized messages. A plan-gate refusal or a signature rejection
 routes to the official Releases page with the reason attached; a
 transfer-level checksum failure stays a retryable download-manager
 failure (a fresh transfer re-downloads and re-checks, and the failure
 hint names the Releases page for a persistently corrupt release).
 Verification success reveals the artifact — it never auto-launches it.

The dormant `plugins.updater` block in `tauri.conf.json` remains future
config for the Tauri updater PLUGIN (a different, flow-replacing mechanism);
nothing in the release pipeline or the app registers that plugin —
signatures are produced from the key secret alone. Two notes for when that
plugin gets wired:

- The endpoint points at GitHub's `releases/latest/download/latest.json`
 alias, which only resolves for STABLE releases. While Fress publishes
 alpha/beta prereleases, that alias 404s, use a per-channel manifest
 (a branch file or a tiny redirect service listing the newest
 prerelease) or ship a stable release. The per-release `latest.json`
 assets themselves already use versioned URLs that always resolve.

### Sequencing: Authenticode and the updater signatures

Authenticode signing (SignPath, Azure Trusted Signing, or the .pfx) modifies
the exe bytes, so any minisign `.sig` generated before it no longer matches
the shipped installer. `release.yml` therefore orders the Windows pipeline
build -> Authenticode sign -> `npx tauri signer sign` over the signed binary
-> upload, with the `updater-manifest` job assembling `latest.json` last.
This holds in every configuration - with or without a certificate - so the
signatures on a release always describe the exact bytes published next to
them. The same caution applies if you ever sign the Linux AppImage or rework
the macOS flow outside the bundler: regenerate the `.sig` after anything that
rewrites the artifact.

## macOS: signing and notarization

Current status (evidence: the v1.0.9-beta release run): **the Apple
credentials are not configured**, so both macOS build jobs ran their
unsigned fallback steps — the published dmgs are unsigned AND unnotarized.
Practical effect for users: the first launch of the app needs a right-click
-> Open confirmation, newer macOS versions may refuse outright from Finder
until then, and no in-app delivery exists for macOS (no updater sidecar
either). Everything below describes the wiring that activates when the
secrets are added; it has not run in production yet, and this document will
say so plainly once it has.

Gatekeeper treats unsigned apps the way Windows treats unknown publishers:
the first launch of an unsigned or unnotarized dmg asks for a right-click ->
Open confirmation, and newer macOS versions may refuse outright from Finder.

A fully quiet first launch needs two things, and both come from an Apple
Developer account (USD 99 per year, the only paid piece of the macOS path):

1. A **Developer ID Application** certificate, which signs the app so macOS
 knows who built it.
2. A **notarization** pass, where Apple scans the signed app and staples an
 approval ticket to it.

The release workflow already carries the wiring: when the following secrets
exist on the repo, `tauri-action` signs both dmg builds and notarizes them
automatically. When they do not exist, the workflow still ships unsigned dmgs
and nothing else changes.

| Secret | Where it comes from |
| --- | --- |
| `APPLE_CERTIFICATE` | the Developer ID P12, base64 encoded (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | the password chosen when exporting the P12 |
| `APPLE_SIGNING_IDENTITY` | exactly `Developer ID Application: <name> (<team id>)` |
| `APPLE_ID` | the Apple ID email used for notarization |
| `APPLE_PASSWORD` | an app-specific password for that Apple ID (appleid.apple.com, Sign-In and Security) |
| `APPLE_TEAM_ID` | the 10-character team id, visible in the Apple Developer account |

Alternative for step 2: an App Store Connect API key instead of the Apple ID
app password (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`);
either route notarizes, pick whichever is already available.

After the secrets are in, push a version tag and check the macOS build logs
for the signing and notarization steps. A notarized dmg opens with a plain
double-click, and `spctl -a -v /Applications/Fress.app` should report
"accepted".
