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

### The paid alternative: Azure Trusted Signing

Microsoft's own signing service costs a small monthly fee and shows your own
name as the publisher. `release.yml` already contains the
`azure/trusted-signing-action` path, gated on six secrets: `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_CODESIGNING_ENDPOINT`,
`AZURE_CODESIGNING_ACCOUNT`, `AZURE_CODESIGNING_PROFILE`. Setup order: create
the Azure account and Trusted Signing resource, complete identity validation
on a Public Trust profile, create an Entra app registration with a client
secret, add the six secrets, push a tag.

### What today's self-signed fallback proves

Until a trusted certificate is in place, releases keep a timestamped
self-signature. It does not remove the warning, but it proves the file you
downloaded is exactly the file CI produced; any modification breaks it. To
check, compare the file's SHA-256 against `SHA256SUMS.txt` on the release
page.

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
