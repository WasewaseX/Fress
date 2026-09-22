#!/usr/bin/env python3
# Fress - a catalog of free and open-source software.
# Copyright (c) 2026 WasewaseX and Fress contributors
# SPDX-License-Identifier: MIT
#
"""Fetch REAL current star counts for every app in the Fress catalog.

GitHub-hosted repos  -> api.github.com/repos/{owner}/{repo}        (stargazers_count)
GitLab-hosted repos  -> {origin}/api/v4/projects/{ns}%2F{proj}     (star_count)
   covers gitlab.com, gitlab.gnome.org, gitlab.torproject.org, code.videolan.org

Output: scripts/real_stars.json  {app_id: {old, real, repo, source}}
"""
import json
import os
import re
import time
import urllib.request
import urllib.parse
import urllib.error

DATA_FILES = ['src/data/appsData.ts', 'src/data/appsDataExtra.ts']
OUT = 'scripts/real_stars.json'
UA = {'User-Agent': 'fress-catalog-audit/1.0'}
# Optional GitHub token (5000/h instead of 60/h anonymous) passed via GH_TOKEN env.
TOKEN = os.environ.get('GH_TOKEN', '').strip()
if TOKEN:
    UA['Authorization'] = f'Bearer {TOKEN}'


def extract_apps(path):
    src = open(path, encoding='utf-8').read()
    apps = {}
    # Each app object starts with  { \n    id: 'xxx'
    for m in re.finditer(r"\{\s*\n\s*id:\s*'([^']+)'", src):
        start = m.start()
        # object ends at the matching closing brace of this object: scan braces
        depth = 0
        i = start
        end = None
        while i < len(src):
            if src[i] == '{':
                depth += 1
            elif src[i] == '}':
                depth -= 1
                if depth == 0:
                    end = i
                    break
            i += 1
        block = src[start:end]
        gh = re.search(r"githubUrl:\s*'([^']*)'", block)
        st = re.search(r"\bstars:\s*(\d+)", block)
        if gh and st:
            apps[m.group(1)] = {'githubUrl': gh.group(1), 'old': int(st.group(1))}
    return apps


def get_json(url):
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {'__error__': e.code}
    except Exception as e:
        return {'__error__': str(e)}


def github_stars(url):
    m = re.match(r'^https?://(?:www\.)?github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$', url)
    if not m:
        return None, None
    repo = f'{m.group(1)}/{m.group(2)}'
    j = get_json(f'https://api.github.com/repos/{repo}')
    if '__error__' in j:
        return repo, None
    return repo, j.get('stargazers_count')


def gitlab_stars(url):
    m = re.match(r'^(https?://[^/]+)/(.+?)/?$', url)
    if not m:
        return None, None
    origin, path = m.group(1), m.group(2)
    enc = urllib.parse.quote(path, safe='')
    j = get_json(f'{origin}/api/v4/projects/{enc}')
    if '__error__' in j:
        return f'{origin}/{path}', None
    return f'{origin}/{path}', j.get('star_count')


def main():
    apps = {}
    for f in DATA_FILES:
        apps.update(extract_apps(f))

    result = {}
    gh_count = 0
    for app_id, info in sorted(apps.items()):
        url = info['githubUrl']
        if not url:
            result[app_id] = {'old': info['old'], 'real': None, 'repo': '(no repo url)', 'source': 'none'}
            continue
        if 'github.com/' in url:
            repo, stars = github_stars(url)
            src = 'github'
            gh_count += 1
            time.sleep(0.4)  # stay well inside the 60/h unauth budget
        elif any(h in url for h in ('gitlab.com', 'gitlab.', 'code.videolan.org')) and 'git.libreoffice.org' not in url:
            repo, stars = gitlab_stars(url)
            src = 'gitlab'
            time.sleep(0.2)
        else:
            result[app_id] = {'old': info['old'], 'real': None, 'repo': url, 'source': 'unsupported'}
            continue
        result[app_id] = {'old': info['old'], 'real': stars, 'repo': repo, 'source': src}
        flag = 'SAME ' if stars == info['old'] else 'DIFF '
        print(f'{flag} {app_id:24s} {info["old"]:>7d} -> {str(stars):>7s}  ({repo})')

    json.dump(result, open(OUT, 'w'), indent=1)
    print(f'\n{gh_count} github calls made -> {OUT}')


if __name__ == '__main__':
    main()
