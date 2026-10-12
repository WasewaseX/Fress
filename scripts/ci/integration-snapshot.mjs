#!/usr/bin/env node
// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// integration-snapshot.mjs — the public integration-state audit command.
//
// Purpose: publish a CURRENT snapshot of the repository's integration
// state (tested SHA, source version, newest release and its provenance,
// open PR inventory, CI results on the tested SHA, artifact-integrity and
// version-coherence verdicts) as a workflow step summary plus a
// machine-readable JSON artifact — so no static Markdown file can quietly
// imply that an old SHA, an old release or an old PR list are current
// facts.
//
// Read-only by construction: the script only READS git metadata, the
// package manifest and the GitHub REST API. It never commits, never
// pushes, never mutates a release. The token it needs is the workflow's
// own GITHUB_TOKEN with `contents: read, pull-requests: read, actions:
// read` — the least permissions these observations require.
//
// Honesty rules baked in:
//   - A failed API call is reported as "unavailable: <reason>" and makes
//     the run NON-success. An empty open-PR list is never displayed when
//     the list could not be fetched (count: null, not 0).
//   - Branch-protection enforcement is a maintainer Settings fact that a
//     repository-scoped read token cannot observe; it is reported as a
//     KNOWN unavailable observation, never as "not enforced".
//   - Gate verdicts (version coherence, artifact integrity) are inputs
//     measured by the authoritative commands in earlier workflow steps or
//     jobs — this script never re-implements their rules.
//   - The snapshot clearly separates the TESTED SHA (what was observed)
//     from the default-branch head (what is current) and states whether
//     they are the same commit.
//
// Usage (workflow):
//   node scripts/ci/integration-snapshot.mjs --out integration-snapshot.json \
//        [--version-coherence pass|fail] [--version-coherence-rc N] \
//        [--artifact-audit '<json from the artifact-audit job>']
// Environment: GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_SHA,
//   GITHUB_STEP_SUMMARY, and a read token (GH_TOKEN | GITHUB_TOKEN |
//   FRESS_GH_TOKEN). Works locally without Actions env (uses git + argv).
//
// Exit codes: 0 complete snapshot, every required observation available,
//   no gate failing. 3 one or more REQUIRED observations unavailable.
//   4 a reported gate FAILED (version coherence or artifact integrity).
//   2 usage error.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// argv / environment
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const OUT = argValue('--out') || 'integration-snapshot.json';
const COHERENCE = argValue('--version-coherence') || null; // pass | fail | (absent -> unavailable)
const COHERENCE_RC = argValue('--version-coherence-rc') || null;
const ARTIFACT_AUDIT_RAW = argValue('--artifact-audit') || '';

const REPO = process.env.GITHUB_REPOSITORY || git(['config', '--get', 'remote.origin.url']).replace(/.*github\.com[:/]/, '').replace(/\.git$/, '');
const TESTED_SHA = process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']);
const REF_NAME = process.env.GITHUB_REF_NAME || git(['branch', '--show-current']) || '(detached HEAD)';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.FRESS_GH_TOKEN || '';
const SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY || null;

function git(gitArgs) {
  try {
    return execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 16 << 20 }).trim();
  } catch (err) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// GitHub REST (read-only). One honest retry for transient transport/5xx
// failures; never a retry that could turn a 4xx judgment into success.
const unavailable = []; // {field, reason}
const knownLimitations = [];

async function api(path) {
  if (!TOKEN) {
    throw Object.assign(new Error('no read token available (set GH_TOKEN)'), { status: 0 });
  }
  const url = `https://api.github.com${path}`;
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'fress-integration-snapshot',
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) });
      if (res.status >= 200 && res.status < 300) return await res.json();
      const err = new Error(`HTTP ${res.status} for ${path}`);
      err.status = res.status;
      if (res.status >= 500 && attempt === 1) { lastErr = err; await sleep(3000); continue; }
      throw err;
    } catch (err) {
      lastErr = err;
      const transient = !err.status || err.status >= 500; // network / timeout / 5xx
      if (transient && attempt === 1) { await sleep(3000); continue; }
      throw err;
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function observed(field, fn, { required = true } = {}) {
  try {
    return { value: await fn(), unavailable: null };
  } catch (err) {
    const reason = err && err.status ? `GitHub API ${err.status} on ${err.message.split(' for ')[0]}` : `network/transport failure: ${err.message}`;
    if (required) unavailable.push({ field, reason });
    return { value: null, unavailable: reason };
  }
}

// ---------------------------------------------------------------------------
// Observations
const sourceVersion = (() => {
  try {
    return JSON.parse(readFileSync('package.json', 'utf8')).version; // the authoritative manifest
  } catch {
    return null;
  }
})();
if (sourceVersion === null) unavailable.push({ field: 'source_version', reason: 'package.json (the authoritative manifest) could not be read from the checkout' });

const repoMeta = await observed('repository_metadata', () => api(`/repos/${REPO}`));
const DEFAULT_BRANCH = repoMeta.value ? repoMeta.value.default_branch : 'main';

const mainHead = await observed('default_branch_head', () => api(`/repos/${REPO}/commits/${encodeURIComponent(DEFAULT_BRANCH)}`));

const latestRelease = await observed('latest_published_release', async () => {
  // /releases/latest excludes prereleases (every Fress release is one),
  // so the inventory comes from the releases list instead — the same
  // ordering the releases page shows (newest created first).
  const list = await api(`/repos/${REPO}/releases?per_page=5`);
  if (!Array.isArray(list) || list.length === 0) throw Object.assign(new Error('no releases at all'), { status: 404 });
  const rel = list[0];
  // Resolve the tag to a commit SHA (annotated tags point at a tag object).
  const ref = await api(`/repos/${REPO}/git/ref/tags/${encodeURIComponent(rel.tag_name)}`);
  let tagSha = ref.object.sha;
  if (ref.object.type === 'tag') {
    const tagObj = await api(`/repos/${REPO}/git/tags/${tagSha}`);
    tagSha = tagObj.object.sha;
  }
  return {
    tag: rel.tag_name,
    html_url: rel.html_url,
    published_at: rel.published_at,
    created_at: rel.created_at,
    prerelease: rel.prerelease,
    draft: rel.draft,
    commit_sha: tagSha,
  };
});

// Provenance: is the newest release an ancestor of the tested SHA, and how
// far has the tested ref moved since it? (Local git over the full checkout;
// requires fetch-depth: 0 in the workflow.)
let ancestry = { ancestor: null, tested_ahead_of_release: null, release_ahead_of_tested: null, note: '' };
if (latestRelease.value && latestRelease.value.commit_sha) {
  const sha = latestRelease.value.commit_sha;
  // Quiet rev-parse: empty output == commit not in this checkout.
  const haveCommit = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) !== '';
  if (!haveCommit) {
    ancestry.note = 'release commit not present in this checkout (shallow clone) — run with fetch-depth: 0 to prove provenance';
  } else {
    const mergeBase = git(['merge-base', '--is-ancestor', sha, 'HEAD']);
    ancestry.ancestor = mergeBase === '';
    ancestry.tested_ahead_of_release = Number(git(['rev-list', '--count', `${sha}..HEAD`])) || 0;
    ancestry.release_ahead_of_tested = Number(git(['rev-list', '--count', `HEAD..${sha}`])) || 0;
  }
}

const openPrs = await observed('open_pull_requests', async () => {
  const prs = await api(`/repos/${REPO}/pulls?state=open&per_page=100`);
  return {
    count: prs.length,
    possibly_truncated: prs.length === 100,
    items: prs.map((p) => ({ number: p.number, title: p.title, html_url: p.html_url, head_ref: p.head.ref, head_sha: p.head.sha, draft: p.draft, created_at: p.created_at })),
  };
});

const ciRuns = await observed('ci_on_tested_sha', async () => {
  const data = await api(`/repos/${REPO}/actions/runs?head_sha=${TESTED_SHA}&per_page=100`);
  const latest = new Map();
  for (const run of data.workflow_runs || []) {
    const prev = latest.get(run.workflow_id);
    if (!prev || new Date(run.created_at) > new Date(prev.created_at)) latest.set(run.workflow_id, run);
  }
  const runs = [...latest.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((r) => ({ workflow: r.name, event: r.event, status: r.status, conclusion: r.conclusion, run_url: r.html_url, created_at: r.created_at }));
  if (runs.length === 0) {
    // A ref with no runs yet is a real (if boring) observation, not an
    // API failure — report it explicitly so it cannot be mistaken for a
    // silently-empty list.
    return { runs, note: 'no workflow runs recorded for the tested SHA (yet)' };
  }
  return { runs, note: '' };
});

// Branch-protection enforcement: NOT observable with a repository-scoped
// read token (GitHub answers 403/404 without admin). This is an EXPECTED
// unavailability, not a broken observation - it is recorded as a known
// limitation (never as "not enforced") and does not by itself make the
// snapshot run non-success.
const protection = await observed('branch_protection', async () => {
  const p = await api(`/repos/${REPO}/branches/${encodeURIComponent(DEFAULT_BRANCH)}/protection`);
  return {
    enforced: true,
    required_status_checks: p.required_status_checks ? { strict: p.required_status_checks.strict, contexts: p.required_status_checks.contexts } : null,
    required_approvals: (p.required_pull_request_reviews && p.required_pull_request_reviews.required_approving_review_count) ?? null,
  };
}, { required: false });
if (protection.unavailable) {
  knownLimitations.push(
    `Branch-protection enforcement is UNAVAILABLE (${protection.unavailable}). GitHub exposes branch-protection settings only to admins, so this snapshot can neither confirm nor deny that the checks shown above are REQUIRED for merge. Making them required is a maintainer Settings action (see docs/quality-gates.md).`,
  );
}
knownLimitations.push(
  'CI Linux/Windows/macOS Rust jobs and the mocked E2E suite are not GUI-opening or device tests: physical-device, accessibility and installer smoke behavior remain UNVERIFIED by this snapshot (see docs/quality-gates.md).',
);

// Gate verdicts measured by earlier steps/jobs (never re-implemented here).
let artifactAudit = { verdict: 'unavailable', reason: 'no --artifact-audit verdict was passed (artifact-audit job did not run, was skipped, or its output was lost)' };
if (ARTIFACT_AUDIT_RAW) {
  try {
    const parsed = JSON.parse(ARTIFACT_AUDIT_RAW);
    artifactAudit = { ...parsed, reason: undefined };
  } catch {
    artifactAudit = { verdict: 'unavailable', reason: `--artifact-audit was not valid JSON: ${ARTIFACT_AUDIT_RAW.slice(0, 120)}` };
  }
}
const versionCoherence = {
  implementation: 'npm run validate:versions (scripts/ci/validate-versions.ts — the one authoritative validator)',
  result: COHERENCE || 'unavailable',
  exit_code: COHERENCE_RC === null ? null : Number(COHERENCE_RC),
  note: COHERENCE ? undefined : 'no --version-coherence verdict was passed; run the validator in a step before this command',
};

// ---------------------------------------------------------------------------
// Verdicts and exit state
const gateFailed = artifactAudit.verdict === 'fail' || versionCoherence.result === 'fail';
const requiredMissing = unavailable.length > 0;

// ---------------------------------------------------------------------------
// JSON artifact
const snapshot = {
  schema: 'fress/integration-snapshot@v1',
  generated_at: new Date().toISOString(),
  repository: REPO,
  tested: {
    ref: REF_NAME,
    sha: TESTED_SHA,
    is_default_branch_head: mainHead.value ? mainHead.value.sha === TESTED_SHA : null,
    note: 'the workflow code producing this snapshot comes from the same checkout as the tested SHA',
  },
  default_branch_head: mainHead.value ? { branch: DEFAULT_BRANCH, sha: mainHead.value.sha, html_url: mainHead.value.html_url } : { unavailable: mainHead.unavailable },
  source_version: sourceVersion,
  latest_published_release: latestRelease.value || { unavailable: latestRelease.unavailable },
  release_provenance: {
    release_commit_is_ancestor_of_tested: ancestry.ancestor,
    commits_tested_ahead_of_release: ancestry.tested_ahead_of_release,
    commits_release_ahead_of_tested: ancestry.release_ahead_of_tested,
    note: ancestry.note || undefined,
  },
  open_pull_requests: openPrs.value || { unavailable: openPrs.unavailable, count: null },
  ci_on_tested_sha: ciRuns.value || { unavailable: ciRuns.unavailable },
  artifact_integrity_audit: artifactAudit,
  version_coherence: versionCoherence,
  branch_protection: protection.value || { enforced: 'unavailable', reason: protection.unavailable },
  unavailable_observations: unavailable,
  known_limitations: knownLimitations,
};
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');

// ---------------------------------------------------------------------------
// Markdown step summary
const esc = (s) => String(s).replace(/\|/g, '\\|');
const check = (v) => (v === true ? 'yes' : v === false ? 'no' : '—');
const fmtRun = (r) => `${r.workflow}: ${r.conclusion || r.status} ([run](${r.run_url}))`;

const md = [];
md.push(`# Fress integration snapshot`);
md.push('');
md.push(`> Machine-readable copy: the \`integration-snapshot\` artifact of this run. Generated ${snapshot.generated_at}.`);
md.push('');
md.push('## What was tested');
md.push('');
md.push('| Observation | Value |');
md.push('|---|---|');
md.push(`| Tested ref / full SHA | \`${esc(REF_NAME)}\` @ \`${TESTED_SHA}\` |`);
md.push(`| Default-branch head (\`${esc(DEFAULT_BRANCH)}\`) | ${mainHead.value ? `\`${mainHead.value.sha}\`${snapshot.tested.is_default_branch_head ? ' — same commit as tested' : ` — NOT the tested SHA ([compare](https://github.com/${REPO}/compare/${TESTED_SHA.slice(0, 12)}...${mainHead.value.sha.slice(0, 12)}))`}` : `unavailable: ${mainHead.unavailable}`} |`);
md.push(`| Source version (package.json) | ${sourceVersion ? `\`${sourceVersion}\`` : 'unavailable'} |`);
md.push(`| This snapshot was produced from | the checkout of the tested SHA (workflow code and observed tree are the same commit for push/schedule runs) |`);
md.push('');
md.push('## Newest published release and provenance');
md.push('');
if (latestRelease.value) {
  md.push(`| Observation | Value |`);
  md.push(`|---|---|`);
  md.push(`| Release | [\`${latestRelease.value.tag}\`](${latestRelease.value.html_url}) (prerelease: ${check(latestRelease.value.prerelease)}) |`);
  md.push(`| Tag commit SHA | \`${latestRelease.value.commit_sha}\` |`);
  md.push(`| Published | ${latestRelease.value.published_at} |`);
  md.push(`| Ancestor of tested SHA | ${ancestry.ancestor === null ? `unproven — ${ancestry.note}` : check(ancestry.ancestor)} |`);
  md.push(`| Tested ref ahead of release by | ${ancestry.tested_ahead_of_release === null ? '—' : `${ancestry.tested_ahead_of_release} commit(s)`} |`);
} else {
  md.push(`unavailable: ${latestRelease.unavailable}`);
}
md.push('');
md.push('## Open pull requests');
md.push('');
if (openPrs.value) {
  md.push(`**${openPrs.value.count} open**${openPrs.value.possibly_truncated ? ' (API page limit reached — list may be truncated)' : ''}`);
  md.push('');
  if (openPrs.value.items.length > 0) {
    md.push('| # | Title | Head |');
    md.push('|---|---|---|');
    for (const p of openPrs.value.items) {
      md.push(`| #${p.number} | [${esc(p.title)}](${p.html_url})${p.draft ? ' (draft)' : ''} | \`${p.head_ref}\` @ ${p.head_sha.slice(0, 7)} |`);
    }
  }
} else {
  md.push(`**unavailable: ${openPrs.unavailable}** — no count is displayed because the list could not be fetched.`);
}
md.push('');
md.push('## CI results on the tested SHA');
md.push('');
if (ciRuns.value) {
  if (ciRuns.value.runs.length === 0) {
    md.push(ciRuns.value.note);
  } else {
    for (const r of ciRuns.value.runs) md.push(`- ${fmtRun(r)}`);
  }
} else {
  md.push(`unavailable: ${ciRuns.unavailable}`);
}
md.push('');
md.push('## Gates');
md.push('');
md.push(`| Gate | Verdict | Detail |`);
md.push('|---|---|---|');
md.push(`| Version coherence (\`validate:versions\`) | ${versionCoherence.result.toUpperCase()} | ${esc(versionCoherence.implementation)}${versionCoherence.exit_code !== null ? `, exit ${versionCoherence.exit_code}` : ''}${versionCoherence.note ? ` — ${esc(versionCoherence.note)}` : ''} |`);
md.push(`| Artifact integrity (newest release) | ${String(artifactAudit.verdict).toUpperCase()} | ${artifactAudit.release_tag ? `release \`${artifactAudit.release_tag}\`, verifier exit ${artifactAudit.verifier_exit_code}` + (artifactAudit.hard_failures !== undefined && artifactAudit.hard_failures !== null ? `, ${artifactAudit.hard_failures} hard failure(s)` : '') + (artifactAudit.reason ? ` — ${esc(artifactAudit.reason)}` : '') : esc(artifactAudit.reason || 'no detail')} |`);
md.push('');
md.push('## Known unavailable observations');
md.push('');
if (protection.value) {
  md.push(`- **Branch-protection enforcement**: ENFORCED per API (required checks: ${protection.value.required_status_checks ? esc((protection.value.required_status_checks.contexts || []).join(', ')) : 'none configured'}).`);
}
for (const l of knownLimitations) md.push(`- ${l}`);
if (unavailable.length > 0) {
  md.push('');
  md.push('### Observations that could not be made this run');
  md.push('');
  for (const u of unavailable) md.push(`- **${u.field}**: ${u.reason}`);
}
md.push('');
if (SUMMARY_PATH) writeFileSync(SUMMARY_PATH, md.join('\n') + '\n', { flag: 'a' });
else console.log(md.join('\n'));

// Final verdict + exit state (0 complete & green, 3 incomplete, 4 gate failed)
console.log(`\nintegration-snapshot: ${OUT} written; unavailable=${unavailable.length}, gateFailed=${gateFailed}`);
if (gateFailed) {
  console.error('::error::integration snapshot: a reported gate FAILED (version coherence or artifact integrity) — see the step summary');
  process.exit(4);
}
if (requiredMissing) {
  console.error(`::error::integration snapshot: ${unavailable.length} required observation(s) unavailable (${unavailable.map((u) => u.field).join(', ')}) — the inventory is not silently incomplete`);
  process.exit(3);
}
console.log('::notice::integration snapshot complete: every required observation was available and no reported gate is failing');
