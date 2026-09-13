#!/usr/bin/env python3
"""Apply the audited real star counts from scripts/real_stars.json to the data files."""
import json
import re

res = json.load(open('scripts/real_stars.json'))
DATA_FILES = ['src/data/appsData.ts', 'src/data/appsDataExtra.ts']


def find_object_span(src, app_id):
    m = re.search(r"\{\s*\n\s*id:\s*'" + re.escape(app_id) + r"'", src)
    if not m:
        return None
    start = m.start()
    depth = 0
    i = start
    while i < len(src):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return start, i
        i += 1
    return None


changed = 0
for path in DATA_FILES:
    src = open(path, encoding='utf-8').read()
    for app_id, info in res.items():
        if info['real'] is None or info['real'] == info['old']:
            continue
        span = find_object_span(src, app_id)
        if not span:
            continue
        s, e = span
        block = src[s:e]
        new_block, n = re.subn(r"\bstars:\s*\d+", f"stars: {info['real']}", block, count=1)
        if n:
            src = src[:s] + new_block + src[e:]
            changed += 1
    open(path, 'w', encoding='utf-8').write(src)

print(f'{changed} star values updated')
# verify
import subprocess
for path in DATA_FILES:
    src = open(path, encoding='utf-8').read()
    ids = re.findall(r"id:\s*'([^']+)'", src)
    for aid in ('7zip', 'vlc', 'immich', 'rustdesk', 'ollama'):
        if aid in ids:
            span = find_object_span(src, aid)
            st = re.search(r"\bstars:\s*(\d+)", src[span[0]:span[1]])
            print(f'  {aid}: {st.group(1)}')
