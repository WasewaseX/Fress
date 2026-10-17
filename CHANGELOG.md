# Changelog

## Unreleased — the stable-hardening round

Every finding from the deep code review that had been reported but not yet fixed is now fixed, the opener plugin's last unrestricted webview primitive is gone, and TypeScript compiles under full `strict` mode. All evidence in `docs/testing/stable-hardening-2026-10-15.md`.

### Native engine and boundaries
- **All-dots and Windows trailing-dot filenames can no longer break finalize.** A server-supplied name like `...` survived the sanitizer (only `.` and `..` were caught) and reached `CreateFile`, which refuses or mangles dot-runs; trailing dots/spaces are dropped by Windows when it materializes a name, so a recorded path could disagree with the file on disk. The sanitizer now strips trailing dots/spaces and collapses every dot-run to the safe default, keeping the registry honest about what was written.
- **Opening and revealing downloads is a validated native boundary.** The capability grants `opener:allow-open-path` / `opener:allow-reveal-item-in-dir` had no path scope — a compromised webview could open or execute ANY local file with the system handler. New native commands `open_download_file` / `reveal_download_file` admit only paths inside download-engine folders (the platform default download dir plus an app-owned, restart-proof ledger of folders a download actually ran in or the user picked via `record_download_directory`), and the two blanket grants are removed from the capability file. Residual risk is stated in the security docs.
- **F-Droid package ids are validated at the boundary.** The id is interpolated into two pinned-host URLs; anything outside the store's own grammar (ASCII letters, digits, dots, underscores) is refused instead of being smuggled into a path.
- **A persisted resolver failure stays a failure.** The persisted-cache read path cast a `null` hit through an `as` and could hand a failure entry to the digest revalidator; it now returns `null` (a known-failed lookup that Retry purges) instead of `undefined` ("nothing recorded").

### Download manager
- **Cancelling one queued download can no longer evict its sibling.** Cancel and promotion matched by URL; the same file legitimately queued for two folders made cancelling one row remove the other's queue entry too, leaving a permanently "queued" row with nothing behind it. Queue entries now carry the panel row's identity (`localId`) and match on it.

### Resolver cache
- **The Retry contract's eviction guard now matches its documentation.** `evictFailedLookups` awaited a promise and then deleted by key alone — a fresh lookup stored under the same key while the await was in flight would be dropped instead of the stale failure. The guard now compares the exact promise it inspected.

### Frontend
- **TypeScript compiles under `strict`, `noUnusedLocals` and `noImplicitReturns`.** Fifty-four latent findings fixed, including a required `githubUrl` field that could actually receive `undefined` from the Add-App form, an unreachable-variable slug in the export preview, and dead imports/locals across the app. The type-level contract is now enforced on every future PR, not aspirational.
- The palette's "alternative to" subtitle interpolates through a narrowed local; the compare modal's unrated-app cell renders the same blank it always did, with a real guard.

## 1.0.0 (2026-10-14): the first stable release

Fress's first stable release. The application ships the complete, fully verified 1.0.x-beta line — the catalog, the verified in-app updater, the download → open boundary and the whole frontend quality pass from 1.0.12-beta — hardened with every regression fix that landed on the default branch after v1.0.12-beta. Version-wise this is a deliberate new beginning, not a regression: `1.0.0` is the **stable track**, tagged exactly as it reads, while beta development continues on its own prerelease sequence (the next one being 1.0.13-beta). SemVer ordering and the channel policy keep the two tracks apart; nothing in the release pipeline pretends that `1.0.0` is numerically newer than `1.0.12-beta`.

### Version coherence on real checkouts
- **The in-repo Android plugin crate's version is now actually coherent.** The feature branch carried `fress-open` at 1.0.10-beta in its manifest while the lockfile recorded 1.0.12-beta — a drift the version guard was built to catch but only gained the rule for after this branch's CI had already run. Both now record the canonical version, so the release binary's version surface agrees with `package.json` everywhere the validator looks.
- **`validate:versions` no longer false-fails after `tauri android init`.** Tauri CLI 2.11+ generates the Android project with a *delegating* `versionName = tauriProperties.getProperty("tauri.android.versionName", …)` instead of an inline literal, so any developer who ran `android init` locally got an unconditional "no parseable versionName" failure. The validator now recognizes that shape, resolves the authoritative value from the generated `app/tauri.properties`, and attributes the check row to the file that actually carries the version — a missing properties file, an unparsable or duplicated entry, an empty value, a literal mixed with a delegation, and a stale value all still fail closed with specific diagnostics.

### Android: the APK installer handoff below the open boundary
- **Completed APK downloads now install through Android's normal package installer.** The Android adapter promised by the 1.0.11 open-contract release landed: on Android the SAME `openCompletedArtifact` policy runs with one dep bound to a registry-validated native command (`open_downloaded_file`), which resolves the exact completed path against the download engine's session registry (the same discipline as the updater's signature verification - registry match, canonical stability, regular file, committed size; one uniform `open-artifact/not-registered` refusal for everything else) and routes `.apk` artifacts to the system installer via a FileProvider `content://` URI scoped to the app's `files/Download` directory, with a temporary read grant. The installer's own consent and unknown-source restrictions are never bypassed; every other artifact opens with a capable viewer or falls back to the share sheet, read-grant only. Failures surface through the existing typed-reason UI (`open-artifact/<code>` codes the boundary already parses), so Android refusals classify exactly like desktop ones.
- **The Android download directory moved under `files/Download`** (from the dataDir root) so the FileProvider can scope sharing precisely; APK installs declare `REQUEST_INSTALL_PACKAGES` via the new in-repo `fress-open` plugin, which makes the standard per-app "install unknown apps" consent reachable. The completed row keeps the contract's uniform "Open" action on Android (e2e hook: `download-open`; the D2 Android journey now records the adapter command in the shared bridge). A physical-device QA pass of `docs/testing/download-open-smoke.md`'s Android rows is tracked separately from mocked tests and stays visibly NOT RUN until executed on hardware.

### The last round of frontend hardening (everything that landed after v1.0.12-beta)
- **A white-screen crash is gone.** Manually adding an app with an empty repository URL could save `githubUrl: undefined`, and the next card render called `.includes` on it and blanked the whole page; the save path now stores an empty string and both consumers guard legacy data.
- **Keyboard and dialog stack repaired across the whole app.** Single-letter shortcuts no longer fire behind open dialogs, Escape in the export modal no longer tears down the entire stacked dialog set, palette arrow keys can no longer leave focus, highlight and Enter pointing at three different rows, More-menu items no longer strand focus on `<body>` after close, and the table view now confirms before deleting a custom app instead of doing it in one click.
- **Accessibility follow-through on the quality pass**: tab roles without the tab contract removed, five keyboard-unreachable scrollable regions made focusable, per-manager copy-chip names, `aria-controls` on What's-new disclosures, per-item Add button names, 24px touch targets, debounced result-count announcements, a persistent update-announcement region, and forced-colors (Windows High Contrast) support. The RTL flash on load is fixed via a pre-paint `lang`/`dir` bootstrap.
- **Download panel polish**: toast strings that could render their placeholders literally now interpolate, the live speed label reflects the actual transfer, and icon margins are RTL-safe.

### A stable release you can pin
- The release workflow refuses a tag that does not point at the exact commit being built, so a re-pointed or stale tag can never put bytes on a release.
- The stable/prerelease classification of a release now comes from the one authoritative version grammar the app itself accepts (`validate-versions.ts --is-prerelease`): plain `1.0.0` publishes as a stable GitHub release with stable-release notes, and any prerelease suffix keeps prerelease wording. The old hardcoded suffix list is gone.
- The no-Chinese source gate runs against the release candidate before anything is built or published; the release fails closed if the scan cannot run.
- The version-coherence validator pins every authoritative version field to `1.0.0` for this tag — package.json, both package-lock roots, Cargo.toml, the `fress` Cargo.lock entry and tauri.conf.json — and refuses any partial bump before the pipeline starts.

### Update channels: stable and beta stay separate
- This build defaults to the **Stable** update channel and, until you deliberately switch channels in the app's More menu, is only ever offered stable releases: `v1.0.12-beta` (a higher prerelease number on the other track) is never offered to stable clients. Your explicit channel choice is always respected — and the updater never downgrades you in the background: if your build is newer than the selected channel's newest release, it says so and links to the releases page instead.
- Beta clients are not silently downgraded to 1.0.0 by the updater; the beta sequence continues with newer prereleases on its own channel.
- **Coming from a 1.0.x-beta build?** Move deliberately, not automatically: run the v1.0.0 installer over your existing install on Windows (if you use the MSI, it may refuse the downgrade — uninstall the beta MSI first if it does) or replace the app on macOS; on Linux install the v1.0.0 bundle (deb/rpm need an explicit downgrade flag: `apt install --allow-downgrades` or `rpm -U --oldpackage`); on Android uninstall the beta APK first, which clears the app's private data. Desktop settings live in your user profile, not the install directory, and survive the transition.

## 1.0.12-beta (2026-10-13): the frontend-quality release

A full-frontend quality pass landed as one integrated candidate and was re-verified on the merged tree: typecheck clean, 650 unit tests passed (2 environment-skipped), the full E2E suite green in CI, and the production build clean — all proven on the exact tagged commit (CI run on v1.0.12-beta, 2026-10-13). Every change below was held inside the frontend; the download engine, the open contract and the release pipeline were untouched.

### Accessibility and semantics
- **Every interactive surface now names itself properly.** Modal titles, table headers, the export format group, the palette search field and the batch bar carry real labels and ARIA relationships instead of visual-only affordances; the catalog table announces itself as a table, and result counts are polite live regions so screen readers hear "showing 12 of 57" without stealing focus.
- Feedback that used to be color-only is now text-backed: destructive actions confirm their consequences, and the star-fetch and offline indicators explain their state in words, not just icons.
- A new `scripts/a11y-scan.mjs` pass plus a dedicated frontend-quality test suite pin these invariants, so a regression cannot merge quietly.

### Small screens and right-to-left
- **320 pixels is now a supported floor, not a crash site.** The batch action bar, catalog grid, export dialog and command palette reflow below 360px instead of clipping or scrolling sideways; new visual snapshots at 320px pin the layouts in both themes.
- Right-to-left layouts hardened across the detail modal, palette and header: icons mirror, truncation behaves, and the Farsi experience no longer inherits left-to-right assumptions from shared components.

### State behavior you can trust
- **Favorites and catalog edits no longer double-fire.** Side effects (toasts, storage writes) moved out of React state updaters into explicit, once-per-action paths with latest-value refs, so StrictMode and concurrent renders can no longer duplicate a toast or write storage twice. The callbacks keep their identity, so memoized cards don't re-render.
- Adding an app that already exists in the catalog now says so plainly (name or repository match) instead of silently creating a near-duplicate.
- The update-channel picker speaks five languages, and the palette's shortcut hint stopped inventing a modifier key it doesn't require.

## 1.0.11-beta (2026-10-13): the open-contract release

The download → open journey became real, then was proven as one integrated candidate: five parallel rounds (the desktop open contract, the end-to-end journey suite, executable version coherence, release-verifier hardening, user-facing docs truth) merged and re-verified together — full E2E suite 92/92, unit suite 605 passed, typecheck and build clean, and the new version validator green on the release candidate itself.

### Downloaded apps actually open (desktop)
- **One uniform native boundary.** Every completed artifact is handed to the OS opener with the exact completed path and the default handler — the OS association stays the authority, so Gatekeeper/UAC/package-manager checks stay in force. Open failures are typed and classified now (file gone, no handler, OS refused, unsupported) instead of one generic message; the row stays completed, the reason is explained in plain language, and the action stays retryable without re-downloading.
- **Linux AppImages launch for real.** Stock desktops ship no AppImage MIME handler and a freshly downloaded AppImage has no execute bit, so the generic open always refused. The frontend's one fallback retries below the same boundary with a registry-validated launcher: the command re-proves the artifact against the engine's own completion record (the claimed download id, the exact committed path, canonical location and size — staging shapes, traversal targets and symlinks are refused by construction), sets the execute bit on that validated file only, and spawns it directly (argv, no shell, reaped in the background so Fress can exit without killing it).
- **A launch in flight cannot be stacked.** The open action announces its busy state (aria-busy) while staying interactive, and a synchronous check-then-set guard makes a repeat activation a silent no-op: one click, one native launch, no double-fire, full recovery the moment the handoff returns.
- Android's APK installer handoff (FileProvider content URIs to the system package installer) is scoped to the Android adapter's own round, below the same boundary; until it lands, the frontend keeps the uniform pass-through and honest classified failures.

### The journey is pinned end to end
- **Workflow K (22 browser tests)** proves the complete download-to-open journey: the completed row hands the exact path per row (two concurrent downloads completing in reverse order can never cross-wire), keyboard-only activation lands exactly one launch per keypress with visible focus, spaces/Unicode/shell-metacharacter filenames pass through as single values, Show in folder reveals the file and degrades honestly to the containing folder when the explorer integration is missing, every refusal surfaces a typed error with the action left retryable, and the AppImage fallback receives the same id and path the opener refused with — once, with no retry loops.
- The E2E bridge records every `(boundary, id, path, with)` tuple that reaches the native layer, so a future regression in the opener wiring can no longer hide behind green state tests.

### Release integrity became executable
- **One version-coherence command** (`npm run validate:versions`) now guards all six authoritative version surfaces — package.json, both package-lock positions, Cargo.toml, the `fress` entry in Cargo.lock, tauri.conf.json — against one anchored grammar that mirrors the updater's own parser. Both workflows invoke it instead of re-implementing the rules in shell; the release pipeline additionally binds the pushed tag to the build version, and a development build is explicitly allowed to run ahead of the published release.
- **The release artifact audit refuses bad input loudly**: duplicate JSON keys in latest.json are a hard error instead of silent last-wins, every advertised platform must match its asset's OS shape, and a malformed manifest fails with a named reason instead of a Python traceback. Twenty new verifier tests pin the refusals.
- The VirusTotal job's skip is labeled as informational on the release page, never mistaken for a clean scan; the quality-gates runbook was rewritten to describe exactly what the workflows actually run.

### Docs tell the truth
- README and CODE_SIGNING were rewritten against the actual published release bytes: the per-artifact signing matrix (what carries a minisign signature, what does not, and what that means for in-app updates), macOS Gatekeeper first-launch behavior, Android's same-key upgrade rule, and the honest explanation of Windows' "Unknown publisher" warning.

## 1.0.10-beta (2026-10-12): the contrast-acceptance release

Four quality threads (native engine tests, updater delivery truth, audit honesty, i18n/a11y acceptance) merged and were then re-verified as one integrated candidate by a fresh visual acceptance round — 46 harness tests and 67 screenshots across both themes at every supported width. Every fix below was reproduced on the rendered app before it was coded, and every re-capture is kept as evidence.

### Interface: every state is readable
- **The command palette's selected row reads in light mode.** The selection highlight paints a solid cocoa band, and the row's paper-calibrated inks sat on it at 1.06:1 (description), 1.12:1 (the "vs proprietary" chip) and 2.53:1 (the name). The selection surface now carries its own measured ink family — primary text, soft secondary text and an amber accent for the chip — held at AA in both themes and pinned by automated contrast assertions.
- **App names never disappear from the palette.** On narrow windows the "vs proprietary" chip could push the app name to zero width on every row and clipped mid-word at the dialog edge. The name keeps its space first; the chip truncates with an ellipsis.
- **Dark-theme primary buttons hold WCAG AA.** White labels on the Add-App button, the dialogs' primary actions, their hover states and the downloads count badge measured 4.02:1 and 2.71:1 on the default oklch sky steps; the dark theme now pins steps that hold 5.93:1 and 4.92:1, with the light theme's verified steps unchanged.
- **The update pill's tooltip tells the same truth as its label.** After the planner refuses an in-app delivery the pill says "see the releases page" — the static "tap to download" tooltip would have contradicted it. A cancelled update transfer also reconciles quietly now instead of hanging the pill, and the tooltip follows the live state in every phase.
- **The export preview is keyboard-scrollable.** The generated script/export region was focusable to the mouse only (a serious axe finding); it is now a labeled, tabbable region.
- **Privacy Pack labels match their content.** The "You use now" triggers and replacement pickers are named from the exact string they render (plus the counter), so speech-input "click Gmail" matches; the download panel's SHA copy control includes the visible hash in its accessible name; the Privacy page owns a real h1 heading.

### Engine and updater: the record contract, completed
- **The download registry records what the engine proved about its bytes.** Every completed artifact now carries the engine's own checksum verdict (`verified` only when a publisher-supplied digest matched, honestly `unverified` otherwise; a mismatch can never leave a record), and the signature verifier's diagnostics quote that provenance — for the caller's own download only. New end-to-end tests pin that two concurrent downloads can never read each other's records and that a failed verification mutates nothing in the registry.
- **The CI version guard also pins `Cargo.lock`**, so a stale lockfile can no longer ship an old crate version inside the binaries, and the scheduled live-network smoke test actually runs now (its first scheduled execution failed collection on a wrong path; the manual dispatch passed all four probes).

### Honesty of the audits
- A quota-exhausted GitHub answer is its own "inconclusive — re-run later" class in the catalog audit, separate from "missing" or "dead"; the tool tolerates non-JSON bodies and keeps real status codes.

## 1.0.9-beta (2026-10-12): the verified-delivery release

The updater's three trust layers (strict version parsing, the native minisign verifier, the checksum-checked download engine) existed side by side, but the real delivery flow never called the verifier. Now it does: an in-app update is called "verified" only after every gate has passed against the artifact that is actually being delivered, and the release pipeline audits its own published bytes before publishing them.

### Self-update: signature verification in the real delivery flow
- **One delivery lifecycle with explicit states.** Tapping update runs a three-gate plan (platform-matched asset + published SHA-256 entry + a well-formed minisign sidecar for that exact filename), fetches the sidecar document fresh on every attempt, downloads through the same verified engine as every other file, and only then calls the native signature verifier on the engine-reported completion path — bound through the download manager's own records, never a UI label. Every outcome has a distinct, localized state: fetching-signature, downloading, verifying-checksum, verifying-signature, verified, and explained failures with the Releases-page fallback. Verification success reveals the artifact; it never launches it.
- **The verifier is scoped to completed downloads.** The native command no longer accepts an arbitrary filesystem path: every successful, hash-checked commit leaves a bounded record (path, canonical path at completion time, size, source URL), and verification re-resolves that record — refusing staging `.part` files, moved or replaced artifacts, symlink swaps, size changes, and anything the engine never completed. The refusal message is generic, so the boundary leaks nothing about unregistered paths. The signature is verified over the bytes actually read from the opened file, so an edit between metadata checks can only fail the verdict, never fake one.
- **A checksum failure stays honest and retryable.** A transfer whose bytes don't match the published digest stays in the download manager as a failed row with a fresh Retry — the same contract the E2E suite already pinned; nothing opens automatically and no verified state is ever rendered. Unsigned platform classes (macOS dmgs, Android APKs) route to the Releases page with the reason spelled out.
- **Two new browser-level trust scenarios**: a release with no sidecar for the platform artifact (releases page with the "unsigned" reason, empty download registry) and a cancelled update transfer (quiet return to the available state — no failure theatre, no fallback, no verified claim).

### Release pipeline: the release audits its own bytes
- **`verify-release` runs a final-artifact audit on the exact bytes about to be published**: checksums both ways, `latest.json` cross-checked against assets and sidecars, every sidecar cryptographically verified against the production minisign key with a self-checked pure-Python RFC 8032 verifier, and unsigned artifact classes must carry no sidecars. The required-asset list now blocks on `latest.json` and the signature sidecars.
- **`latest.json` drift is root-caused**: `pub_date` was wall-clock, so re-running the manifest job alone invalidated the published checksums. It is derived from the release object now — re-runs are byte-stable.

### Interface: the acceptance round
- **The header survives 200% browser zoom.** At narrow CSS-px widths the Downloads button clipped its label mid-word against the More menu; the label now appears only when the row has room, with the icon-only button (labeled via title and ARIA) below it.
- **Amber warning text holds AA in light mode.** The light theme deepens amber for badge fills, and three texts still rendered with those fill steps (the detail dialog's weak-pick hint at 2.86:1, the export dialog's copy-failed feedback and the batch modal's skip note at 2.20:1) — they use the deep text step now. The header update pill measured 1.65:1 in light; it uses the verified badge recipe (6.75:1) with dark unchanged. All pinned by new automated contrast gates.
- **The command palette's listbox is honest ARIA**: the contextual copy control and the empty state live outside the `role="listbox"` (a listbox may own only options), stale "Copied" feedback cannot survive a reopen, the footer speaks five languages, and the FilterBar and spotlight are named landmarks.
- **The Android device contract is pinned at the UI seam**: nine tests cover the device-default platform filter, the stored user choice winning over it, the WebView signal, and the Android download manager never offering a folder picker.
- **The catalog audit tells the truth about failures**: an unreachable F-Droid API is reported as an informational connection failure, not a catalog error — a sandbox timeout is never proof a package is dead.

## 1.0.8-beta (2026-10-12): the integration release

Six parallel quality threads land together and are verified against each other: the updater's candidate selection becomes deterministic and architecture-safe, release artifacts gain a tested minisign verification path, the last data-driven English strings speak five languages, the catalog cards and table finish their visual contract, and CI learns to run the full browser suite on every pull request. One real user-facing bug this round fixed: an ARM-only release could be delivered to an Intel machine as a fully "verified" download — the delivery layer now refuses any release that ships no file the running machine can execute.

### Self-update: deterministic selection, strict versions, artifact signatures
- **Versions parse strictly, anchored on both ends.** The old pattern matched the `1.0.7` prefix of `1.0.7junk`, so trailing junk rode into the candidate list as a stable release. Leading zeros, empty identifiers and unparsable tags are rejected now, and a malformed tag is eligible on NO channel — it used to stay visible on every channel including Stable. Build metadata never affects precedence (SemVer rule 10).
- **Asset selection happens in two explicit phases.** Hard platform/architecture/role gates decide what MAY be delivered at all; scoring only ranks the survivors. The old single-pass scoring kept ineligible assets alive at low scores, and because the scan started at −Infinity a lone ARM64-only dmg could win on an Intel Mac. Ranking is architecture-certainty first with a final lexicographic tie-break, so permuting the release's asset list can never change what you get.
- **The ARM-only worst case is closed.** This defect was pinned as an expected failure in the E2E suite (`test.fail`) against the old picker: on an x64 host, an ARM64-only release resolved to an uninstallable file — and with a published checksum it arrived as a fully "verified" download. The hard gate refuses it; the pill now routes to the Releases page, the annotation is lifted, and the test keeps passing.
- **Wrong-ABI Android files are refused, not merely ranked.** armv7 apks on arm64 devices and x86 apks on x86_64 devices stay documented compatibility paths; everything else is a guaranteed install failure and can no longer survive as a low-ranked candidate that wins by being alone.
- **Artifact authenticity: a native minisign verifier.** `verify_self_update_signature` streams a completed download through `minisign-verify` (the Tauri updater's own crate family) against the public key embedded at compile time — the same key CI signs the Windows installers and Linux bundles with, byte-identical to the one published in `tauri.conf.json`. The v1.0.7 signatures were downloaded and verified against it row by row; the audit table lives in CODE_SIGNING.md. Legacy (non-prehashed) signatures are refused.

### The last untranslated surfaces
- **Privacy Pack category names come from one shared mapping.** All 28 category names resolve through `PP_CATEGORY_I18N_KEYS` — card headings, ARIA labels, dropdown triggers, clear buttons and the picked-list label — so a second English display list can never grow back. A CI gate fails when a `PRIVACY_PACK` name lacks a mapping or a dictionary lacks the translation.
- **Download-option labels translate at render time.** The per-app data file keeps its English labels as identifiers (the fallback filter compares against them), while the words you read follow the active language; product proper nouns stay and only the glue word translates ("Thunderbird for Windows" → "Thunderbird für Windows"). The translated label travels with the download record, so the download list names the entry exactly as the button you read.
- **The detail dialog's category badge, the export dialog and the last "Close dialog" ARIA labels speak five languages** through the same shared mappings the cards and filters already use.

### Visual contract, verified against the rendered app
- **Card and table category labels use the shared translation.** A Persian or German UI no longer shows an uppercase English category string on every card — the same label the filters, compare matrix and detail dialog use.
- **Ghost text is readable.** The table's zero-star placeholder and "Direct download" label sat at ~1.2:1 in light mode (decorative `slate-600` used as text); the resolver-error note and the F-Droid CTA in the detail dialog carried near-invisible inks on their tinted wells in light mode. All ride proper per-theme text tokens now, with contrast tests pinning them.
- **Long app names cannot break the card.** The two-line clamp used to sit on the heading and was defeated by the inline-block button inside it — a 96-character stress name grew the card to four lines. The clamp lives on the button now, with the full name in a tooltip.
- **The theme menu closes when you pick a theme** (every other item in that menu already did).
- **A full-disk download leaves a correct `.part`.** The retained partial file is flushed before the failure returns, so a resume can never start from an offset computed off a half-landed buffer.

### Catalog resolver: order-invariance under adversarial shuffles
- New fixtures seed 35+ deterministic shuffles of a release carrying every decoy family the live audits found in the wild — source archives, wrong arch, wrong OS, help/lang packs, debug builds, CLI companions, server products, signature/checksum/blockmap exhaust — and assert the one correct installer wins in every order, on Windows and Android. The export dialog also stops swallowing clipboard failures: a refused copy now shows "Copy failed" with the button still usable.

### Native engine: evidence, not behavior changes
- 718 lines of adversarial test evidence for the download engine and network policy — production code untouched (verified hunk by hunk). The mock HTTP server learned `If-Range`, so conditional-resume behavior is now exercised end to end: matching validators resume, stale validators restart, and the resumed byte stream is proven coherent.

### CI runs the real app now
- **The full Playwright suite (workflows A–J plus 20 reviewed visual baselines) is a required CI job**, running against the production build with a deny-all fixture network layer — shared GitHub quota can never flake a pull request. A weekly scheduled live-network smoke complements it without being a release gate.
- **Performance invariants are a required gate**: zero unrelated card mutations during a 1000-event progress burst, persistence writes inside the coalescing bound. Wall-clock numbers are recorded as informational artifacts only.
- **`validate:security` is required, and the version guard pins both lockfile spots** — package-lock.json records the version twice, and a drifted lockfile would ship a mismatched `npm view`.

## 1.0.7-beta (2026-10-12): the machine-truth release, and a polished surface

Three threads land together. The app now asks the MACHINE for its architecture instead of trusting the process, so Windows-on-ARM machines stop being treated as x64 by the updater and the catalog. The self-update chain was pinned end to end: the checksum file that was CORS-dead code in every shipped release is fetched natively now, and an update that cannot be verified is not delivered through the app at all. And the interface finished its polish pass: light-theme text now meets WCAG AA by measurement (enforced by tests), every dialog speaks five languages and behaves under a keyboard, and the download engine gained adversarial test coverage with one real IPv6 policy fix.

### Windows on ARM64 — the app asks the machine, not the process
- **`host_arch` reports the native machine architecture now.** `GetNativeSystemInfo` replaces compile-time arch: the x64 build running under emulation on a Windows-on-ARM machine used to report `x86_64`, so both the self-updater and the catalog resolver treated the whole machine as x64. ARM64 hosts get ARM64 builds offered, and catalog apps prefer their native ARM builds when they ship one.
- **Hyphenated architecture names are understood.** The classifiers only matched `x86_64`/`arm64`/`aarch64` — not LocalSend's `x86-64`/`arm-64` spelling, which even scored its installer as a 32-bit build.
- **A `-CLI-` companion can no longer impersonate the app.** On an ARM64 host, `LocalSend-CLI-…-windows-arm-64.exe` used to win the scoring while the real app was penalized as "32-bit"; CLI assets are refused before scoring now, verified against the live LocalSend manifest.
- **Batch-download skips stopped being a dead end.** The skip toast now carries an **Open official pages** action that opens each skipped app's official download target, in all five languages — a GitHub rate-limit blip no longer reads as a joke.

### Native download engine and network policy (adversarial round)
- **The IPv6 public-address classification is registry-complete.** One gate confines connectable destinations to native global unicast in `2000::/3`; the IANA special-purpose assignments inside it are refused explicitly (IETF protocol assignments, documentation ranges including the full `3fff::/20`, decommissioned 6to4/6bone, SRv6). A review fix corrected the `3fff::/20` mask from a /28 to the registry's /20, with boundary regression tests on both sides of every refusal.
- **Redirect hops to private address literals are named and refused** per policy class, instead of surfacing later as an anonymous connect failure. DNS answers are trusted for reachability, never identity; every hop is re-checked.
- **A full-disk download is final, honest, and resumable.** Mid-write and fsync failures are categorized non-retryable (the retry loop can never misread a local disk-full as a server problem), keep the `.part` for an explicit Resume, and the OS reason travels in the message. Cancel-during-verify is documented as ignored by design: the phase has exactly one terminal outcome.
- **The staging seam makes failure testable without dependencies.** Production bytes flow through the exact same `tokio::fs` calls as before; a scripted sink drives a real mid-write ENOSPC end to end. New adversarial tests: stall-timeout on a paused clock, pre-canceled transfers, corrupted and foreign resume sidecars, cancel-vs-completion races.

### Self-update trust chain
- **Checksum verification is no longer dead code.** `github.com` sends no CORS headers, so the WebView fetch of `SHA256SUMS.txt` failed in EVERY shipped release and every self-update silently degraded to "unverified". The reads now go through a native command with the same rails as the rest of the native layer (HTTPS, GitHub-host allowlist, per-hop re-check, Fress-repo path pin, 2 MiB cap).
- **A missing checksum fails CLOSED.** When the published SHA-256 entry cannot be established, both update buttons open the Releases page instead of delivering an unverifiable installer — one shared decision function so the header pill and the footer button cannot drift.
- **The CSP tells the truth.** `https://github.com` left `connect-src` (it never worked from the WebView), enforced by the security validator; README and CODE_SIGNING.md no longer claim a timestamped signature the shipped installer does not carry.

### Accessibility and dialogs
- **One Escape closes one layer.** A stacked focus contract gives the topmost open surface ownership of Tab and Escape; focus restores across palette-over-dialog stacks and survives close. Background scrolling locks while any modal is open and unlocks when the last one closes.
- **Every dialog is named and localized.** All ten modals carry `role="dialog"`, `aria-modal`, accessible names, and five-language strings — plus honest failure states in the detail dialog (loading / none / rate-limit / network, each with the right recovery) and truthful download states.
- **The retry seam became real.** The dialog's Retry evicts exactly the failed lookup (session memo + persisted failure) for the one app|platform asked about and performs a fresh network request; successes and unrelated apps stay cached.

### Catalog truth pass (audited live against real registries)
- Renamed repos referenced canonically, dead package-manager commands corrected, six dead download pages re-pointed, source archives can no longer pose as the app, wrong-product and junk assets are hard-refused, trusted digests are bound to their exact file, and the resolver speaks a typed outcome contract. The full 75-entry × platform × arch live probe matches pre-change verdicts row for row.

### Interface polish
- **Light theme meets WCAG AA by measurement.** Every real-text token holds 4.5:1 on the surfaces it renders on (secondary text, category labels, metadata, links, muted table content, danger text), with seven automated contrast assertions in CI; `slate-500` is documented decorative-only so hierarchy survives.
- **The green Download button is readable in both themes.** White text on `emerald-600` measured 3.77:1 — it now rides `--fr-success-strong` (emerald-700/800, 5.48/7.68:1).
- **Two latent ink bugs fixed.** The amber trending badge and the selected Android chip used `text-slate-950`, which redefines to warm PAPER in light mode (1.95:1); both now pin proper ink per theme.
- **The compare tab's install command no longer reads as a black stripe.** Three ad-hoc `bg-black/40` code wells became one token-driven `--fr-inset` material (compare, export, batch previews) — quiet in dark, warm in light.
- Revalidation: no horizontal overflow at 320–1920 px in both themes, one content boundary, grid ladder 1/2/3/4 columns, cards and table aligned, and the page-switch scroll fix holds after a deep scroll.

A live audit of all 75 catalog entries against the real GitHub, F-Droid, winget, Homebrew, Scoop and Flathub infrastructure found the quiet rot that time leaves behind: repositories that were renamed, package ids that moved, and package-manager commands that can no longer succeed. Every one is fixed, plus one asset-picker leak and two screen-reader gaps.

### Fixed (resolver/catalog continuation, audited live 2026-10-12)
- **Package commands now install the product the entry describes.** The Jellyfin entry is the desktop client (its repo is `jellyfin/jellyfin-desktop`), yet its winget, Homebrew and Flatpak commands all installed the headless SERVER (`Jellyfin.Server`, cask `jellyfin`, `org.jellyfin.JellyfinServer`). They now carry the verified client ids: `Jellyfin.JellyfinMediaPlayer`, cask `jellyfin-media-player` ("Jellyfin desktop client"), Flathub `com.github.iwalton3.jellyfin-media-player`.
- **Two Homebrew casks were renamed and the old tokens fail outright.** `brew install --cask handbrake` and `--cask ollama` return 404 in homebrew-cask today; the GUI apps live at `handbrake-app` (v1.11.2) and `ollama-app` (bundles the CLI). Both commands re-pointed, with audit comments in the data.
- **Retry actually retries.** The detail modal's Retry path (`retryGitHubResolve` / `retryFdroidResolve` / `retryOfficialResolve`) evicts exactly the failed lookup from the session memo and the persisted failure store, then re-runs one app|platform lookup — a live test proves a fresh network request happens and recovers once the outage ends. Successes and unrelated apps are never invalidated, and failure records are cleared at the start of each new run so a genuine "no build here" is never misreported as an error.
- **The resolver speaks a typed outcome contract.** `resolveWithOutcome()` returns `ResolveOutcome` — resolved (confident vs weak), no-match, unsupported, failed (rate-limit / network / api), or official-page — so the UI can distinguish a rate limit from an honest "no Linux build" without string-matching, and offer the right action (retry vs page link vs nothing).
- **Cache keys carry every selection input.** The resolve-cache key now includes the app's asset-naming overrides (on top of repo, platform, tag-stream pattern and prerelease vouch, with the host arch in the persistent store), so editing an override can never serve a pick cached under the old rules.
- **Trusted digests are bound to their file.** Vendor checksums (GIMP's manifest, etc.) attach only through `attachTrustedDigests()` — same manifest row, same download. Malformed digests are discarded with a recorded diagnostic (and re-validated coming out of the persisted store); absence stays unverified, never "verified".
- **Wrong-product assets are hard-refused, not merely scored down.** Server binaries are refused for desktop-client selections (with a vouch for apps resolving from a repo named `*server*`), help/language packs and debug builds never rank (with a documented exception for Termux's `+github-debug` release flavor, which IS their stable APK naming), and a low-confidence score can never resurrect a hard-incompatible file. The full catalog × platform × arch live probe matches the pre-change verdicts row for row (322 confident picks, zero deltas).
- **Catalog validation catches more of what hands get wrong.** Package-manager ids must now match their registry's canonical shape (winget `Publisher.Package`, flatpak reverse-DNS, …), F-Droid/Play ids must be unique across entries, tag-stream patterns are validated like asset patterns, patterns that would be silently disabled by the safe-regex subset are errors, and the warning policy (13 re-checked single-platform entries) is documented in the validator.

### Fixed
- **Renamed GitHub repos are referenced by their canonical names.** `jellyfin/jellyfin-media-player` → `jellyfin/jellyfin-desktop` (with the entry's star count corrected to the linked repo's real value), `ente-io/ente` → `ente/ente` (Ente Photos and Ente Auth), `Catfriend1/syncthing-android` → `researchxxl/syncthing-android` (the Syncthing-Fork), and `calcom/cal.com` → `calcom/cal.diy`. GitHub redirects kept the old names working, but a rename can be recycled — the catalog now states the truth.
- **Dead package-manager commands removed or corrected.** `RustDesk.RustDesk` was removed from winget-pkgs (removal commit 2026-03-27), `mifi.LosslessCut` never had a winget manifest, and DevToys is in no Scoop bucket — those commands would always have failed, so they are gone (the remaining managers still cover each app). balenaEtcher's winget id is now correctly cased (`Balena.Etcher`), LocalSend's Flatpak id is `org.localsend.localsend_app` and Tuta's is `com.tutanota.Tutanota`, matching their current Flathub listings.
- **Six dead or moved download pages re-pointed at live ones.** LibreOffice (`/download/download-libreoffice/`), LibreWolf (`/installation/`), SimpleX (`/downloads/`), Cake Wallet (GitHub releases — the site no longer hosts a downloads page), Immich (`docs.immich.app/install/script`), and NocoDB (GitHub releases).
- **Source archives can no longer pose as the app.** The asset picker already excluded `-source-`/`-src-` files (the HandBrake incident), but the plural slipped past: OBS Studio's `-Sources.tar.gz` was the last-resort pick for Linux hosts of any architecture when a release carried no Linux binary. The name filter now catches `-sources-` too, a regression test locks it in, and hosts with no Linux build fall back to the project's own download page instead of a source tree.
- **Two modals are real dialogs for screen readers.** Batch Install and Export rendered without `role="dialog"`, `aria-modal` or an accessible name — inconsistent with the other seven modals and invisible to assistive technology as a modal. All three attributes are in place now.

## 1.0.6-beta (2026-10-11): a catalog that uses its desktop, and a table that speaks

The main window learned what a 1920-pixel monitor is for. Header, hero, filter bar and catalog now share one wide content boundary, the grid grows a fourth column on large desktops, and the last untranslated surface — the table view — speaks five languages. A long-standing page-switch bug is fixed with a regression suite. Nothing about what Fress does with your data changed: filters, favorites, batch selection, comparison and every download behave exactly as before.

### Added
- **A desktop-width catalog.** One shared content boundary (1536px) unifies the header, spotlight, filter bar and catalog; on large desktops the grid grows to four columns while a ~365px card stays comfortably readable, keeping three columns on medium desktops, two on tablets and one on phones. Zero horizontal overflow verified at every width from 320 to 1920 pixels, dark and light.
- **Touch-sized controls.** Every icon-only control on the cards and in the table — compare, edit, delete, bookmarks, source links, checkboxes — grows to a 44px touch box on coarse pointers while desktop keeps its compact density.

### Changed
- **Cards are fully keyboard-operable and fully translated.** The application title is a real button inside the heading (a clickable heading was invisible to keyboards and screen readers), every tooltip, accessible name and toast on the card speaks five languages — including the download flow's "showing the download options" and "opening the official download page" notices, the last hardcoded strings flagged in 1.0.5.
- **The table view joined the design system.** Column headers, the copy-command control, the direct-download marker, the pick/trend badges and the versus chips are translated; platform names use the same localized words as the filter bar; taglines respect per-language overrides for custom entries; and every row's name is a keyboard-focusable button. Surfaces, borders and focus rings come from the shared tokens.
- **One focus look everywhere.** The filter bar's thinner ring was the last deviator; every focusable control in the app now shares the single 2px outline treatment, and the app root, card surfaces and filter bar ride the semantic token layer end to end.

### Fixed
- **Switching Apps ↔ Privacy Pack no longer buries the heading.** Scrolling deep into one page and switching to the other kept the old scroll offset, so the fixed header covered the new page's title; every page change now lands at the top instantly, view-mode toggles still never scroll, and a four-test regression suite (including "switch pages after a deep scroll") locks it in.

## 1.0.5-beta (2026-10-11): a coherent interface, and downloads that run quiet

The interface got a real design-token system, a header that knows what is primary, and catalog cards that keep their footing while transfers stream — while the download engine stopped writing to storage on every progress tick. Nothing changes about what Fress does with your data: favorites, filters, the download folder, the custom catalog and every download you had running behave exactly as before.

### Added
- **Semantic design tokens under the interface.** A `--fr-*` role layer (background, surface, elevated surface, text, muted text, border, primary, success, warning, danger, focus) is registered as real Tailwind utilities and themed for both the dark and the warm-paper light mode. The header, hero, empty state and shared controls now style by meaning instead of by whichever slate step looked right, and a documented size scale gives main actions, secondary controls, inputs and mobile touch targets consistent heights.
- **A universal More menu.** Every utility is reachable on every screen size through one menu with labeled groups — Section and View, Catalog & data (backup, restore, README export, batch generator), Updates (What's new, check now, channel), Download folder, Language, Theme and Help. The theme toggle moved into it, the 768–1023px band finds its section tabs there, and nothing is hidden without an equivalent route. The menu announces its state (`aria-expanded`/`aria-controls`), closes on Escape with focus returned to its button, and closes on outside click or item activation.
- **A skip-to-content link.** The first focusable element on the page jumps straight to the catalog, and the content area accepts focus so the jump actually lands.
- **Real catalog counts in the hero.** The spotlight states what Fress is in one heading and one honest sentence, then shows live numbers: how many open-source apps the catalog holds and how many of them ship Android builds. No buttons, no second navigation.
- **An empty state that answers three questions.** When a search or filter combination hides every app, the screen says so, offers Reset as the recovery action and Add a missing app as the secondary route; when the catalog itself is empty, the filters story is dropped honestly because resetting cannot help.

### Changed
- **Streaming downloads no longer hammer storage.** Terminal states (completed, failed, cancelled, page opens, removals) flush immediately; ordinary progress snapshots coalesce on a 750ms window that never starves a continuous transfer; and because the persisted payload only contains what survives a restart, identical payloads never touch storage at all — a streaming download performs zero writes. A refused write (full quota) retries once with the newest 20 entries and degrades to "panel forgets on close" without ever touching the running download. Quitting right after a terminal event cannot lose it: unmount and pagehide flush once.
- **Cards stop processing every transfer update.** Download state was split into focused subscriptions: actions (stable identities), a summary (active count + folder) and the live item list (download manager only). Each card subscribes through a selector store whose snapshot is the per-app boolean — a byte-count update re-renders zero cards, and a start or finish flips exactly the one matching card. The grid is memoized behind stable callbacks, and favorites/batch/compare membership checks are O(1) Sets now.
- **Redesigned catalog cards.** Icon (38px), clamped name and at most the two curation badges on top; a quiet uppercase category label under the name; the Custom badge moved to the metadata row; stars, license, the proprietary alternative it replaces, the offline marker and the custom marker always in the same order with platforms at the edge; one dominant Download button per card with quiet source icons beside it. Descriptions reserve a fixed two-line height so adjacent cards keep their metadata and footers aligned, and broken artwork falls back to a designed letter tile instead of an empty gap.
- **The removal confirmation speaks five languages.** "Remove {name} from your library?" and its action are real translations now, the dialog starts focus on Cancel — never on the destructive button — and Escape dismisses it.

### Fixed
- The skip-to-content link rendered its raw key string (`a11y.skipToContent`) because the key never landed in the dictionary; it is translated in all five languages now, and the key-coverage scan keeps every `t()` reference pinned to a real entry.
- The CI test gate crashed on Node 20: jsdom 30 requires Node ≥ 22 and imports undici, whose module-load path calls a function Node 20 does not have. The gate runs jsdom 26 now, and all 284 tests load cleanly on it.
- The lockfile's root version trailed the release bump (1.0.3 while package.json said 1.0.4); every version-carrying file including the lockfile is bumped together from now on.

## 1.0.4-beta (2026-10-11): the app speaks five languages — filter bar, palette, and a download context split

The last English-only corners of the interface are localized now, and the download context grew a real API boundary. Nothing about how filtering or downloading behaves has changed: the categories and platforms you select, the platform filter your device remembers, and the favorites you keep are all the same values as before — only the words around them learned five languages.

### Added
- **Complete UI localization (91 new keys × 5 languages).** The filter bar, the command palette, the header, and the detail modal's source/license metadata were hardcoded English; every label now ships in English, Persian, Spanish, French and German as real translations — never English copied into the other dictionaries. A dictionary parity test locks the five languages to identical key sets, so a missing translation fails CI instead of shipping.
- **Screen-reader announcements that translate.** The download panel's live summary accepts a translator (its default English output is pinned by tests), the filter bar announces result-count changes politely instead of interrupting, and the download progress bar carries proper progressbar ARIA plus a localized hash-copy label.

### Changed
- **The filter bar separates domain values from labels.** Category and platform chips keep their internal values — filter state, the persisted platform filter, and the keyboard shortcuts behave exactly as before — while rendering translated labels. The sort select, quick filters, reset button and the group aria-labels all read from the dictionary, and the comment declaring hardcoded English "a design choice" is gone with the assumption it described.
- **Touch ergonomics on phones, density on desktop.** Mobile filter controls get roughly 40px touch targets and visible keyboard-focus rings while desktop keeps its compact rows; the platform row keeps scrolling sideways instead of wrapping, and the selected-platform auto-centering is scoped to the mobile container and direction-aware, so it works right-to-left in Persian.
- **The download context is split into state and actions.** `useDownloadState()` (items, active count, folder) and `useDownloadActions()` (start, cancel, retry, open, ...) replace the twelve-member aggregate context. Every caller — the header badge, the download manager, app cards, the detail modal, the footer, batch selection and the app shell — migrated and verified, and the legacy `useDownloads()` hook is retired now that its migration condition is met.

### Fixed
- **Duplicate DOM ids in the filter bar.** Platform chips, quick-filter toggles, sort controls and the result counter each rendered twice (mobile row + desktop row) with shared ids, so `document.getElementById` could never be trusted. Every id is layout-suffixed now, the scroll effect queries inside the mobile container by ref, and a server-render regression test fails the build if any rendered id is ever duplicated.

## 1.0.3-beta (2026-10-11): the hardened engine — nine audits merged, vendor checksums verified

Nine independent hardening and refactor rounds landed in one release, and the download engine learned to check the publisher's math. Every byte of every download now flows through a policy-validated network stack, files are assembled transactionally, and where a vendor publishes a checksum in the same manifest that named the file, a download that fails it is deleted before it can look finished.

### Added
- **Vendor checksum verification, end to end.** Signal's electron-updater feeds, Proton's `version.json` and GIMP's `gimp_versions.json` publish a per-file hash right next to the download URL; the resolver now carries that hash (SHA-256 and SHA-512, including electron-updater's base64 encoding) into the download engine, which verifies the finished file and deletes any that fails. The same contract covers single downloads, batch downloads and the app's own self-update (verified against the release's published `SHA256SUMS.txt`). A corrupted or tampered download can never present itself as done.
- **An authoritative native network policy.** Before a download starts, the URL is admitted under an executable-download policy inside Rust: malformed URLs, cleartext http, embedded credentials, private and loopback address literals and localhost names are refused at the gate, redirects are re-validated per hop, and connections stay public-address-only. The engine's HTTP client is the policy's client — SSRF- and rebinding-resistant by construction, not by convention.
- **A transaction-safe download engine.** Downloads stage into `.part` files with validator sidecars, resume only against a proven byte-identical origin (strict `Content-Range` checks), and finalize through an atomic no-clobber commit — two downloads finishing the same name can no longer destroy each other, and a finished file never appears half-written. The engine is a self-contained, unit-tested module with an explicit state machine.
- **Rust is tested in CI now.** Every pull request and every main push runs the Rust test suite on every desktop platform Fress ships for, plus formatting and lint gates; release workflows are SHA-pinned and least-privilege.

### Changed
- **The frontend and the engine were decomposed.** `App.tsx` went from 1,245 lines to a composition shell, `releaseFetch` became a facade over focused `release/` modules (providers, matching, caching, types), and the download engine moved out of the Tauri monolith into `download_finalize.rs`. No behavior drift: characterization tests landed before the extraction.
- **Imported regex overrides are boundary-checked.** Patterns coming from backup imports and custom entries pass a safe-subset analyzer that targets the catastrophic-backtracking class; the shipped catalog's patterns are compile-audited by test.
- **Tauri capabilities are least-privilege now.** Every plugin permission in the capability file was re-verified against the actual frontend call sites and narrowed to exactly those, the CSP was hardened to the audited dist output with `freezePrototype`, and the previously-dead "Open file / Open folder" buttons work again.
- **Accessibility pass.** Icon-only controls carry real names, the filter bar is a labelled group, and download progress is announced to screen readers.

### Fixed
- The download engine's extraction initially dropped the `serde::Serialize` derives that compile the event payloads (caught by CI, fixed before merge); the integration of the policy layer and the engine moved download-path validation into the plan itself so no download can bypass it.
- The compare button in the app card now tells screen readers whether it adds to or removes from the comparison matrix, instead of reading the same either way.



## 1.0.2-beta (2026-09-26): every entry downloads, no "go look it up" left

The catalog-wide download audit finished the job the earlier rounds started: every app, on every platform it claims, now hands you a real file (or, where a project genuinely ships no binary, its official package channel). Fifty-two desktop rows and seven Android rows used to dead-end in a download page; they resolve to exact installers now, read live from each project's own manifest infrastructure.

### Added
- **A third resolver source: the vendor's own download infrastructure.** Projects that distribute outside GitHub resolve through their own manifests now, not through a marketing page: Tor's per-platform update manifests (Windows, macOS, Linux and every Android ABI), Signal's electron-updater feeds with exact sizes plus its Android `latest.json`, Proton Mail's `version.json` (the Stable channel, never Early Access), Zotero's stable download endpoint, GIMP's official `gimp_versions.json`, Blender's, Krita's and Kdenlive's mirror directory indexes, LibreOffice's stable tree, Nextcloud's desktop CDN, Element's installer directory, LibreWolf's GitLab releases, SumatraPDF's download page and Inkscape's Windows installer via its winget manifest. Every pick was verified live against the real endpoints, and the picks re-resolve on every release, so nothing rots.
- **Per-platform repository overrides.** Projects whose downloads live in a different repo than their front page now say so in the catalog: Ente Photos' desktop app comes from `ente/photos-desktop` (which also kills the wrong-app Ensu pick for good), Bitwarden's Android APK from `bitwarden/android`, Home Assistant's companion app from `home-assistant/android`, Proton VPN's macOS and Android builds from their own repos, and Element's Android app from `element-hq/element-x-android`.
- **Honest platform claims.** LibreTranslate is server software (pip and Docker) and claims no desktop platforms; Cake Wallet publishes no macOS build and Proton VPN has no downloadable Linux installer, so neither claims those platforms. Where a project ships no binary at all for Linux (VLC, GIMP, Krita, HandBrake, Inkscape, Element), the download button offers the project's official Flatpak build on Flathub instead of pretending a tarball exists.
- **A hard, allowlisted text-fetch command.** The desktop app reads vendor manifests through a new Rust command that speaks https only, talks to exactly the allowlisted project hosts, and never pulls more than 2 MB, so a manifest fetch can never become a proxy or a memory hazard.

### Fixed
- **Linux users were handed source code.** HandBrake publishes no Linux binary in its GitHub releases, and the resolver's only candidate was the source tarball; a `-src-`/`-source-` name is now excluded everywhere as a matter of rule.
- **The Tor Android manifest was keyed by the wrong name** (`arm64` where the host reports `aarch64`), so the per-ABI lookup missed; Android devices get their exact APK now.
- **The Syncthing Android entry still pointed at the retired official app.** The Syncthing team retired their Android app in December 2024; Android now resolves to the maintained Syncthing-Fork they recommend, on GitHub and on F-Droid.
- **Cake Wallet's Windows row** resolved from a stale old release and its Linux tarball carried a weak-guess flag; both are pinned to their real naming now, and the catalog no longer claims a macOS build that was never published.
- **The batch-download skip toast** reads like help instead of a dead end: the few apps without a device file say so plainly and open their official page with the right pick one tap away.
- **Vendor lookups survive hiccups.** Manifest reads retry once on transient failures, and GitLab's occasional HTML challenge pages no longer turn into a failed download.



## 1.0.1-beta (2026-09-25): the download queue and the rate-limit truce

The first release on top of 1.0.0: a second, independent download-component audit was reconciled with the 1.0.0 work, keeping the best of both. The download manager now queues instead of stampeding, the resolver remembers what it already found so GitHub's rate limit stops biting, and the UI says honestly when a lookup failed because of the network instead of implying the app has no download.

### Added
- **The download queue.** A batch of thirty apps used to start thirty parallel transfers that fought each other for bandwidth. Three downloads run at a time now and the rest wait in a visible FIFO queue with their own cancel buttons, draining automatically as slots free up. The queue logic is a separate, unit-tested module.
- **Resolved downloads persist across sessions.** GitHub's unauthenticated API quota is 60 requests per hour per IP, which a batch download spends in minutes and every app launch used to re-spend. Results are now cached in local storage for six hours (failures for five minutes), partitioned by platform, host architecture and release-stream filter so a stale hit can never serve the wrong file.
- **The download panel survives an app restart.** Finished, failed and cancelled entries used to vanish when the window closed while their files (and resumable .part files) sat on disk; a download interrupted by a reboot now comes back as exactly what it is, resumable with one click.
- **Rate limits are said out loud.** When an automatic lookup fails because GitHub rate-limited the network, the detail modal says exactly that instead of implying the app has no downloadable build; and while the primary pick is only a weak guess, the "All releases" alternative stays visible instead of being hidden.

### Fixed
- **A server-supplied filename can no longer be a Windows device name.** `CON`, `NUL`, `COM1`... are reserved on Windows up to the first dot (`NUL.tar.gz` too), and a hostile Content-Disposition could make the final rename fail on a clean folder. Reserved names collapse to a safe default; compile-checked against 14 cases including multi-extension and unicode names.
- **Ten Android apps resolved to weak, unmarked picks.** Obsidian, KeePassDX, Organic Maps, Tuta, Proton Mail, Aegis, the three Fossify apps, Mastodon and Mullvad publish universal APKs whose names carry no architecture marker; each entry now pins its real APK naming, turning a flagged guess into a confident pick. The wrong-ABI protections are untouched: an unknown device still gets nothing rather than an unmarked APK.
- **Jellyfin** pointed at the server repository, whose releases carry no installers; the desktop app now resolves from `jellyfin/jellyfin-media-player`.
- **LibreWolf** pointed at a deleted GitHub repository, so every lookup ended in a 404; the entry now links to the project's real home, `librewolf-community/browser/bsys6` on GitLab.
- The "Added <date>" line in the detail modal is localized now (it was hardcoded English).


## 1.0.0-beta (2026-09-24): the first real release

This is the real v1.0.0 of Fress. Every older test build (the whole alpha line and the first beta run) has been deleted from the Releases page, and the version number starts over at 1.0.0. If you still run one of those builds, install this one by hand once: the updater compares version numbers and never offers a lower one, so it will not suggest this release on its own. Android installs coming from the last test builds use the same signing key and can install straight over the old app; export a backup from the old build first if you want to be safe. Everyone else: welcome, this is the beginning.

### Downloads, the whole point of the app
- The catalog resolves the right installer for your device from each project's own release feed. Architecture aware everywhere: x64 and ARM64 on Windows (the app asks the machine for its real architecture, not the emulated one), Apple Silicon and Intel on macOS, per-ABI APKs on Android, and Linux builds that actually run on your CPU.
- Multi-product repos are pinned to the right release stream, so the Ente Photos button downloads Ente Photos and not another Ente app, and Tuta's desktop, Android and calendar builds never cross over.
- Linux tarballs in every common format resolve now (.tar.gz, .tar.zst, .tar.xz and friends), so Ollama, 7-Zip and Calibre download directly again.
- Archive-only distributions are supported (Syncthing, Whisper Desktop, LosslessCut ship zip or 7z files instead of installers), and builds kept around for old Windows ("Legacy") can no longer outrank the current installer.
- Bitwarden resolves from its clients repository plus a stable official download link; DevToys resolves even though its repo flags every release as a prerelease.
- Android apps that also live on F-Droid prefer the F-Droid build when the GitHub release carries no architecture marker, so updates keep installing cleanly.
- When an app genuinely has no direct file (VLC, Tor Browser, GIMP and friends publish on their own sites only), the batch toast says so and opens the official pages in one click. No fake fallbacks.

### Fixed
- A wrong product could be offered: repos that publish several apps from one repo (Ente, Tuta, Obsidian, Bitwarden) are filtered by release stream before any file is picked.
- A wrong operating system could be offered: archive files whose names name another OS (a macos zip on Windows, a linux zip on macOS) are refused outright.
- A wrong architecture can never be offered: the compatibility gate runs on every pick, catalog overrides included, and an Android device whose ABI cannot be read gets the universal APK only.
- Downloads verify every byte: the received size is checked against what the server promised, resumes validate the server's answer strictly, and a resume without a validator restarts cleanly instead of risking corruption.
- Windows on ARM gets native ARM builds of Fress and of catalog apps; hyphenated names like x86-64 and arm-64 are classified correctly, and a -CLI companion can never impersonate the app.

### The app
- Batch downloads with a download manager: progress, speed, pause and resume, retries, all locally.
- The Replace tab: pick what you use today in 28 categories and get vetted private alternatives, graded and sorted.
- Update channels (alpha, beta, stable) with checksum-verified self-updates.
- Fully translated into Persian, Spanish, French and German.
- 75 curated apps, each with its official icon shipped inside the app.
- 138 regression tests behind all of the above.
