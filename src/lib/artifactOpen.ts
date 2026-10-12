// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * The download-to-open boundary: ONE typed operation per user action.
 *
 * A completed download is handed to the host OS exactly as the completion
 * event delivered it - the EXACT final path, never a reconstruction from
 * the row's display name, never a shell command, never a partial file.
 * This module is the whole opening policy; the React layer (downloads.tsx)
 * only binds it to items, busy state and toasts.
 *
 * # The boundary contract (shared with the E2E suite and the Android adapter)
 *
 * Every open attempt goes through the opener plugin's `open_path` with the
 * exact path and the OS-default handler FIRST - for every artifact class.
 * The OS association is the correct authority for Windows exe/msi/zip,
 * macOS dmg/pkg, Linux deb/rpm and archives; Gatekeeper/UAC/package-manager
 * checks stay in force because nothing bypasses them.
 *
 * Exactly ONE class needs more than the plugin on desktop: the Linux
 * AppImage. Stock desktops ship no AppImage MIME handler and a freshly
 * downloaded AppImage carries no execute bit, so the OS refuses it. For
 * THAT class only, when the OS-associated open is REJECTED, the operation
 * retries through the app's `launch_app_image_artifact` command - a
 * registry-validated, per-file chmod +x and a direct argv exec (no shell).
 * The fallback never fires preemptively: if the user's desktop DOES have
 * an AppImage handler, the OS's own association wins.
 *
 * Android keeps the SAME frontend boundary (open_path with the exact
 * app-private path). The native adaptation below that boundary - FileProvider
 * content URIs, APK handoff to the system package installer - is the
 * Android adapter's own native implementation (owned separately); the
 * frontend neither branches nor reconstructs anything for it.
 *
 * # Failure honesty
 *
 * Every rejection is parsed into a typed reason. The UI renders the
 * localized message for that reason; the raw native detail goes to the
 * console for diagnostics. A rejection never mutates the download row:
 * the artifact stays completed, the action stays retryable.
 */

/** Identity of one completed artifact, bound to the download that produced
 * it. The id travels with every privileged operation so the native side can
 * refuse a cross-wired (id, path) pair; the path is ALWAYS the exact string
 * the completion event delivered for that id. */
export interface CompletedArtifactRef {
  /** The download id from the completion event (negative for rows restored
   * after a restart - they have no engine identity and cannot prove the
   * path still refers to engine-committed bytes). */
  id: number;
  /** The exact final path from THIS download's completion event. */
  path: string;
  /** Display name of the download row (diagnostics only - never used to
   * reconstruct a filesystem path). */
  name: string;
  /** Source URL (diagnostics only). */
  url: string;
}

/** Why an open/reveal was refused. Desktop taxonomy: what the opener
 * plugin and the AppImage launcher can actually report. */
export type OpenFailureKind =
  /** The file is gone (deleted, moved, or never finished committing). */
  | 'missing'
  /** The path exists but is not a regular file. */
  | 'not-a-file'
  /** Privileged AppImage launch without a matching completed-artifact
   * record (unregistered path, or a restored-after-restart row). */
  | 'unregistered'
  /** The registered record belongs to a DIFFERENT download id: the call
   * tried to cross-wire two downloads. */
  | 'cross-wired'
  /** The artifact changed after completion (moved or resized). */
  | 'replaced'
  /** The OS has no handler for this file type. */
  | 'no-handler'
  /** The OS refused the access (permissions, policy). */
  | 'permission'
  /** The activation arrived while the same action was already in flight;
   * it was ignored, not failed. */
  | 'busy'
  /** Anything else - honest fallback, never a guessed specific reason. */
  | 'unknown';

/** What the operation decided. `ok` is true only after the native call
 * RESOLVED - never before. Failures never throw: the outcome carries the
 * typed reason and the raw one-line native detail (for diagnostics). */
export interface OpenOutcome {
  ok: boolean;
  kind: OpenFailureKind;
  /** The native error's own short text, when one was reported. */
  detail?: string;
}

/** True when a row is completed but the open action is already running for
 * it. Distinct from failures: repeated activation is IGNORED (no toast, no
 * second native launch), exactly the contract the E2E suite pins. */
export const isBusyOutcome = (o: OpenOutcome): boolean => o.kind === 'busy';

// ---------------------------------------------------------------------------
// Error parsing
// ---------------------------------------------------------------------------

/** The app's own typed namespace: `open-artifact/<code>[: detail]` - the
 * shape the native AppImage launcher reports. Everything else is a plugin
 * error string, classified by its known platform wordings. */
const TYPED_PREFIX = 'open-artifact/';

/** Maps a typed command code to a failure kind. */
const TYPED_KINDS: Record<string, OpenFailureKind> = {
  'not-found': 'missing',
  'not-a-file': 'not-a-file',
  'symlink': 'not-a-file',
  'not-registered': 'unregistered',
  'id-mismatch': 'cross-wired',
  'replaced': 'replaced',
  'not-artifact': 'unknown',
  'unsupported-platform': 'no-handler',
  'internal': 'unknown',
};

/** Wordings the opener plugin and the OS produce in practice, per failure
 * class. Kept case-insensitive and substring-based on purpose: the plugin
 * concatenates OS messages we do not control. */
const PATTERNS: Array<{ kind: OpenFailureKind; re: RegExp }> = [
  {
    kind: 'missing',
    re: /no such file|file not found|cannot find the (?:file|path)|system cannot find|os error 2\b|os error 3\b|errordomain.*file.*does.?not.?exist|the file .* could not be found|enoent/i,
  },
  {
    kind: 'permission',
    re: /permission denied|access is denied|not permitted|operation not permitted|os error 5\b|os error 13\b|eacces|eperm|authorization denied/i,
  },
  {
    kind: 'no-handler',
    re: /no application (?:is registered|knows|able)|no handler|not associated|no method available|no program|there is no .* registered|se_err_noassoc|os error 1155|failed to (?:open|execute).*xdg-open|cannot open .* no associated|finddefaultapplication.*failed/i,
  },
  {
    kind: 'not-a-file',
    re: /is a directory|is not a (?:regular )?file|is a folder|eisdir/i,
  },
];

/** Classifies any rejection into a typed reason plus the raw detail.
 * Total function: an unrecognized message is `unknown`, never a guessed
 * specific reason. */
export function parseOpenError(e: unknown): { kind: OpenFailureKind; detail: string } {
  const raw = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
  const detail = raw.trim();
  if (detail.startsWith(TYPED_PREFIX)) {
    const rest = detail.slice(TYPED_PREFIX.length);
    const colon = rest.indexOf(':');
    const code = (colon === -1 ? rest : rest.slice(0, colon)).trim();
    const nativeDetail = colon === -1 ? '' : rest.slice(colon + 1).trim();
    return { kind: TYPED_KINDS[code] ?? 'unknown', detail: nativeDetail };
  }
  for (const { kind, re } of PATTERNS) {
    if (re.test(detail)) return { kind, detail };
  }
  return { kind: 'unknown', detail };
}

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

/** Native dependencies, injected so the policy stays pure and testable.
 * The production wiring (downloads.tsx) binds the opener plugin and the
 * app command; tests bind doubles. */
export interface ArtifactOpenDeps {
  /** plugin:opener|open_path - the OS-default-handler open. */
  openPath: (path: string) => Promise<void>;
  /** The app's registry-validated AppImage launch command. Only called
   * for a .AppImage target on a platform whose build ships the command. */
  launchAppImage: (req: { id: number; path: string }) => Promise<void>;
  /** True only where the launch command exists and is meaningful: a
   * desktop Linux build. Android never launches AppImages. */
  appImageLaunchSupported: boolean;
  /** Diagnostic sink for raw native details (the UI never shows them). */
  warn: (message: string, detail: unknown) => void;
}

/** The Linux AppImage extension test, case-insensitive, on the EXACT
 * completed path. */
export const isAppImagePath = (path: string): boolean => /\.appimage$/i.test(path);

/**
 * Opens a completed download artifact.
 *
 * Order of authority:
 *   1. `open_path` with the exact path - the OS association decides, for
 *      every artifact class. This is the boundary the E2E suite observes.
 *   2. ONLY on rejection, ONLY for a .AppImage target, ONLY where the
 *      validated launcher exists: retry through `launchAppImage`. The
 *      launcher re-validates everything natively (registry record, id
 *      binding, regular file, staging shapes) - the frontend attempt is
 *      an optimization, not the security boundary.
 *
 * A held/slow native call is fine: the caller marks the row busy from the
 * moment the operation starts. Nothing launches twice; nothing reports
 * success before the native call resolves.
 */
export async function openCompletedArtifact(
  artifact: CompletedArtifactRef,
  deps: ArtifactOpenDeps
): Promise<OpenOutcome> {
  const path = artifact.path;
  try {
    await deps.openPath(path);
    return { ok: true, kind: 'unknown' };
  } catch (e) {
    const parsed = parseOpenError(e);
    deps.warn(`open failed for "${artifact.name}" (download ${artifact.id})`, e);
    if (deps.appImageLaunchSupported && isAppImagePath(path)) {
      try {
        await deps.launchAppImage({ id: artifact.id, path });
        return { ok: true, kind: 'unknown' };
      } catch (launchError) {
        const launchParsed = parseOpenError(launchError);
        deps.warn(`AppImage launch failed for "${artifact.name}" (download ${artifact.id})`, launchError);
        return { ok: false, kind: launchParsed.kind, detail: launchParsed.detail };
      }
    }
    return { ok: false, kind: parsed.kind, detail: parsed.detail };
  }
}

/** Native dependencies of the reveal operation. */
export interface ArtifactRevealDeps {
  /** plugin:opener|reveal_item_in_dir - select the file in its folder. */
  revealItemInDir: (path: string) => Promise<void>;
  /** plugin:opener|open_path - the containing-folder fallback. */
  openPath: (path: string) => Promise<void>;
  /** Containing-directory lookup for the fallback. */
  dirname: (path: string) => Promise<string>;
  /** Diagnostic sink. */
  warn: (message: string, detail: unknown) => void;
}

/**
 * Reveals a completed download in its folder.
 *
 * Order of authority (mirrors the long-standing behavior):
 *   1. `reveal_item_in_dir` with the EXACT file - the file gets selected,
 *      not merely its folder opened.
 *   2. On refusal (Windows builds without the shell integration): open
 *      the file's CONTAINING folder - never the file itself.
 *   3. Total refusal: a typed failure the UI reports honestly.
 */
export async function revealCompletedArtifact(
  artifact: CompletedArtifactRef,
  deps: ArtifactRevealDeps
): Promise<OpenOutcome> {
  const path = artifact.path;
  try {
    await deps.revealItemInDir(path);
    return { ok: true, kind: 'unknown' };
  } catch (e) {
    deps.warn(`reveal failed for "${artifact.name}" (download ${artifact.id})`, e);
    try {
      await deps.openPath(await deps.dirname(path));
      return { ok: true, kind: 'unknown' };
    } catch (folderError) {
      const parsed = parseOpenError(folderError);
      deps.warn(`containing-folder fallback failed for "${artifact.name}" (download ${artifact.id})`, folderError);
      return { ok: false, kind: parsed.kind, detail: parsed.detail };
    }
  }
}
