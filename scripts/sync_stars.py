#!/usr/bin/env python3
# Fress - a catalog of free and open-source software.
# Copyright (c) 2026 WasewaseX and Fress contributors
# SPDX-License-Identifier: MIT
#
"""Apply the live-audited star counts (scripts/real_stars.json) to the catalog,
plus the hand-audited repo fixes:

  thunderbird : no repo at all, stars 0        -> official thunderbird/thunderbird-desktop
  libreoffice : git.libreoffice.org (gerrit,   -> official LibreOffice/core mirror
                no star counts), fake 5000

Every other app keeps its (already accurate) repo URL and only gets the
current number written in.
"""
import json
import re

AUDIT = 'scripts/real_stars.json'
FILES = ['src/data/appsData.ts', 'src/data/appsDataExtra.ts']

SPECIAL = {
    'thunderbird': {'stars': 142, 'githubUrl': 'https://github.com/thunderbird/thunderbird-desktop'},
    'libreoffice': {'stars': 4350, 'githubUrl': 'https://github.com/LibreOffice/core'},
}

audit = json.load(open(AUDIT, encoding='utf-8'))

changed = []
for path in FILES:
    src = open(path, encoding='utf-8').read()

    # Split into per-app blocks: each starts with "    id: 'xxx',"
    parts = re.split(r"(?=(^    id: '))", src, flags=re.M)
    out = [parts[0]]
    for block in parts[1:]:
        m = re.match(r"    id: '([a-z0-9-]+)'", block)
        if not m:
            out.append(block)
            continue
        app_id = m.group(1)
        new_block = block
        entry = audit.get(app_id, {})
        real = entry.get('real')

        if app_id in SPECIAL:
            for field, value in SPECIAL[app_id].items():
                if isinstance(value, str):
                    new_block, n = re.subn(
                        rf"({field}: ')[^']*(',)", rf"\g<1>{value}\g<2>", new_block, count=1)
                    if n:
                        changed.append(f"{app_id}.{field} -> {value}")
                else:
                    new_block, n = re.subn(
                        rf"({field}: )\d+(,)", rf"\g<1>{value}\g<2>", new_block, count=1)
                    if n:
                        changed.append(f"{app_id}.{field} -> {value}")
        elif isinstance(real, int) and real > 0:
            old = entry.get('old')
            new_block, n = re.subn(
                r"(stars: )\d+(,)", rf"\g<1>{real}\g<2>", new_block, count=1)
            if n and old != real:
                changed.append(f"{app_id}.stars {old} -> {real}")
        out.append(new_block)

    open(path, 'w', encoding='utf-8').write(''.join(out))

print(f"{len(changed)} updates applied:")
for c in changed:
    print(' ', c)
