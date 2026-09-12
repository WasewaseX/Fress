#!/usr/bin/env python3
"""Regenerates public/llms.txt from the actual catalog data so it can never
drift again. Run from the repo root: python3 scripts/gen_llms.py"""
import re, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
src = ""
for f in ["src/data/appsData.ts", "src/data/appsDataExtra.ts"]:
    src += (ROOT / f).read_text(encoding="utf-8")

CAT_ORDER = [
    "Productivity & Office", "Utilities & System", "Privacy & Security",
    "Design & Creative", "Developer & Code", "Media, Audio & Video",
    "AI & Knowledge",
]
PLATFORM_LABELS = {"windows": "Windows", "mac": "macOS", "linux": "Linux",
                   "android": "Android", "ios": "iOS", "web": "Web"}

apps = []
# Split per top-level entry: each begins with "id: '...'"
positions = [m.start() for m in re.finditer(r"\n  \{\n    id: '", src)]
positions.append(len(src))
for i in range(len(positions) - 1):
    block = src[positions[i]:positions[i + 1]]

    def field(name):
        m = re.search(rf"{name}:\s*'((?:[^'\\]|\\.)*)'", block)
        return m.group(1).replace("\\'", "'") if m else ""

    plats = re.search(r"platforms:\s*\[([^\]]*)\]", block)
    platforms = re.findall(r"'([a-z]+)'", plats.group(1)) if plats else []

    apps.append({
        "id": field("id"),
        "name": field("name"),
        "tagline": field("tagline"),
        "category": field("category"),
        "license": field("license"),
        "platforms": platforms,
        "pick": "isOwnerPick: true" in block,
    })

lines = [
    "# Fress — Free & Open-Source Software Directory",
    "",
    "> Fress is a local-first, zero-telemetry desktop app that curates free and",
    "> open-source software and downloads the latest stable installer straight",
    "> from official release sources (GitHub Releases, F-Droid, vendor pages).",
    "> This file lists the actual catalog; the app is the source of truth.",
    "",
]
for cat in CAT_ORDER:
    cat_apps = [a for a in apps if a["category"] == cat]
    if not cat_apps:
        continue
    lines.append(f"## {cat}")
    lines.append("")
    for a in sorted(cat_apps, key=lambda x: x["name"].lower()):
        plat = ", ".join(PLATFORM_LABELS.get(p, p) for p in a["platforms"])
        pick = " (the single Owner Pick)" if a["pick"] else ""
        lines.append(f"- **{a['name']}**{pick}: {a['tagline']}. License: {a['license']}. Platforms: {plat}.")
    lines.append("")

out = ROOT / "public" / "llms.txt"
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"regenerated {out}: {len(apps)} apps")
