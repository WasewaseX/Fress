// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT

//! The open/reveal boundary for downloaded artifacts.
//!
//! The opener plugin's JS `openPath` / `revealItemInDir` bindings are
//! unrestricted by capability: a compromised frontend could open or execute
//! ANY file on the machine with the system default handler. This module
//! replaces that blanket grant with a validated native boundary: a path may
//! only be opened or revealed when it lives inside a directory the download
//! engine itself uses - the platform's default download folder plus the few
//! folders a download actually ran in (or that the user explicitly picked),
//! remembered in a small app-owned ledger that survives restarts, because
//! the download panel restores completed entries across sessions and their
//! "Open" / "Show in folder" buttons must keep working.
//!
//! Threat model, stated honestly: a frontend that can start downloads can
//! already make the engine create files in a directory of its choosing (the
//! URL policy constrains WHERE FROM, not WHERE TO). What this boundary adds
//! is that PRE-EXISTING local files - things that did not arrive through
//! Fress's own policy-gated engine - can no longer be opened or revealed
//! from the webview at all. The blast radius of a frontend compromise
//! shrinks from "the whole disk" to "the download folders".

use std::path::{Path, PathBuf};

/// Ledger cap: the newest N download directories are remembered. A folder
/// enters the ledger only when a download actually targets it or the user
/// picks it in the native dialog, so growth is slow; 32 entries cover years
/// of folder churn and the refresh is LRU (re-used folders move to the end).
const LEDGER_MAX: usize = 32;

const LEDGER_FILE: &str = "admitted-dirs.json";

/// The admission set: canonical directories a downloaded path may be opened
/// or revealed from. Built from the platform's default download folder and
/// the persisted ledger; entries that no longer exist are skipped silently
/// (a deleted folder cannot admit anything).
pub(crate) struct OpenAdmission {
    dirs: Vec<PathBuf>,
}

impl OpenAdmission {
    /// `default_dir` and every ledger entry are canonicalized; failures
    /// drop the entry rather than failing the whole boundary (the default
    /// folder is re-created by the engine on the next download anyway).
    pub(crate) fn build(default_dir: Option<&Path>, ledger: &[PathBuf]) -> Self {
        let mut dirs = Vec::new();
        if let Some(d) = default_dir {
            if let Ok(canon) = d.canonicalize() {
                dirs.push(canon);
            }
        }
        for entry in ledger {
            if let Ok(canon) = entry.canonicalize() {
                if !dirs.contains(&canon) {
                    dirs.push(canon);
                }
            }
        }
        Self { dirs }
    }

    /// Admit `path` only when it exists AND is either itself an admitted
    /// directory (the "open download folder" case) or a file whose parent
    /// directory is admitted (the "open/reveal a completed download" case).
    /// Everything else - arbitrary paths, dangling paths, files outside the
    /// download folders - is refused.
    pub(crate) fn admit(&self, path: &Path) -> Result<(), String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("File not available: {e}"))?;
        let canon = path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path: {e}"))?;
        if self.dirs.iter().any(|d| d == &canon) {
            return Ok(());
        }
        if meta.is_file() {
            if let Some(parent) = canon.parent() {
                if self.dirs.iter().any(|d| d == parent) {
                    return Ok(());
                }
            }
        }
        Err("Path is not a download delivered by Fress".into())
    }
}

/// Read the persisted ledger. Best-effort: a missing or corrupt file reads
/// as an empty ledger; the next `record_dir` rewrites it clean.
pub(crate) fn read_ledger(base: &Path) -> Vec<PathBuf> {
    let raw = match std::fs::read_to_string(base.join(LEDGER_FILE)) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str::<Vec<String>>(&raw) {
        Ok(list) => list.into_iter().map(PathBuf::from).collect(),
        Err(_) => Vec::new(),
    }
}

/// Record `dir` as a download directory (most-recently-used last), skipping
/// the platform default (always admitted anyway, keeps the ledger small)
/// and capping the list at [`LEDGER_MAX`]. Best-effort: any failure to
/// persist is swallowed - admission then just does not survive a restart
/// for that folder, which the next successful download repairs.
pub(crate) fn record_dir(base: &Path, dir: &Path, default_dir: &Path) {
    let Ok(canon) = dir.canonicalize() else {
        return;
    };
    if let Ok(default_canon) = default_dir.canonicalize() {
        if canon == default_canon {
            return;
        }
    }
    let mut ledger = read_ledger(base);
    ledger.retain(|d| d != &canon);
    ledger.push(canon);
    let start = ledger.len().saturating_sub(LEDGER_MAX);
    ledger.drain(..start);
    let payload = match serde_json::to_string(
        &ledger
            .iter()
            .map(|d| d.to_string_lossy().to_string())
            .collect::<Vec<_>>(),
    ) {
        Ok(p) => p,
        Err(_) => return,
    };
    // Atomic write (temp + rename) so a crash mid-write can never leave a
    // corrupt ledger - the same discipline the download engine applies to
    // its validator sidecars.
    let tmp = base.join(format!("{LEDGER_FILE}.tmp"));
    let final_path = base.join(LEDGER_FILE);
    if std::fs::write(&tmp, payload).is_ok() {
        let _ = std::fs::rename(&tmp, &final_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "fress-open-boundary-{}-{}-{}",
                tag,
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, b"x").expect("write file");
        p
    }

    #[test]
    fn a_file_inside_the_default_dir_is_admitted() {
        let tmp = TempDir::new("default-file");
        let file = touch(tmp.path(), "app.apk");
        let admission = OpenAdmission::build(Some(tmp.path()), &[]);
        assert!(admission.admit(&file).is_ok());
    }

    #[test]
    fn a_file_inside_a_ledger_dir_is_admitted() {
        let tmp = TempDir::new("ledger-file");
        let custom = tmp.path().join("custom");
        std::fs::create_dir_all(&custom).expect("mkdir");
        let file = touch(&custom, "app.exe");
        let admission =
            OpenAdmission::build(Some(tmp.path().join("default")).as_deref(), &[custom]);
        assert!(admission.admit(&file).is_ok());
    }

    #[test]
    fn the_download_folder_itself_is_admitted_as_a_directory_target() {
        let tmp = TempDir::new("open-folder");
        let admission =
            OpenAdmission::build(Some(tmp.path()).map(|p| p as &Path), &[]).admit(tmp.path());
        assert!(admission.is_ok());
    }

    #[test]
    fn arbitrary_local_files_are_refused() {
        let tmp = TempDir::new("refuse-outside");
        let admission = OpenAdmission::build(Some(tmp.path().join("default")).as_deref(), &[]);
        // Outside every admitted dir.
        assert!(admission.admit(&tmp.path().join("secret.txt")).is_err());
        // A parent dir that merely LOOKS close (prefix string) is not enough.
        let sibling = tmp.path().join("default-evil");
        std::fs::create_dir_all(&sibling).expect("mkdir");
        let file = touch(&sibling, "evil.exe");
        assert!(admission.admit(&file).is_err());
        // The download dir itself does not admit anything when the default
        // dir was never created (canonicalize fails -> skipped).
        assert!(admission.admit(&tmp.path().join("default")).is_err());
    }

    #[test]
    fn dangling_and_nonexistent_paths_are_refused() {
        let tmp = TempDir::new("dangling");
        let admission = OpenAdmission::build(Some(tmp.path()), &[]);
        assert!(admission
            .admit(&tmp.path().join("never-downloaded.bin"))
            .is_err());
    }

    #[test]
    fn symlinks_resolve_to_the_admitted_canonical_dir() {
        let tmp = TempDir::new("symlink");
        let real = tmp.path().join("real");
        std::fs::create_dir_all(&real).expect("mkdir");
        let file = touch(&real, "app.bin");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, tmp.path().join("link")).expect("symlink");
            let through_link = tmp.path().join("link").join("app.bin");
            let admission = OpenAdmission::build(Some(&real), &[]);
            // The canonical path of the file resolves to `real/app.bin`,
            // whose parent is the admitted dir.
            assert!(admission.admit(&through_link).is_ok());
            assert_eq!(file.metadata().unwrap().len(), 1);
        }
        #[cfg(not(unix))]
        {
            let _ = file;
        }
    }

    #[test]
    fn the_ledger_round_trips_and_caps_at_the_lru_limit() {
        let tmp = TempDir::new("ledger");
        assert!(read_ledger(tmp.path()).is_empty());

        let default_dir = tmp.path().join("default");
        std::fs::create_dir_all(&default_dir).expect("mkdir default");
        // Record LEDGER_MAX + 5 distinct folders; the default is skipped.
        for i in 0..(LEDGER_MAX + 5) {
            let dir = tmp.path().join(format!("d{i}"));
            std::fs::create_dir_all(&dir).expect("mkdir");
            record_dir(tmp.path(), &dir, &default_dir);
        }
        let ledger = read_ledger(tmp.path());
        assert_eq!(ledger.len(), LEDGER_MAX, "ledger is capped");
        // The oldest entries fell off; the newest survive.
        assert!(!ledger.iter().any(|d| d.ends_with("d0")));
        assert!(ledger
            .iter()
            .any(|d| d.ends_with(format!("d{}", LEDGER_MAX + 4))));

        // Re-recording an existing folder refreshes it (moves to the end)
        // instead of duplicating it.
        let refresh = ledger[0].clone();
        record_dir(tmp.path(), &refresh, &default_dir);
        let ledger = read_ledger(tmp.path());
        assert_eq!(ledger.iter().filter(|d| **d == refresh).count(), 1);
        assert_eq!(ledger.last(), Some(&refresh));
    }

    #[test]
    fn a_corrupt_ledger_reads_as_empty_and_is_repaired_by_the_next_record() {
        let tmp = TempDir::new("corrupt");
        std::fs::write(tmp.path().join(LEDGER_FILE), "not json at all {{{").expect("write");
        assert!(read_ledger(tmp.path()).is_empty());
        let dir = tmp.path().join("d");
        std::fs::create_dir_all(&dir).expect("mkdir");
        record_dir(tmp.path(), &dir, &tmp.path().join("default"));
        let ledger = read_ledger(tmp.path());
        assert_eq!(ledger, vec![dir.canonicalize().expect("canon")]);
    }

    #[test]
    fn the_platform_default_dir_never_enters_the_ledger() {
        let tmp = TempDir::new("default-skip");
        let default_dir = tmp.path().join("default");
        std::fs::create_dir_all(&default_dir).expect("mkdir");
        record_dir(tmp.path(), &default_dir, &default_dir);
        assert!(read_ledger(tmp.path()).is_empty());
    }
}
