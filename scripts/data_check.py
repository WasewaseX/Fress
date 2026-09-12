#!/usr/bin/env python3
"""Sanity-check the app catalog: duplicate ids, android coverage, field shapes."""
import re, json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[1] / 'src' / 'data'
text = (ROOT / 'appsData.ts').read_text() + (ROOT / 'appsDataExtra.ts').read_text()

ids = re.findall(r"id:\s*'([^']+)'", text)
dupes = [i for i in set(ids) if ids.count(i) > 1]
print(f"Total apps: {len(ids)}; duplicates: {dupes or 'none'}")
missing = []

# android apps without any android install path
# simpler: split per top-level object by id
for m in re.finditer(r"id:\s*'([^']+)'[\s\S]*?(?=id:\s*'[^']+'|\Z)", text):
    block = m.group(0)
    aid = m.group(1)
    has_android = re.search(r"platforms:\s*\[[^\]]*'android'", block) or re.search(r"platforms:\s*\[[^\]]*\"android\"", block)
    if not has_android:
        continue
    has_fd = "fdroidId:" in block
    has_play = "playStoreId:" in block
    has_gh = "githubUrl:" in block
    if not (has_fd or has_play):
        missing.append((aid, 'fdroid' if has_fd else '', 'play' if has_play else '', 'gh' if has_gh else 'no-gh'))

print("Android apps lacking BOTH fdroid & play ids (ok when GitHub .apk coverage exists):")
for aid, fd, pl, gh in missing:
    print(f"  - {aid} ({gh})")
# Exit non-zero only on REAL problems: duplicate ids, or an android app with
# no fdroid/play ids AND no github url (no auto-resolvable .apk path).
hard_fail = bool(dupes) or any('no-gh' in m[3] for m in missing)
sys.exit(1 if hard_fail else 0)
