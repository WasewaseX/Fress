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
certificate that chains to a root Windows already trusts. That is the fix, and
the build pipeline already supports it end to end.

## The fix, step by step (Azure Trusted Signing)

Trusted Signing is Microsoft's own signing service. The certificate comes from
Microsoft, so Windows trusts the signature immediately — no reputation waiting
period like with regular purchased certificates.

One-time setup, roughly 15 minutes of clicking plus identity validation:

1. Create an Azure account (free to create) and open
   [portal.azure.com](https://portal.azure.com).
2. Create a **Trusted Signing** (Code Signing) resource. Pick the region whose
   endpoint you'll use, e.g. East US → `https://eus.codesigning.azure.net/`.
3. Inside the resource, create a **certificate profile** of type *Public Trust*.
   Complete **identity validation** (individuals: government ID + a short
   liveness check in the portal). Approval is usually minutes, sometimes a day.
4. Entra ID → **App registration** → new registration → create a **client
   secret**. Give the app the *Trusted Signing Certificate Profile Signer* role
   on the Trusted Signing resource.
5. Add these secrets under the repo's **Settings → Secrets and variables →
   Actions**:

   | Secret | Example |
   | --- | --- |
   | `AZURE_TENANT_ID` | `00000000-0000-...` (Entra tenant) |
   | `AZURE_CLIENT_ID` | `11111111-1111-...` (app registration) |
   | `AZURE_CLIENT_SECRET` | the secret value |
   | `AZURE_CODESIGNING_ENDPOINT` | `https://eus.codesigning.azure.net/` |
   | `AZURE_CODESIGNING_ACCOUNT` | your Trusted Signing account name |
   | `AZURE_CODESIGNING_PROFILE` | your certificate profile name |

6. Push any new version tag. The Windows job signs the installer through the
   service and the release body no longer needs the "Run anyway" advice —
   SmartScreen and UAC show **Fress** as a verified publisher.

Pricing note: the service has a monthly fee for the basic tier (about the price
of a coffee per month, with thousands of signatures included). Identity
validation itself is free.

## Alternative (free, slower): SignPath Foundation

The [SignPath Foundation](https://signpath.org) issues free Authenticode
certificates to genuine open-source projects. The application review takes
longer, and if approved we'd swap the CI step to sign with that certificate.
The pipeline change is small once the certificate exists.

## What the current self-signed fallback still buys you

Until the trusted certificate is in place, releases keep a timestamped
self-signature. That does not remove the warning, but it does prove the file
you downloaded is bit-for-bit the file CI produced — tampering breaks it. For
full confidence, compare the file's SHA-256 against `SHA256SUMS.txt` on the
release page.
