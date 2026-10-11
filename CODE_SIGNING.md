# Signing on Windows and macOS

## What each release mechanism actually establishes

Four independent mechanisms touch a Fress release, and they answer four
different questions. Do not conflate them:

| Mechanism | Question it answers | Establishes | Consumed by | Current status (evidence: release v1.0.7-beta) |
| --- | --- | --- | --- | --- |
| `SHA256SUMS.txt` | "Is this file byte-for-byte what CI built?" | Integrity: a checksum comparison against CI's manifest, delivered over HTTPS from the release page | The in-app self-update (verifies before offering the installer) and any manual `sha256sum -c` | On every release; verified in-app via the native `fetch_self_update_text` command, fail-closed (`planUpdateDelivery`) |
| Minisign `.sig` + `latest.json` + embedded public key | "Who authorized this updater artifact?" | Authenticity: a signature that only the holder of the private key (a repository secret) can produce | The native `verify_self_update_signature` command (implemented and tested in-app; delivery-UI wiring pending — see below), and the Tauri updater plugin (future) | Produced for the Windows installers and Linux bundles; macOS dmgs, the MSI, portable zips and all APKs ship WITHOUT updater artifacts |
| Authenticode (Windows) | "Is the publisher accountable to a certificate authority Windows trusts?" | Publisher identity for Explorer/SmartScreen; tamper evidence tied to that identity | Windows itself at install time | **Not applied today** — no signing secrets are configured, and the published installers carry no Authenticode certificate table. This is why Windows shows "Unknown publisher" |
| APK signature (Android) | "Will Android accept this APK as an update of the installed app?" | OS-enforced same-signer rule: the package installer refuses an update signed with a different key | Android's package installer at install time | Applied by CI from the persistent keystore secret (see the Android section below) |

A checksum proves the file matches the manifest but not who made the manifest;
a minisign signature proves who authorized the artifact but is only visible to
the verifier that embeds the public key; Authenticode proves a publisher
identity to Windows but says nothing about update integrity by itself; the
Android package signature is enforced by the OS on update-over-install and is
unrelated to the other three. A SHA-256 match also says nothing about
publisher identity if BOTH the file and the manifest came from the same
compromised release account — that is exactly the gap the minisign layer
closes for the artifacts it covers.

## Windows: signing and the "Unknown Publisher" warning

### Why Windows shows the blue warning

When you run the installer, Windows checks whether the publisher is vouched
for by a certificate authority it already trusts.

- No signature at all: Windows says "Unknown Publisher".
- A self-signed signature (what CI applies today): still "Unknown Publisher",
 because the certificate vouches for itself. No build flag or setting changes
 this. The warning is Windows doing its job.

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
(including v1.0.6-beta) actually shipped in:

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
in place: release builds are unstripped, the signature is persistent, Fress is
distributed only through GitHub Releases with SHA256SUMS.txt, and a
`virustotal` CI job (needs the `VIRUSTOTAL_API_KEY` secret, free account)
attaches multi-engine scan links to every release. If a build is still
flagged, submit it at <https://www.microsoft.com/en-us/wdsi/filesubmission>
and check the SHA256 against `SHA256SUMS.txt` before running anything.

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

## In-app updates: the Tauri updater key

Fress ships two update paths. Today the app checks GitHub Releases itself,
downloads the matching installer and verifies its SHA256 against
`SHA256SUMS.txt` (see `src/lib/selfUpdate.ts`); since the checksum document
became readable through the native `fetch_self_update_text` command, that
verification actually runs on every platform-matched update, and an update
whose checksum cannot be established is NOT downloaded — the app opens the
releases page instead.

The SECOND layer is artifact authenticity. The app now embeds the updater
public key at compile time and ships the native
`verify_self_update_signature` command (`src-tauri/src/lib.rs`): it streams
a completed download through minisign verification against the embedded key,
refusing legacy (non-prehashed) signatures, and returns ok/error without
ever exposing file contents. The command is implemented and unit-tested
(genuine signature verifies; one flipped bit, one extra byte, a foreign key
and malformed documents all fail closed) — but the delivery UI does not call
it yet, so the IN-APP flow currently verifies integrity (SHA-256), not yet
publisher authenticity. Wiring it into the update-delivery decision touches
`src/features/selfUpdate/**`, which is outside the updater-trust workstream's
file ownership; until that wiring lands, neither the UI nor this document
claims end-to-end in-app publisher authentication.

The release pipeline is already wired for signatures: every `tauri-action`
build in `release.yml` produces the updater artifacts (`latest.json`,
`.AppImage.sig`, `*-setup.exe.sig`) when the repository has the update key
configured. **The keypair was generated and the secrets were set on
2026-09-22**, so every recent release ships the manifests and signatures
automatically.

Current status at a glance (evidence: release v1.0.7-beta):

| Item | State |
| --- | --- |
| Private key | `TAURI_SIGNING_PRIVATE_KEY` secret (backup in the private `fress-state` repo, `updater-key-backup/`) |
| Key password | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret (same backup) |
| Public key | `fress-updater.key.pub` in this repo, embedded into every app build via `include_str!`, also recorded below |
| Updater signatures on releases | Windows installers (regenerated post-build) and Linux bundles; **macOS dmgs, the MSI, portable zips and APKs ship without updater artifacts** — `latest.json` therefore carries no darwin entries |
| In-app signature verification | native `verify_self_update_signature` command: implemented, unit-tested, **delivery-UI wiring pending** |
| In-app updater plugin | not wired yet (the plugin would replace the app's own flow; see the endpoint note below) |

Public key (safe to distribute; embedded in the binary at compile time from
`fress-updater.key.pub`):

```text
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU2MzhDNjgxMjNGQjYzM0IKUldRN1kvc2pnY1k0VnNHRXkyL2UycG5NZFhvdUFLM3I0YXNsYTN4c2sxUlc4YVUyRktUdDM4Vk4K
```

### Release signature audit (v1.0.7-beta, verified 2026-10-12)

Every updater artifact on the v1.0.7-beta release was downloaded in full and
verified against the repository's published public key using the EXACT
verification code the app ships (`verify_signature_over_file`):

| Artifact | Updater signature | Verification against `fress-updater.key.pub` |
| --- | --- | --- |
| `Fress_1.0.7-beta_x64-setup.exe` | yes | **PASS** |
| `Fress_1.0.7-beta_arm64-setup.exe` | yes | **PASS** |
| `Fress_1.0.7-beta_amd64.AppImage` | yes | **PASS** |
| `Fress_1.0.7-beta_amd64.deb` | yes | **PASS** |
| `Fress-1.0.7-beta-1.x86_64.rpm` | yes | **PASS** |
| `Fress_1.0.7-beta_x64.dmg` / `_aarch64.dmg` | no | n/a — no updater artifact produced |
| `Fress_1.0.7-beta_x64_en-US.msi` | no | n/a |
| `*_portable.zip` | no | n/a (and never Authenticode-signed either) |
| `*_apk` (arm/arm64/x64/x86/universal) | no | verified by Android's package installer (same-signer rule) instead |

The five signed artifacts verify byte-for-byte end to end. This proves the
RELEASE pipeline's signatures are genuine and that the in-app verifier works
against real artifacts; it does NOT yet prove the in-app DELIVERY flow calls
the verifier before offering an update — that is the pending wiring above.
Also note what a signature establishes and what it does not: the macOS dmgs
and Android APKs are delivered through the checksum-verified path, and a
SHA-256 match remains an integrity guarantee, not publisher proof.

### Rotation caveats (updated)

The deployed keypair was generated 2026-09-22. Because no RELEASED app build
has embedded its public key yet (the verification command lands with the
next build that includes it), rotation is still cheap today but becomes a
one-manual-reinstall migration for every user once apps with the embedded
key ship. To rotate (also the recovery procedure if the key is ever exposed):

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
 Observed so far: the Linux releases carry their `.sig` files, while the macOS
 releases (v1.0.4–v1.0.6-beta) shipped dmgs WITHOUT the `.app.tar.gz` + `.sig`
 updater pair, so the manifest job had no darwin entries to embed. When wiring
 the plugin for macOS users becomes relevant, that gap needs a CI investigation
 (Agent 6's workstream) — until then macOS updates flow through the checksum-
 verified manual path, never through `latest.json`.
- The Windows jobs build WITHOUT updater artifacts: Authenticode (Trusted
 Signing or the .pfx) signs the installer AFTER the build, rewriting the exe
 bytes, so a build-time `.sig` would no longer match the shipped installer.
 Instead, the last step of each Windows job runs `npx tauri signer sign` over
 the FINAL (signed or unsigned) installer and uploads that `.sig`.
- The `updater-manifest` job then assembles `latest.json` from the `.sig`
 files that are actually on the release - Windows entries from the
 regenerated signatures, Linux entries from tauri-action's - and uploads it
 before the checksum pass, so `SHA256SUMS.txt` covers the manifest too.
 Its platform URLs use the versioned `releases/download/<tag>/<asset>` form,
 not the `releases/latest/download/<asset>` alias, which only resolves for
 stable releases and would 404 while Fress publishes prereleases.

### Remaining step: wire verification into the delivery decision

The layers now look like this:

- **Release signing (done):** `updater-overrides.json` + the key secret make
 CI produce `.sig` sidecars and `latest.json` for the Windows installers and
 Linux bundles; the v1.0.7-beta signatures all verify against the published
 key (see the audit above).
- **In-app verification (done, tested):** the public key is embedded in the
 binary at compile time and the native `verify_self_update_signature`
 command verifies a completed download's bytes against a release's `.sig`
 document.
- **Delivery wiring (pending):** the update-delivery decision
 (`planUpdateDelivery` + `src/features/selfUpdate/**`) does not call the
 command yet, so an in-app update is currently gated on SHA-256 only. The
 wiring change — fetch the `.sig` sidecar through the existing
 `fetch_self_update_text` policy (its host allowlist already covers the
 release-asset hosts), verify after the download completes, and refuse/
 fall back to the releases page on any signature failure — touches files
 outside the updater-trust workstream's ownership and is explicitly left
 for a coordinated follow-up.

The dormant `plugins.updater` block in `tauri.conf.json` remains future
config for the Tauri updater PLUGIN (a different, flow-replacing mechanism);
nothing in the release pipeline reads it — signatures are produced from the
key secret alone. Two notes for when that plugin gets wired:

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

Gatekeeper treats unsigned apps the same way Windows treats unknown publishers:
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
