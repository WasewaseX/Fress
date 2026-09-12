#!/usr/bin/env python3
"""Check that every t('...') key used in src/ exists in all 5 locales of i18n.tsx."""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / 'src'

used = set()
for p in SRC.rglob('*.ts*'):
    text = p.read_text(encoding='utf-8', errors='replace')
    for m in re.finditer(r"\bt\(\s*['\"]([^'\"]+)['\"]", text):
        used.add(m.group(1))
    for m in re.finditer(r"\btI18n\(\s*['\"]([^'\"]+)['\"]", text):
        used.add(m.group(1))
    # tRef.current('key') — toasts fired from the downloads provider
    for m in re.finditer(r"\btRef\.current\(\s*['\"]([^'\"]+)['\"]", text):
        used.add(m.group(1))
    # translate('key') — toasts fired from non-component modules
    for m in re.finditer(r"\btranslate\(\s*['\"]([^'\"]+)['\"]", text):
        used.add(m.group(1))

i18n = (SRC / 'lib' / 'i18n.tsx').read_text(encoding='utf-8')
# find dictionary blocks: en: {...}, fa: {...}, es, fr, de
blocks = {}
for lang in ['en', 'fa', 'es', 'fr', 'de']:
    m = re.search(rf"const {lang}\s*:\s*Dict\s*=\s*\{{(.*?)\n\}};", i18n, re.S)
    if not m:
        print(f"!! could not locate block for {lang}")
        continue
    body = m.group(1)
    keys = set(re.findall(r"'([a-zA-Z0-9_.]+)'\s*:", body))
    blocks[lang] = keys

en = blocks.get('en', set())
missing_in_en = sorted(used - en)
print(f"Used keys: {len(used)}; en dict keys: {len(en)}")
if missing_in_en:
    print("MISSING in en:", missing_in_en)
for lang, keys in blocks.items():
    miss = sorted(k for k in en - keys if k in used)
    if miss:
        print(f"MISSING in {lang} (used in app):", miss)
extra = sorted(en - used)
print(f"Defined-but-unused in en: {len(extra)}")
if extra:
    print(extra)
