// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { Platform } from '../../types';
import {
  AssetPick,
  DeviceAbi,
  ReleaseAsset,
  WEAK_SCORE_MAX,
} from './types';

/**
 * Asset filtering and matching: decides WHICH file in a release is the
 * right one for the user's platform and architecture, and how confident
 * that decision is.
 *
 * Layers, in order of authority:
 *   1. assetPatterns override  - naming authority (WHICH file family)
 *   2. compatibility gate      - safety constraint (what can never install)
 *   3. heuristic score         - preference ranking among the rest
 */

/** Files that can never be the app itself. */
const BAD_EXT = /\.(sig|blockmap|sha256|sha512|sha256sum|md5|txt|json|yaml|yml|pub|pem|sbom|zsync|bittorrent|xml|map|dSYM|apk\.idsig|idsig)$/i;
/** Metadata / tooling artefacts shipped next to installers. A -src-/-source-
 * token is ALSO excluded: projects that ship no binary for a platform still
 * tag their source tarball next to the binaries, and a source archive was
 * once served to a Linux user as "the app" (HandBrake). */
const BAD_NAME = /sha256|checksum|^latest\.json$|(^|[^a-z0-9])symbols([^a-z0-9]|$)|(^|[^a-z0-9])pdb([^a-z0-9]|$)|dont[-_.]?use|(^|[^a-z0-9])group[-_.]?policy|(^|[^a-z0-9])(source|src)([-_.0-9]|$)/i;
/** Command-line companions: repos like LocalSend ship "<App>-CLI-<v>-windows-arm-64.exe"
 * next to the GUI installer, and on an ARM64 host the CLI used to WIN the
 * scoring (hyphenated "arm-64" read as unmarked, bare /arm/ rewarded it) -
 * users got a 2 MB console tool instead of the app. A -cli- token never
 * names the GUI build ("client"/"click" do not match: the token must end at
 * a separator or the string end). */
const CLI_NAME = /(^|[^a-z0-9])cli([-_.0-9]|$)/i;

/* ------------------------------------------------------------------ */
/* Android ABI classification (shared with the self-updater)           */
/* ------------------------------------------------------------------ */

/**
 * The one place that decides what ABI an APK filename carries. Both the
 * catalog resolver and the self-updater call this, so the two pickers can
 * never drift apart again (the updater used to collapse every host to
 * arm-vs-not and mis-served ARMv7 and x86 Android devices).
 *
 * host_arch on Android reports "aarch64", "arm" (32-bit), "x86"/"i686" or
 * "x86_64"; CI publishes the per-ABI splits as `Fress_*_arm64.apk`,
 * `Fress_*_arm.apk`, `Fress_*_x64.apk` and `Fress_*_x86.apk` - "x64" IS an
 * x86_64 marker here, same as on Windows.
 */
export function androidAssetFlags(name: string): {
  universal: boolean;
  arm64: boolean;
  arm32: boolean;
  x64: boolean;
  x86: boolean;
} {
  const n = name.toLowerCase();
  const arm64 = /arm64|aarch64|arm[_-]?64|v8a/.test(n);
  const x64 = /x86[_-]?64|amd64|x64/.test(n);
  // "universal" must be a TOKEN, not a prefix: the old ^app- rule classified
  // gradle's per-ABI splits (app-arm64-release.apk) as universal simply for
  // starting with "app-", which handed unknown-ABI browsers a split they
  // cannot install. app-universal-release.apk still matches via -universal-.
  return {
    universal:
      /(^|[-_.])universal([-_.]|$)/.test(n) || /all[-_.]?abis/.test(n),
    arm64,
    arm32: !arm64 && /armeabi|arm32|v7a|(^|[^a-z0-9])arm([^a-z0-9]|$)/.test(n),
    x64,
    x86: !x64 && /x86(?!_64)|i[36]86/.test(n),
  };
}

/** Single-ABI view of an APK name, in priority order (a fat APK that names
 * several ABIs classifies as its first); null when nothing marks the ABI. */
export function androidAssetAbi(name: string): 'arm64' | 'arm' | 'x86' | 'x86_64' | null {
  const f = androidAssetFlags(name);
  if (f.arm64) return 'arm64';
  if (f.arm32) return 'arm';
  if (f.x64) return 'x86_64';
  if (f.x86) return 'x86';
  return null;
}

/** Map a Tauri host_arch value (or a browser's best-effort arch signal) to
 * the ABI family it runs. Only EXACT arch values map to an ABI; anything
 * else - including the empty signal a reduced user agent gives - is
 * "unknown", and the scorers treat unknown as "universal APK only". */
export function androidDeviceAbi(arch?: string | undefined): DeviceAbi {
  return arch === 'aarch64' ? 'arm64' :
    arch === 'arm' ? 'arm' :
    arch === 'i686' || arch === 'x86' ? 'x86' :
    arch === 'x86_64' ? 'x86_64' :
    'unknown';
}

/**
 * The HARD architecture-compatibility constraint, shared by the heuristic
 * scorer and the `assetPatterns` override path so the two can never
 * disagree about what is impossible.
 *
 * Division of authority:
 *   assetPatterns        = naming authority (WHICH file family is right)
 *   this gate            = safety constraint (what can never be installed)
 *   heuristic score      = preference ranking (tie breaker among the rest)
 *
 * An override may pin the naming; it may never declare an impossible
 * architecture installable. Returns false only for PROVEN incompatibility:
 * with an unknown host arch nothing is proven, so the gate stays open
 * (except Android, where unknown means the universal-only contract).
 */
export function assetCompatibleWithDevice(
  name: string,
  platform: Platform,
  arch: string | undefined
): boolean {
  const n = name.toLowerCase();
  switch (platform) {
    case 'android': {
      const device = androidDeviceAbi(arch);
      if (device === 'unknown') return androidAssetFlags(n).universal; // universal only, never a guess
      if (androidAssetFlags(n).universal) return true;
      const abi = androidAssetAbi(n);
      if (!abi) return true; // unmarked: a gamble only a KNOWN device may take
      // Runnable cross-ABI pairs: armv7 apks run on arm64 devices, and
      // x86_64 devices keep 32-bit x86 compat. Everything else is a
      // guaranteed install failure (arm64 on arm/32-bit, x64 on 32-bit,
      // arm splits on x86 family, 64-bit splits on a 32-bit device).
      return (
        abi === device ||
        (device === 'arm64' && abi === 'arm') ||
        (device === 'x86_64' && abi === 'x86')
      );
    }
    case 'windows': {
      // x86_64 Windows cannot run arm64 binaries (WoA emulates x64/x86, not
      // the reverse) and a 32-bit host runs neither arm64 nor x64. An
      // ARM64 host runs everything through emulation. Hyphenated markers
      // (LocalSend names its builds "x86-64"/"arm-64") must classify the
      // same as their underscore siblings - the old regexes missed them,
      // which let a CLI tool impersonate the app on ARM64 hosts.
      const armAsset = /arm64|aarch64|arm[_-]?64/.test(n);
      const x64Asset = /x64|x86[_-]?64|amd64|win64/.test(n);
      const hostIs32 = arch === 'x86' || arch === 'i686';
      if (armAsset && !x64Asset) return arch !== 'x86_64' && !hostIs32;
      if (x64Asset && !armAsset) return !hostIs32;
      return true;
    }
    case 'mac': {
      // Apple Silicon runs Intel dmgs through Rosetta 2; an Intel Mac has
      // no path to arm64-only builds.
      const armAsset = /arm64|aarch64|arm[_-]?64|apple[-_. ]?silicon/.test(n);
      const x64Asset = /x64|x86_64|intel/.test(n);
      if (armAsset && !x64Asset) return arch !== 'x86_64';
      return true;
    }
    case 'linux': {
      // No usable cross-ISA emulation in a desktop context either way:
      // x86_64 builds on ARM machines and arm builds on x86 machines are
      // both dead ends (the self-updater has refused these for ages). A
      // 32-bit x86 host additionally cannot run 64-bit-only builds.
      const armAsset = /arm|aarch64/.test(n);
      const x64Asset = /x86[_-]?64|x64|amd64/.test(n);
      const hostIsArm = arch === 'aarch64' || arch === 'arm';
      const hostIs32 = arch === 'x86' || arch === 'i686';
      if (armAsset && !x64Asset) return !hostIs32 && arch !== 'x86_64';
      if (x64Asset && !armAsset) return !hostIsArm && !hostIs32;
      return true;
    }
    default:
      return true;
  }
}

export function scoreAsset(name: string, platform: Platform, arch: string | undefined): number {
  const n = name.toLowerCase();
  let s = 0;

  switch (platform) {
    case 'android': {
      if (!n.endsWith('.apk')) return -1;
      if (/google[-_.]?play|playstore|play[-_.]?store/.test(n)) s -= 6; // Play flavor sideloads poorly
      // HARD SAFETY GATE first (shared with the assetPatterns override
      // path): a file the device provably cannot run is refused outright,
      // whatever its score would have been. This includes unknown devices
      // (universal only - "no ABI marker" is exactly the unknown, so an
      // unmarked apk is a gamble we cannot resolve) and wrong-ABI splits,
      // which used to stay pickable at negative scores when they were the
      // only candidate. Ranking below applies only to compatible files.
      if (!assetCompatibleWithDevice(name, 'android', arch)) return -1;
      const f = androidAssetFlags(n);
      const deviceAbi = androidDeviceAbi(arch);
      if (f.universal) s += 6; // runs everywhere
      // A matching ABI-specific APK slightly outranks universal (smaller
      // download); armv7 apks are runnable on arm64 devices, hence the
      // graded 2 instead of a refusal the gate already enforces elsewhere.
      if (f.arm64) s += deviceAbi === 'arm64' ? 7 : -8;
      if (f.arm32) s += deviceAbi === 'arm' ? 7 : deviceAbi === 'arm64' ? 2 : -8; // arm64 devices run armv7 apks
      if (f.x64) s += deviceAbi === 'x86_64' ? 7 : deviceAbi === 'x86' ? -2 : -8;
      if (f.x86) s += deviceAbi === 'x86' ? 7 : deviceAbi === 'x86_64' ? 2 : -8;
      if (/fdroid/.test(n)) s += 1;
      break;
    }
    case 'windows': {
      // A file tagged for another OS is never the Windows build. The zip
      // tier made this reachable: syncthing-macos-amd64.zip otherwise ties
      // with syncthing-windows-amd64.zip (same extension, same arch token)
      // and alphabetical order hands the user the macOS build.
      if (/macos|darwin|linux|android|[-_.]mac[-_.]/.test(n)) return -1;
      if (n.endsWith('.exe')) s += 6;
      else if (n.endsWith('.msi')) s += 4;
      // Self-contained archive builds are the ONLY distribution some
      // projects ship (Syncthing, Whisper Desktop, LosslessCut). Below any
      // installer: when a repo publishes both, the installer should win.
      else if (n.endsWith('.zip') || n.endsWith('.7z')) s += 2;
      else return -1;
      // Gate: an x86_64 machine can never run an arm64-only installer (WoA
      // emulates x64/x86, not the reverse) - previously it stayed pickable
      // at a weak positive score when it was the only exe.
      if (!assetCompatibleWithDevice(name, 'windows', arch)) return -1;
      if (/setup|installer|install/.test(n)) s += 2;
      if (/unsigned/.test(n)) s -= 4;
      if (/portable/.test(n)) s -= 2;
      if (/arm64|arm/.test(n)) s += arch === 'aarch64' ? 4 : -5;
      // The 32-bit marker must not swallow hyphenated 64-bit names:
      // "x86-64" (LocalSend) matched x86(?!_64) and lost 3 points as if it
      // were a 32-bit build, on top of missing the x64 bonus.
      if (/win32|ia32|i686|32[-_.]?bit|x86(?![_-]?64)/.test(n) && !/x64|x86[_-]?64|win64/.test(n)) s -= 3;
      // Builds kept around for old Windows only (KeePassXC names them
      // "LegacyWindows") must lose to the current installer every time.
      if (/legacy/.test(n)) s -= 6;
      if (/x64|x86[_-]?64|amd64|win64/.test(n)) s += arch === 'aarch64' ? 0 : 3;
      break;
    }
    case 'mac': {
      // Same cross-OS guard as Windows: devtoys_linux_x64_portable.zip
      // otherwise becomes a "mac build" the moment zips are scoreable.
      if (/linux|android|windows|[-_.]win(32|64)?[-_.0-9]|[-_.]win$/.test(n)) return -1;
      if (!n.endsWith('.dmg')) {
        // .pkg is an acceptable macOS fallback but dmg is friendlier; .zip
        // is the only distribution some projects ship (Syncthing, DevToys).
        if (n.endsWith('.pkg')) s += 0;
        else if (n.endsWith('.zip')) s += 1;
        else return -1;
      } else {
        s += 4;
      }
      // Gate: an Intel Mac cannot run an arm64-only dmg (Rosetta only
      // translates the other direction); Apple Silicon runs Intel builds.
      if (!assetCompatibleWithDevice(name, 'mac', arch)) return -1;
      if (/arm64|aarch64|apple[-_. ]?silicon/.test(n)) s += arch === 'aarch64' ? 6 : -7;
      if (/x64|x86_64|intel/.test(n)) s += arch === 'aarch64' ? -7 : 6;
      if (/universal/.test(n)) s += 3;
      break;
    }
    case 'linux': {
      // Cross-OS guard: ollama-darwin.tgz used to be the last-resort pick
      // for Linux hosts; a darwin/macos/windows name is never a Linux build.
      if (/macos|darwin|[-_.]mac[-_.]|windows|[-_.]win(32|64)?[-_.0-9]|android/.test(n)) return -1;
      if (n.endsWith('.appimage')) s += 7;
      else if (n.endsWith('.deb')) s += 5;
      else if (n.endsWith('.rpm')) s += 3;
      // The \.t prefix trick covers .tar.gz / .tgz / .tar.zst / .tzst /
      // .tar.xz / .txz / .tar.bz2 / .tbz2 in one regex. Ollama moved its
      // Linux build from .tgz to .tar.zst and 7-Zip ships .tar.xz; the old
      // regex only knew tar.gz, so those builds scored -1 and a WRONG
      // archive (ollama-darwin.tgz) became the pick for Linux.
      else if (/\.t(ar\.)?(gz|zst|xz|bz2)$/.test(n)) s += 1;
      else return -1;
      // Gate: no usable cross-ISA emulation in a desktop context, so an
      // ARM machine gets nothing from x86_64-only releases and vice versa
      // (the self-updater has refused these for ages; the catalog used to
      // hand them over with a confident, non-weak score of 5).
      if (!assetCompatibleWithDevice(name, 'linux', arch)) return -1;
      if (/x86[_-]?64|x64|amd64/.test(n)) s += arch === 'aarch64' ? -2 : 4;
      if (/arm|aarch64/.test(n)) s += arch === 'aarch64' ? 4 : -5;
      if (/flatpak|snap/.test(n)) s -= 6;
      break;
    }
    default:
      return -1;
  }
  return s;
}

export function pickAsset(assets: ReleaseAsset[], platform: Platform, arch: string | undefined): ReleaseAsset | null {
  return pickAssetDetailed(assets, platform, arch)?.pick ?? null;
}

/**
 * Picks the asset a user on this platform/architecture needs.
 *
 * Order of trust:
 *  1. The app's own `assetPatterns[platform]` regex, when provided - the
 *     catalog author vouched for that naming. Bad-extension files are still
 *     excluded, and a pattern that matches nothing falls through to (2)
 *     rather than failing the download.
 *  2. The scoring heuristic below, which never claims certainty it does not
 *     have: weak picks are flagged so the UI can show a caution instead of
 *     silently handing over a questionable file.
 */
export function pickAssetDetailed(
  assets: ReleaseAsset[],
  platform: Platform,
  arch: string | undefined,
  patterns?: Partial<Record<Platform, string>>
): AssetPick | null {
  const usable = assets.filter(
    (a) => !BAD_EXT.test(a.name) && !BAD_NAME.test(a.name) && !CLI_NAME.test(a.name)
  );

  const pattern = patterns?.[platform];
  if (pattern) {
    try {
      const re = new RegExp(pattern, 'i');
      // Architecture compatibility is a HARD constraint an override cannot
      // bypass: the pattern is the naming authority - it says which file
      // FAMILY is right - but it must never declare an impossible
      // architecture installable (an Android pattern pinning a split name
      // used to hand that file to an unknown-ABI browser even though the
      // heuristic correctly refuses it). Incompatible matches are dropped;
      // if none survive, fall through to the heuristic, which applies the
      // very same gate (assetCompatibleWithDevice).
      const matches = usable
        .filter((a) => re.test(a.name))
        .filter((a) => assetCompatibleWithDevice(a.name, platform, arch));
      if (matches.length > 0) {
        // Among surviving pattern matches the heuristic still breaks ties
        // (x64 vs arm64 variants of the same pinned naming).
        let best = matches[0];
        let bestScore = -Infinity;
        for (const a of matches) {
          const s = scoreAsset(a.name, platform, arch);
          if (s > bestScore) {
            bestScore = s;
            best = a;
          }
        }
        return { pick: best, matchedBy: 'override', weak: false };
      }
    } catch {
      // An invalid pattern must never kill the download path; the catalog
      // validator flags it separately.
    }
  }

  let best: ReleaseAsset | null = null;
  let bestScore = -Infinity;
  for (const a of usable) {
    const s = scoreAsset(a.name, platform, arch);
    if (s === -1) continue;
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  if (!best) return null;
  return { pick: best, matchedBy: 'heuristic', weak: bestScore <= WEAK_SCORE_MAX };
}
