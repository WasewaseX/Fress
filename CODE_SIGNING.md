# Killing the "Unknown Publisher" warning

## Why Windows shows the blue warning

When you run an installer, Windows asks one question: *is the publisher vouched
for by a certificate authority it already trusts?*

- No signature at all → "Unknown Publisher".
- A self-signed signature (our current CI fallback) → still "Unknown Publisher",
  because the certificate vouches for itself. That is expected and there is no
  build flag, setting, or trick that changes it — the warning is Windows doing
  its job.

So the warning disappears exactly when the installer is signed with a
certificate that chains to a root Windows already trusts. The build pipeline
already supports that end to end, and there is a **free** route.

## The free fix: SignPath Foundation (recommended, $0)

The [SignPath Foundation](https://signpath.org) gives genuine open-source
projects code signing at no cost — same service paying customers buy. Two
things make it unusually friendly for a zero-budget project:

- **No personal identification required.** They verify that binaries were built
  from this repository (a build/policy check), not your government ID.
- **No fees, ever, for OSS** — no per-signature or re-issuance charges.

One honest trade-off: the certificate is issued **to SignPath Foundation**, so
Windows shows *SignPath Foundation* as the verified publisher (they vouch for
the project by name) rather than "Fress". A paid certificate would show your
own name instead.

Fress already meets every published condition:

| Condition | Fress status |
| --- | --- |
| No malware / unwanted programs | clean catalog app |
| OSI-approved license, no dual-licensing | MIT |
| No proprietary components | 100% open, MIT |
| Actively maintained | ongoing releases |
| Already released in the form to be signed | v1.0.0-beta live |
| Documented on the download page | README + release notes |

### Steps (15 minutes of form-filling, then their review)

1. Open [signpath.org/apply](https://signpath.org/apply) and submit the form
   with the repository URL `https://github.com/WasewaseX/Fress`.
2. Wait for their review (days, sometimes a couple of weeks). They check the
   repo against the conditions above.
3. Once approved you get a **SignPath.io organization** with a signing policy.
   From the dashboard collect: **API token**, **organization ID**,
   **project ID**, **signing policy ID**.
4. Add four secrets under the repo's **Settings → Secrets and variables →
   Actions**: `SIGNPATH_API_TOKEN`, `SIGNPATH_ORG_ID`, `SIGNPATH_PROJECT_ID`,
   `SIGNPATH_SIGNING_POLICY_ID`.
5. Say the word — the Windows build job gets rewired to: build unsigned →
   `submit-signing-request` GitHub Action (key lives on SignPath's HSM) →
   signed installer uploaded to the release. Then push the next version tag.

## The paid alternative: Azure Trusted Signing

Trusted Signing is Microsoft's own signing service (~the price of a coffee per
month). The publisher shows *your own identity*, and trust is instant. If the
project ever has a budget, `azure/trusted-signing-action` support is already
wired into `release.yml`, gated on six secrets (`AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_CODESIGNING_ENDPOINT`,
`AZURE_CODESIGNING_ACCOUNT`, `AZURE_CODESIGNING_PROFILE`). Setup: Azure
account → Trusted Signing resource → Public Trust profile with identity
validation → Entra app registration + client secret → add the six secrets →
push a tag.

## What the current self-signed fallback still buys you

Until a trusted certificate is in place, releases keep a timestamped
self-signature. That does not remove the warning, but it does prove the file
you downloaded is bit-for-bit the file CI produced — tampering breaks it. For
full confidence, compare the file's SHA-256 against `SHA256SUMS.txt` on the
release page.
