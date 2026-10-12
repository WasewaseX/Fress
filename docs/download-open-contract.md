# The download-to-open contract

Scope: the LAST mile of a download — a completed artifact is handed to the
host OS by explicit user action, or the failure is reported honestly. This
is the contract shared by the frontend (`src/lib/downloads.tsx`,
`src/lib/artifactOpen.ts`, `src/components/DownloadManager.tsx`), the
desktop native command (`src-tauri/src/artifact_open.rs`), the E2E suite
(Workflow K, owned by the E2E agent) and the Android adapter's native
implementation. (The download ENGINE's own state machine lives in
`docs/download-lifecycle.md` and is unchanged by this contract.) When any
side changes deliberately, the others update in the SAME change.

## The boundary

ONE frontend→native boundary serves every artifact class:

    openFile({ id, path, name, url })        →  plugin:opener|open_path
                                                { path: <exact>, with: null }
    openFolder({ id, path, name, url })      →  plugin:opener|reveal_item_in_dir
                                                { paths: [<exact>] }
                                                └ on refusal → open_path(dirname)
                                                └ on refusal → honest error

- `path` is ALWAYS the exact string the `download-complete` event delivered
  for that download id — never reconstructed from the row's display name,
  never joined through a shell, never a `.part` staging file, validator
  sidecar (`.part.meta`), signature document (`.sig`) or another download's
  destination.
- `open_path` with the OS-default handler is the correct authority for
  Windows `.exe`/`.msi`/`.zip`, macOS `.dmg`/`.pkg`/archives and Linux
  `.deb`/`.rpm`/archives. Gatekeeper, UAC and package-manager checks stay
  in force; Fress never disables them and never claims an installer
  succeeded merely because the installer UI launched.
- On ANDROID the same boundary carries the app-private path. The native
  adaptation below it (FileProvider content URIs; APK handoff to the
  system package installer with `REQUEST_INSTALL_PACKAGES`; MIME-matched
  viewer with a share fallback for other files) is the Android adapter's
  own native implementation. The frontend does not branch for Android:
  Show in folder is hidden (app-private storage is not browsable), the
  footer says so, and Open passes the exact path through.

## The one desktop exception: Linux AppImage

Stock Linux desktops ship no AppImage MIME handler, and a freshly
downloaded AppImage has no execute bit — the OS-associated open is refused.
The frontend therefore retries ONCE, only when ALL of these hold:

1. the opener's `open_path` REJECTED (a desktop with a real AppImage
   handler never reaches the fallback — the OS association wins);
2. the exact completed path ends with `.AppImage` (case-insensitive);
3. the build is a desktop Linux build (`launch_app_image_artifact` exists).

`launch_app_image_artifact(id, path)` re-validates everything natively
before touching the file (the frontend attempt is an optimization, not the
security boundary):

- staging/sidecar/signature names and `..` traversal components: refused;
- the file must CURRENTLY be a regular file (`symlink_metadata`), never a
  symlink to follow, never a directory;
- the engine's completed-artifact registry (fed by the commit path) must
  hold a record for the EXACT path whose download id equals the caller's
  id, whose fresh canonicalization still matches the committed location,
  and whose committed size is unchanged — a restored-after-restart row has
  no engine identity and fails closed (`not-registered`);
- only then: the execute bit is set on THAT validated file as a consequence
  of this explicit launch (never globally on downloads), and the file is
  exec'd directly by argv — no shell, no command concatenation — with a
  background reaper so the child neither zombies nor dies with Fress.

## Action state and honesty

- Open/Show exist ONLY on a completed row with a non-empty path; a row in
  queued/active/retrying/error/cancelled state exposes no open action and
  produces zero opener traffic.
- While a native call is in flight the row's action renders dimmed +
  `aria-busy` but stays INTERACTIVE: the authoritative guard in the action
  (synchronous check-then-set before any await) swallows repeat
  activations, so exactly ONE native launch can be pending per row. A
  disabled/aria-disabled control is deliberately avoided — a second
  activation must LAND and be ignored, not hang.
- Success is the native call resolving; nothing is reported before that,
  no success toast fires, and no file executes on download completion
  (completion only notifies).
- A rejection keeps the row completed, shows the localized generic title
  (`downloads.toast.openFileFailed` / `openFolderFailed`) with a typed
  reason description, logs the raw native detail to the console for
  diagnostics, and leaves the action retryable without re-downloading.
- Typed reasons (frontend + native codes): missing / not-a-file /
  no-handler / permission / unregistered / cross-wired / replaced — an
  unrecognized native message maps to the honest generic fallback, never
  to a guessed specific reason.

## Platform behavior matrix

| Artifact | Windows | macOS | Linux | Android |
|---|---|---|---|---|
| installer/executable (exe/msi/pkg/deb/rpm) | OS handler (ShellExecuteW) | OS handler (`open`, Gatekeeper intact) | OS handler / package UI | APK: system package installer via the adapter's content-URI handoff |
| disk image (dmg) | n/a | Finder mounts | n/a | n/a |
| AppImage | n/a | n/a | OS association if present, else validated direct launch | n/a |
| archive (zip) | OS handler | OS handler | OS handler | MIME-matched viewer / share sheet (adapter) |
| Show in folder | Explorer reveal (folder fallback) | Finder reveal (folder fallback) | file manager reveal (folder fallback) | hidden (app-private storage) |

Real-OS verification of this matrix is the manual smoke checklist
(`docs/testing/download-open-smoke.md`, E2E agent); a green mocked suite
never substitutes for it.

## Security notes

- The opener permissions in `src-tauri/capabilities/default.json` are
  UNCHANGED (`opener:allow-open-path`, `opener:allow-reveal-item-in-dir`).
  No shell plugin, no broad shell permissions, no new capability entries:
  `launch_app_image_artifact` is an app command (always callable by the
  app's own webview, invisible to remote content), and it is the only place
  in the codebase that sets an execute bit or spawns a downloaded file.
- The command's validation never trusts the frontend payload alone: the
  registry record is written only by the engine's commit path, so a
  (id, path) pair that does not match a genuine engine completion is
  refused before any filesystem mutation.
