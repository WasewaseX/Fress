# Signing on Windows and macOS

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

### The persistent publisher certificate (current CI default)

CI no longer generates a throwaway self-signed certificate per release — a
fresh identity every build proves nothing and accumulates no reputation with
Defender or SmartScreen. Instead, one certificate is provided as repository
secrets and reused for every release:

- `WINDOWS_PFX_B64` — the `.pfx` (certificate + private key), base64-encoded
- `WINDOWS_PFX_PASSWORD` — the .pfx export password

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
to the export password. Every Windows build (x64 + ARM64, installer +
portable) is then signed with the same publisher identity.

Honesty note: a self-signed publisher still shows "Unknown publisher" — only
a certificate chaining to a trusted root (SignPath Foundation below, Azure
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
Windows binaries — unsigned installers that download other installers are a
classic trigger, and release builds were additionally stripped (`strip = true`
in Cargo.toml), which makes them look even more packer-like. Countermeasures
in place: release builds are unstripped, the signature is persistent, Fress is
distributed only through GitHub Releases with SHA256SUMS.txt, and a
`virustotal` CI job (needs the `VIRUSTOTAL_API_KEY` secret, free account)
attaches multi-engine scan links to every release. If a build is still
flagged, submit it at <https://www.microsoft.com/en-us/wdsi/filesubmission>
and check the SHA256 against `SHA256SUMS.txt` before running anything.

### Android: the persistent keystore

Same rule as Windows: the keystore is stored once as repository secret
`ANDROID_KEYSTORE_B64` (base64 of `fress.keystore`, alias `fress`, store and
key password `fressandroid`) and reused for every release. A fresh keystore
per release would make Android refuse update-over-install (signature
mismatch), forcing users to uninstall first.

## In-app updates: the Tauri updater key

Fress ships two update paths. Today the app checks GitHub Releases itself,
downloads the matching installer and verifies its SHA256 against
`SHA256SUMS.txt` (see `src/lib/selfUpdate.ts`). The second path is the Tauri
updater: a signed `latest.json` manifest plus `.sig` signatures that a future
in-app updater verifies with minisign before installing anything — a bad or
tampered download is refused and the old version keeps running (rollback).

The release pipeline is already wired for it: every `tauri-action` build in
`release.yml` produces the updater artifacts (`latest.json`, `.AppImage.sig`,
`.app.tar.gz.sig`, `*-setup.exe.sig`) when the repository has the update key
configured. **The keypair was generated and the secrets were set on
2026-09-22**, so from the next release on, the manifests and signatures ship
automatically.

Current status at a glance:

| Item | State |
| --- | --- |
| Private key | `TAURI_SIGNING_PRIVATE_KEY` secret (backup in the private `fress-state` repo, `updater-key-backup/`) |
| Key password | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret (same backup) |
| Public key | `fress-updater.key.pub` in this repo, also recorded below |
| In-app updater plugin | not wired yet — the remaining step |

Public key (safe to distribute; embed it in `tauri.conf.json` when the
updater plugin gets wired):

```text
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU2MzhDNjgxMjNGQjYzM0IKUldRN1kvc2pnY1k0VnNHRXkyL2UycG5NZFhvdUFLM3I0YXNsYTN4c2sxUlc4YVUyRktUdDM4Vk4K
```

### Generating a replacement key (rotation)

The deployed keypair was generated 2026-09-22. Because no released app embeds
its public key yet, it can still be rotated for free any time before the
updater plugin ships. To rotate (also the recovery procedure if the key is
ever exposed):

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
updaters will not trust artifacts signed by the new key — that migration needs
one manual reinstall for everyone.

### What CI does with it

- `updater-overrides.json` (repo root) turns on `bundle.createUpdaterArtifacts`
  via `--config`, but only when the key secret exists. On macOS and Linux the
  `tauri-action` builds pass it conditionally and sign the updater bundles at
  build time - safe there, because nothing rewrites those binaries afterwards.
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

### Remaining step: wire the in-app plugin

The **config** half is done: `tauri.conf.json` carries the
`plugins.updater` block (public key above + the releases endpoint), which
is what the release bundler needs to produce signed updater artifacts.
Still missing is the **runtime** half: the `tauri-plugin-updater`
dependency in `src-tauri/Cargo.toml`, its `.plugin(...)` registration in
`lib.rs`, and the capability permission. Until that ships, updates are
delivered by the built-in update check (in-app download + SHA-256
verification against `SHA256SUMS.txt`) and the manifests/signatures in
each release simply wait for it.

Two notes for when the runtime plugin gets wired:

- The endpoint points at GitHub's `releases/latest/download/latest.json`
  alias, which only resolves for STABLE releases. While Fress publishes
  alpha/beta prereleases, that alias 404s — use a per-channel manifest
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
