<!-- ============================================================================
STATUS: stable-release edition (Agent 3 release qualification, 2026-10-14).
The stable v1.0.0 release IS PUBLISHED (2026-10-14T16:40Z, prerelease=false,
22 assets, commit 78d5e8ff8e1bc38ca8789539da005fdea4b15613, Release workflow
run #43 = success). The v1.0.0 audit section below is FILLED from the actual
published bytes: all 22 assets downloaded and re-hashed (21/21 SHA256SUMS.txt
entries match, no orphans), scripts/ci/verify-release-artifacts.py exit 0 on
the downloaded bytes, an independent pure-Python RFC 8032 Ed25519
implementation verifies all 5 minisign sidecars (negative control rejected),
latest.json = version 1.0.0 with the eight windows-*/linux-* entries. The
historical beta audits below are kept as history; never label a beta audit as
an audit of v1.0.0.
============================================================================ -->

# Release signing and verification

This document records, per platform and per artifact, what each release
actually carries: which files are signed, by what, what each layer proves,
and where Fress intentionally falls back to the official Releases page.

It is scoped to the published releases. The stable **v1.0.0** release and the
beta track are separate channels: the per-artifact signing policy below
applies to both, and each release's own audit section below records which
release's actual bytes it was proven on.

## What each release mechanism actually establishes

Four independent mechanisms touch a Fress release, and they answer four
different questions. Do not conflate them:

| Mechanism | Question it answers | Establishes | Consumed by | Current status (evidence: release v1.0.0, byte-audited 2026-10-14; the beta-track history below is preserved) |
| --- | --- | --- | --- | --- |
| `SHA256SUMS.txt` | "Is this file byte-for-byte what CI built?" | Integrity: a checksum comparison against CI's manifest, delivered over HTTPS from the release page | The in-app self-update (verifies before offering the installer) and any manual `sha256sum -c` | On every release (back to v1.0.0-beta); since v1.0.7-beta the in-app updater reads it through the native `fetch_self_update_text` command, fail-closed (`planUpdateDelivery`); all 21 entries matched the re-hashed published bytes on v1.0.0 (2026-10-14) and on v1.0.12-beta |
| Minisign `.sig` + `latest.json` + embedded public key | "Who authorized this updater artifact?" | Authenticity: a signature that only the holder of the private key (a repository secret) can produce | The native `verify_self_update_signature` command, called by the real delivery flow (`src/features/selfUpdate/updateDelivery.ts`) after every completed update download and before any "verified" state is shown | Produced for the Windows installers and Linux bundles; the MSI, macOS dmgs, portable zips and all APKs ship WITHOUT updater artifacts — those platforms are therefore NOT delivered in-app (releases-page fallback) |
| Authenticode (Windows) | "Is the publisher accountable to a certificate authority Windows trusts?" | Publisher identity for Explorer/SmartScreen; tamper evidence tied to that identity | Windows itself at install time | **Not applied today** — no signing secrets are configured (the v1.0.0 build ran the same workflow "no signing certificate" path as every beta, and the published installers carry no Authenticode certificate table — byte-verified on v1.0.0: both setup exes' PE certificate tables are empty, the MSI has no digital-signature stream). This is why Windows shows "Unknown publisher" |
| APK signature (Android) | "Will Android accept this APK as an update of the installed app?" | OS-enforced same-signer rule: the package installer refuses an update signed with a different key | Android's package installer at install time | Applied by CI from the persistent keystore secret; on the v1.0.12-beta run and again on the v1.0.0 run CI restored the persistent keystore and signed all five APKs with it (v1.0.0 APK bytes carry the v2/v3 signing block) |

A checksum proves the file matches the manifest but not who made the manifest;
a minisign signature proves who authorized the artifact but is only visible to
the verifier that embeds the public key; Authenticode proves a publisher
identity to Windows but says nothing about update integrity by itself; the
Android package signature is enforced by the OS on update-over-install and is
unrelated to the other three. A SHA-256 match also says nothing about
publisher identity if BOTH the file and the manifest came from the same
compromised release account — that is exactly the gap the minisign layer
closes for the artifacts it covers. **A checksum match is an integrity
guarantee, never publisher identity.**

## Verify a download manually

```bash
sha256sum -c SHA256SUMS.txt        # integrity: matches what CI built
```

A passing checksum tells you the file is exactly the bytes CI published — it
does NOT tell you who published them (if the release account itself were
compromised, both the file and the manifest would match). A checksum match is
not publisher identity. The updater signatures close that gap for the
artifacts they cover; if you want the same publisher check the app performs,
verify the minisign signature yourself.

One format note first: the `.sig` sidecars on the releases and the checked-in
`fress-updater.key.pub` are stored BASE64-WRAPPED (Tauri's signature format —
the same bytes the in-app verifier consumes after decoding), not as plain
minisign documents, so decode both before handing them to the `minisign`
CLI:

<!-- The decode step was byte-verified during the 2026-10-14 v1.0.0 audit;
the `minisign -V` invocation itself has still NOT been executed in this
sandbox (no minisign binary) — on v1.0.0 the equivalent verification was done
by the repository's verifier plus an independent pure-Python RFC 8032
Ed25519 implementation (negative control rejected); smoke-test the CLI
invocation once on a machine with minisign, or use the OpenSSL recipe below,
which was proven end-to-end against the published v1.0.12-beta bytes. -->

```bash
# 1. decode the sidecar and the public key to plain minisign documents
base64 -d Fress_1.0.0_x64-setup.exe.sig > /tmp/fress-installer.sig
base64 -d fress-updater.key.pub         > /tmp/fress-updater.pub

# 2. verify the exact installer bytes against the decoded signature
minisign -V -p /tmp/fress-updater.pub -s /tmp/fress-installer.sig \
  -m Fress_1.0.0_x64-setup.exe
```

Alternative without the `minisign` CLI (proven against the published
v1.0.12-beta bytes with two independent implementations — the repository's
own `scripts/ci/verify-release-artifacts.py` verifier and a raw OpenSSL
Ed25519 check): the release sidecars are **prehashed** minisign signatures —
an Ed25519 signature over `BLAKE2b-64(artifact bytes)`, produced by the
production key `5638C68123FB633B`:

```bash
# Ed25519 verify over BLAKE2b-64(file bytes) with OpenSSL 3.x
base64 -d fress-updater.key.pub | sed -n 2p \
  | base64 -d | tail -c 32 > /tmp/fress-ed25519.bin          # raw 32-byte key
python3 -c "import hashlib,sys; sys.stdout.buffer.write(hashlib.blake2b(open('Fress_1.0.0_x64-setup.exe','rb').read(), digest_size=64).digest())" > /tmp/fress-prehash.bin
base64 -d Fress_1.0.0_x64-setup.exe.sig | sed -n 2p \
  | base64 -d | tail -c 64 > /tmp/fress-sig.bin              # raw 64-byte signature
openssl pkey -pubin -inform DER \
  -in <(printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; cat /tmp/fress-ed25519.bin) \
  -out /tmp/fress-ed25519.pem
openssl pkeyutl -verify -pubin -inkey /tmp/fress-ed25519.pem \
  -rawin -sigfile /tmp/fress-sig.bin -in /tmp/fress-prehash.bin
# expected output: "Signature Verified Successfully"
```

Or simply run the repository's own release auditor over a directory holding
the downloaded release files — it re-hashes everything, cross-checks
`latest.json` against the assets and sidecars, and minisign-verifies every
signed artifact with the production key (self-tested against RFC 8032 before
touching release data):

```bash
python3 scripts/ci/verify-release-artifacts.py <assets-dir> v1.0.0 1.0.0 WasewaseX/Fress
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

The public key file is byte-identical to the one verified against the
v1.0.0 signatures (key id `5638C68123FB633B`; the 2026-10-14 audit compared
the embedded `tauri.conf.json` key with `fress-updater.key.pub` byte-for-byte
and verified all five v1.0.0 sidecars against it). If the key ever rotates,
this document's rotation section and the manual
commands must be updated to the new key and the migration cost re-stated.

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
| Already released in the form to be signed | v1.0.0-beta (and the whole 1.0.x line since) |
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
(through v1.0.12-beta and v1.0.0 — the v1.0.0 run's Windows jobs show the
"No signing certificate configured" step succeeding with every
Authenticode-signing step skipped) actually shipped in:

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
`virustotal` CI job would scan every release asset when the
`VIRUSTOTAL_API_KEY` secret is set. One honest caveat: the key is NOT
configured for the current releases — on v1.0.11-beta, v1.0.12-beta and
v1.0.0 the job logged that the scan was skipped, and a scan-links section has
never appeared on any published release page (the v1.0.0 run's `virustotal`
job printed its honest "scan is skipped" informational step; the v1.0.0
release body carries no analysis links) — so treat the multi-engine
links as unavailable and verify with `SHA256SUMS.txt` and, for the signed
artifacts, the minisign signature instead.
(If a build is still flagged,
submit it at <https://www.microsoft.com/en-us/wdsi/filesubmission> and check
the SHA256 against `SHA256SUMS.txt` before running anything.)

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
permanent Fress key, and signs with `apksigner`. On the v1.0.12-beta run and
again on the v1.0.0 run the "Restore the persistent signing keystore" step
executed and all five APKs (universal, arm64, arm, x64, x86) were signed with
it; the v1.0.0 APKs additionally show the v2/v3 signing block in their bytes.
Consequence for
users: release-to-release APK upgrades install normally (same signing
identity), while an APK obtained from any other build source will refuse to
update-over-install — Android enforcing the same-signer rule. Moving from a
1.0.x-beta to the stable 1.0.0 is the one exception: Android refuses a
version downgrade install, so the beta APK must be uninstalled first (which
clears the app's private data) — see the README's migration section.

<!-- HYPOTHESIS-PENDING-INSTALLER-TEST: the uninstall-first downgrade
migration has NOT been executed on a device (docs/testing/stable-release-smoke.md
Android rows are NOT RUN). It is Android's documented downgrade behavior,
not a tested Fress result. -->

Scope note so the layers stay distinct: the APK signature exists for
ANDROID's own installer enforcement. It is unrelated to the in-app updater
(APKs carry no updater artifacts and are never delivered in-app). The
in-app **Open** handoff is a separate, user-initiated boundary: since the
Android adapter landed (PR #74), a completed APK download in the app is
handed to the system package installer through a registry-validated
FileProvider `content://` URI (the installer's own consent and
unknown-sources restrictions stay fully in force; Fress never touches
PackageInstaller internals). That handoff is proven today by mocked E2E
tests (the production frontend records the exact adapter command; the OS
call is a test double), unit tests, and native Rust tests of the registry
validation — the physical-device QA pass
(docs/testing/download-open-smoke.md rows A1–A6) is **NOT RUN**, so no
on-device behavior is claimed beyond the mocked level.

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

Current status at a glance (evidence: release v1.0.0, byte-audited
2026-10-14 from the published bytes and the run #43 CI logs; the v1.0.12-beta
provenance below is preserved):

| Item | State |
| --- | --- |
| Private key | `TAURI_SIGNING_PRIVATE_KEY` secret (backup in the private `fress-state` repo, `updater-key-backup/`) |
| Key password | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret (same backup) |
| Public key | `fress-updater.key.pub` in this repo, embedded into every app build via `include_str!`, also recorded below |
| Updater signatures on releases | The two Windows setup installers (regenerated post-build) and the Linux bundles; **the MSI, macOS dmgs, portable zips and APKs ship without updater artifacts** — `latest.json` therefore carries no darwin or android entries |
| First released build that embeds the key | v1.0.8-beta (verification command present, not yet wired into the delivery flow) |
| First released build that verifies in the delivery flow | v1.0.9-beta (key embedded + three-gate delivery wired) |
| First STABLE release | v1.0.0 (stable track; same signing policy — confirmed against its actual published bytes, 2026-10-14) |
| In-app signature verification | native command + real delivery-flow wiring (three-gate plan → verified download → post-download verify); unsigned platforms route to the Releases page |
| In-app updater plugin | not wired yet (the plugin would replace the app's own flow; see the endpoint note below) |

Public key (safe to distribute; embedded in the binary at compile time from
`fress-updater.key.pub`; byte-identical to the key the v1.0.0 sidecars were
verified against during the 2026-10-14 audit):

```text
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU2MzhDNjgxMjNGQjYzM0IKUldRN1kvc2pnY1k0VnNHRXkyL2UycG5NZFhvdUFLM3I0YXNsYTN4c2sxUlc4YVUyRktUdDM4Vk4K
```

### Release signature audit (v1.0.0 — the first stable release; verified 2026-10-14 from the published bytes)

Method (the sequence the pre-publication template prescribed, executed after the
release went public): all 22 assets were downloaded from the published
release into a separate directory and re-hashed against `SHA256SUMS.txt`
(21 entries — every asset except the checksum file itself — all matched in
both directions, no orphan assets, the manifest does not cover itself);
`scripts/ci/verify-release-artifacts.py` (the same code the release
pipeline's `verify-release` job gates publishing with) was run from a
worktree at the exact tagged commit `78d5e8ff8e1bc38ca8789539da005fdea4b15613`
against the downloaded bytes with the production key from
`src-tauri/tauri.conf.json` (verdict: FINAL ARTIFACT AUDIT PASSED, exit 0,
at 2026-10-14T21:52Z); an independent pure-Python RFC 8032 Ed25519 +
BLAKE2b-512 prehash implementation (self-checked against the RFC test
vectors, including the negative vector) re-verified all five sidecars over
the downloaded bytes and REJECTED a deliberate one-bit tamper (negative
control); the Windows installers' PE certificate tables and the MSI's OLE
digital-signature stream were inspected directly; the release run's job
steps were checked for which signing path executed (Release workflow run
#43, head SHA `78d5e8ff8e1bc38ca8789539da005fdea4b15613`, conclusion
success). Verdicts:

| Artifact (exact name on v1.0.0) | SHA-256 vs `SHA256SUMS.txt` | Updater `.sig` | Minisign verification | Publisher signature |
| --- | --- | --- | --- | --- |
| `Fress_1.0.0_x64-setup.exe` | match | yes | **PASS** | none — PE certificate table empty (DataDirectory[4] size 0) |
| `Fress_1.0.0_arm64-setup.exe` | match | yes | **PASS** | none — PE certificate table empty (DataDirectory[4] size 0) |
| `Fress_1.0.0_amd64.AppImage` | match | yes | **PASS** | n/a |
| `Fress_1.0.0_amd64.deb` | match | yes | **PASS** | n/a |
| `Fress-1.0.0-1.x86_64.rpm` | match | yes | **PASS** | n/a |
| `Fress_1.0.0_x64_en-US.msi` | match | no | n/a | none — no digital-signature stream |
| `Fress_1.0.0_x64-portable.zip` / `_arm64-portable.zip` | match | no | n/a | n/a (plain archives, never Authenticode-signed) |
| `Fress_1.0.0_x64.dmg` / `_aarch64.dmg` | match | no | n/a | unsigned — both macOS jobs ran the "unsigned" fallback; the signed-and-notarized steps were skipped (Apple secrets still not configured) |
| `Fress_1.0.0_{universal,arm64,arm,x64,x86}.apk` | match | no | n/a | APK-signed by CI's persistent keystore (Android's same-signer rule, not an updater signature) — keystore restore + align/sign/upload succeeded on run #43; all five APKs carry the v2/v3 signing block in their bytes |
| `latest.json` | match | n/a | n/a | integrity only — see below |

`latest.json` on v1.0.0 carries exactly eight platform entries —
windows-x86_64, windows-x86_64-nsis, windows-aarch64, windows-aarch64-nsis,
linux-x86_64, linux-x86_64-appimage, linux-x86_64-deb, linux-x86_64-rpm —
all with version `1.0.0`, versioned `releases/download/v1.0.0/...` URLs that
resolve to real assets on this release, no darwin/android entries, and each
embedded signature byte-identical to its sidecar (after the base64 unwrap
described above). The ten artifacts without sidecars are exactly the classes
the honest-matrix refusal expects: macOS dmgs, Android APKs, the MSI and the
portable zips. This proves the RELEASE pipeline's signatures are genuine
over the stable bytes a user downloads, and that the in-app verifier's
algorithm accepts the real stable artifacts.

What a signature establishes and what it does not is unchanged: the macOS
dmgs and Android APKs are NOT delivered through the in-app path (no
publisher signature exists for them), and a SHA-256 match remains an
integrity guarantee, not publisher proof.

### Release signature audit (v1.0.12-beta, verified 2026-10-13 and independently re-proven 2026-10-14) — historical (the newest beta before stable v1.0.0)

Every artifact class on the then-newest beta release was checked from the
release's actual published bytes. Method: all 22 assets were downloaded from
the release and re-hashed against `SHA256SUMS.txt` (21 entries — every
asset except the checksum file itself — all matched); the repository's own
artifact verifier (`scripts/ci/verify-release-artifacts.py`, the same code
the release pipeline's `verify-release` job gates publishing with) was run
against the downloaded bytes with the production key from
`src-tauri/tauri.conf.json`, which compares every embedded `latest.json`
signature byte-for-byte with its `<asset>.sig` sidecar and minisign-verifies
every signed artifact over the exact published bytes (verdict: FINAL ARTIFACT
AUDIT PASSED, exit 0); the Windows installers' PE certificate tables and the
MSI's OLE digital-signature stream were inspected directly; and the release
run's job steps were checked for which signing path executed. The
independent 2026-10-14 re-verification reproduced every verdict with a
second implementation (raw OpenSSL Ed25519 over the BLAKE2b-64 prehash).
What was checked:

| Artifact (exact name on v1.0.12-beta) | SHA-256 vs `SHA256SUMS.txt` | Updater `.sig` | Minisign verification | Publisher signature |
| --- | --- | --- | --- | --- |
| `Fress_1.0.12-beta_x64-setup.exe` | match | yes | **PASS** | none — PE certificate table empty |
| `Fress_1.0.12-beta_arm64-setup.exe` | match | yes | **PASS** | none — PE certificate table empty |
| `Fress_1.0.12-beta_amd64.AppImage` | match | yes | **PASS** | n/a |
| `Fress_1.0.12-beta_amd64.deb` | match | yes | **PASS** | n/a |
| `Fress-1.0.12-beta-1.x86_64.rpm` | match | yes | **PASS** | n/a |
| `Fress_1.0.12-beta_x64_en-US.msi` | match | no | n/a | none — no digital-signature stream |
| `Fress_1.0.12-beta_x64-portable.zip` / `_arm64-portable.zip` | match | no | n/a | n/a (plain archives, never Authenticode-signed) |
| `Fress_1.0.12-beta_x64.dmg` / `_aarch64.dmg` | match | no | n/a | unsigned — the build job's signed-and-notarized step was skipped, its unsigned fallback ran |
| `Fress_1.0.12-beta_{universal,arm64,arm,x64,x86}.apk` | match | no | n/a | APK-signed by CI's persistent keystore (Android's same-signer rule, not an updater signature) |
| `latest.json` | match | n/a | n/a | integrity only — see below |

`latest.json` on v1.0.12-beta carried exactly eight platform entries —
windows-x86_64(-nsis), windows-aarch64(-nsis), linux-x86_64(-appimage/-deb/
-rpm) — all with versioned `releases/download/v1.0.12-beta/...` URLs that
resolve to real assets, no darwin/android entries, and each embedded
signature byte-identical to its sidecar (after the base64 unwrap described
above). The ten artifacts without sidecars are exactly the classes the
honest-matrix refusal expects: macOS dmgs, Android APKs, the MSI and the
portable zips. This proved the RELEASE pipeline's signatures are genuine
over the bytes a user downloads, and that the in-app verifier's algorithm
accepts the real artifacts.

### Release signature audit (v1.0.11-beta, verified 2026-10-13) — historical

The same method (all 22 assets downloaded and re-hashed, the repository's
artifact verifier run over the downloaded bytes with the production key,
publisher-signature absence checked directly on the Windows exes and the
MSI) was applied to v1.0.11-beta earlier the same day with the identical
verdict: 21/21 checksum entries match, the same five artifacts
minisign-verify, `latest.json` carries the same eight platform entries with
versioned URLs, the same ten artifact classes ship without sidecars, and
both setup exes' PE certificate tables are empty. Its full record lives in
that release's docs round
([PR #67](https://github.com/WasewaseX/Fress/pull/67)) and in
docs/release-readiness.md §7 (an independent re-download and
re-verification, PASS exit 0). The
per-artifact signing policy has not changed between v1.0.9-beta,
v1.0.11-beta, v1.0.12-beta and v1.0.0.

### Release signature audit (v1.0.9-beta, verified 2026-10-13) — historical

Kept as the round that established this audit's method (including the
independent Ed25519 implementation) and as the evidence base the later docs
passes built on; for the current release, use the v1.0.0 audit above once
filled (the per-artifact signing policy has not changed between them). Every artifact class on the then-newest release was
checked from the release's actual published bytes. Method: all downloaded artifacts were
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
   (through v1.0.12-beta and v1.0.0 — the v1.0.0 macOS jobs built the dmgs
   with their unsigned fallback steps while the signed-and-notarized steps
   were skipped) has shipped dmgs WITHOUT the `.app.tar.gz` + `.sig`
   updater pair, so the manifest job has no darwin entries to embed. If
   macOS updates are ever to be delivered in-app, that gap needs a CI
   investigation (Agent 6's workstream) and `release.yml` must publish
   minisign `.sig` sidecars for the dmg artifacts under the exact
   `<asset>.sig` naming convention (the in-app updater binds each signature
   to the artifact's exact filename). The same applies to the APKs.
2. **VirusTotal links do not land on the release pages.** The `virustotal`
   job runs, but its scan step has been skipped on the recent releases
   because `VIRUSTOTAL_API_KEY` is not configured (stated verbatim in the
   job log on v1.0.11-beta and v1.0.12-beta, and the v1.0.0 run printed the
   honest "scan is skipped" informational step with the scan step skipped),
   and its scan-links section is absent from every published release body
   through v1.0.12-beta and v1.0.0.
   The docs
   above therefore do not promise those links; configuring the key (or
   recording the decision not to) is a maintainer action tracked in
   docs/release-readiness.md §11.
3. **Per-artifact signature policy is unchanged:** Windows setup exes and
   the Linux bundles are signed; everything else is intentionally not, and
   those platforms correctly route to the Releases page (shape confirmed on
   the v1.0.0 bytes: the same 5-sidecar shape, audit above).

### Rotation caveats

The deployed keypair was generated 2026-09-22. Builds since **v1.0.8-beta**
embed the public key, and builds since **v1.0.9-beta** enforce its
signature in the real delivery flow — so rotation is no longer free: for
every installed app at v1.0.8 or newer, a key change means artifacts signed
by the new key are refused until each user performs one manual reinstall
(older installs update to a new release first and inherit the same
migration). With the stable track now live, the same applies across
channels: a rotated key invalidates the in-app update path for every
installed stable AND beta build until each performs one manual reinstall.
To rotate (also the recovery procedure if the key is ever
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
 Observed so far (through v1.0.12-beta and v1.0.0 — the v1.0.0 run behaved
 the same way: Linux `.sig` files present, macOS dmgs without the updater
 pair): the Linux releases carry their `.sig`
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
 on v1.0.12-beta: every `latest.json` URL is versioned; re-confirmed on
 v1.0.0: all eight URLs use the versioned `releases/download/v1.0.0/` form
 even though the alias would now resolve).

### Delivery wiring: landed

The layers now look like this:

- **Release signing (done):** `updater-overrides.json` + the key secret make
 CI produce `.sig` sidecars and `latest.json` for the Windows installers and
 Linux bundles; the signatures on v1.0.0 verify against the published key
 over the exact downloaded bytes (see the v1.0.0 audit above), and the beta
 audits below remain as history.
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
 alias, which resolves only once a STABLE release exists — v1.0.0 will be
 the first, once it is published on the stable track — but the alias would
 hand the STABLE manifest to every client
 including beta builds, so a per-channel manifest (a branch file or a tiny
 redirect service listing the newest release per track) is still the right
 shape before wiring the plugin. The per-release `latest.json`
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

Current status (evidence: the v1.0.0 release run #43 — both macOS jobs ran
their "unsigned" fallback steps and skipped the signed-and-notarized steps,
matching every beta before it): **the Apple
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
