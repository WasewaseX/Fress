# Fress Android signing keystore (persistent key)

Android refuses to install an update signed with a different key, so the same
keystore must sign every future APK build.

## What is here
- `fress.keystore` — PKCS12 keystore, alias `fress`, store/key password `fressandroid`
- `ANDROID_KEYSTORE_B64.txt` — the same keystore base64-encoded (exactly what the CI secret expects)

## One-time setup (recommended)
1. Open https://github.com/WasewaseX/Fress/settings/secrets/actions
2. Add repository secret `ANDROID_KEYSTORE_B64` = the full contents of `ANDROID_KEYSTORE_B64.txt`
   (the release workflow reads it automatically; without it, CI generates a NEW key and prints a warning —
   then updates over an already-installed APK will fail with INSTALL_FAILED_UPDATE_INCOMPATIBLE).
3. Keep `fress.keystore` backed up somewhere safe (it is the only way to ship compatible updates).

The password is intentionally simple for a beta: the signature continuity matters more than
key secrecy for sideloading. Rotate before any public stable release if you prefer.
