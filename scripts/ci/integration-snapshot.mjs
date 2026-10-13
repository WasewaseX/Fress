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
//   - tested.sha is the commit ACTUALLY checked out (`git rev-parse HEAD`),
//     not the workflow event's idea of it; when GITHUB_SHA differs (a
//     checkout override), both are recorded. The snapshot separately
//     observes the LIVE default-branch head and states whether the tested
//     SHA is that commit — so a scheduled or queued run can never present
//     a prior tip as current main.
//   - A failed or MALFORMED API response is reported as a structured
//     `status: "unavailable"` plus a reason and makes the run NON-success.
//     An empty open-PR list is never displayed when the list could not be
//     fetched (count: null, not 0). Paginated inventories record how many
//     pages were fetched and whether truncation was hit.
//   - CI results are tied to the exact tested SHA (the query filter), and
//     each recorded run repeats its workflow id and head SHA. The
//     aggregate conclusion (pass / failing / pending / none) makes a red
//     workflow impossible to miss in the summary.
//   - Branch-protection enforcement is a maintainer Settings fact that a
//     repository-scoped read token cannot observe; it is reported as a
//     KNOWN unavailable observation, never as "not enforced".
//   - Gate verdicts (version coherence, artifact integrity) are inputs
//     measured by the authoritative commands in earlier workflow steps or
//     jobs — this script never re-implements their rules. A verdict that
//     is missing, lost or unparsable is treated as an unavailable REQUIRED
//     observation (exit 3), never as an implicit pass; only an explicit
//     "fail" verdict is a gate failure (exit 4).
//
// Usage (workflow):
//   node scripts/ci/integration-snapshot.mjs --out integration-snapshot.json \
//        --version-coherence pass|fail --version-coherence-rc N \
//        --artifact-audit '<json verdict from the artifact-audit job>'
// Environment: GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_SHA,
//   GITHUB_STEP_SUMMARY, GITHUB_SERVER_URL + GITHUB_RUN_ID (to link the
//   producing run), and a read token (GH_TOKEN | GITHUB_TOKEN |
//   FRESS_GH_TOKEN). Works locally without Actions env (uses git + argv).
// Test/fixture hooks (not used by the workflow): FRESS_GITHUB_API_BASE
//   overrides the API base URL for mock servers; FRESS_API_RETRY_DELAY_MS
//   shrinks the transient-retry backoff in tests.
//
// Exit codes: 0 complete snapshot, every required observation available,
//   no gate failing. 2 the snapshot could not be produced at all
//   (unexpected failure writing/running — the artifact may be absent).
//   3 one or more REQUIRED observations unavailable (including a lost or
//   unparsable gate verdict). 4 a reported gate FAILED (version coherence
//   or artifact integrity).
// Exit precedence: 4 (gate failed) wins over 3 (incomplete), so a red run
//   always names the strongest reason in its annotation.

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

if (args.includes('--help') || args.includes('-h')) {
  console.log(`usage: node scripts/ci/integration-snapshot.mjs [--out FILE]
              [--version-coherence pass|fail] [--version-coherence-rc N]
              [--artifact-audit '<verdict json>']
env: GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_SHA, GITHUB_STEP_SUMMARY,
     GH_TOKEN | GITHUB_TOKEN | FRESS_GH_TOKEN (read-only)
exit: 0 ok · 2 could not produce the snapshot · 3 required observation(s) unavailable · 4 a gate failed`);
  process.exit(0);
}

const OUT = argValue('--out') || 'integration-snapshot.json';
const COHERENCE = argValue('--version-coherence') || null; // pass | fail | (absent -> unavailable)
const COHERENCE_RC = argValue('--version-coherence-rc') || null;
const ARTIFACT_AUDIT_RAW = argValue('--artifact-audit') || '';

const REPO_SLUG = (process.env.GITHUB_REPOSITORY || git(['config', '--get', 'remote.origin.url']).replace(/.*github\.com[:/]/, '').replace(/\.git$/, '')).trim();
// Without a repository slug every API path would be `/repos//...` — a
// request that can only produce lies. Fail closed with an actionable
// diagnostic instead of running the observations against a broken path.
if (!REPO_SLUG) {
  unavailable.push({ field: 'repository', reason: 'no repository slug: GITHUB_REPOSITORY is unset and no origin remote could be read — set GITHUB_REPOSITORY=<owner>/<repo> (or add an origin remote) for the API observations' });
}
const REPO = REPO_SLUG;
// tested.sha is the commit ACTUALLY checked out. `git rev-parse HEAD` is the
// provable fact; GITHUB_SHA is what the event claimed. They are the same in
// this workflow (checkout defaults to GITHUB_SHA), but a checkout override
// would otherwise silently mislabel the observation, so the event SHA is
// recorded separately whenever the two disagree.
const TESTED_SHA = git(['rev-parse', 'HEAD']) || process.env.GITHUB_SHA || '';
const EVENT_SHA = process.env.GITHUB_SHA || null;
const REF_NAME = process.env.GITHUB_REF_NAME || git(['branch', '--show-current']) || '(detached HEAD)';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.FRESS_GH_TOKEN || '';
const SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY || null;
const RUN_URL = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

function git(gitArgs) {
  try {
    return execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 16 << 20 }).trim();
  } catch (err) {
    return '';
  }
}

// Last-resort honesty: an unexpected crash must produce the distinct
// "could not produce the snapshot" exit code with an annotation, never a
// silently-missing artifact or a generic CI red with no cause.
process.on('uncaughtException', (err) => {
  console.error(`::error::integration snapshot: could not be produced: ${err && err.message ? err.message : err}`);
  process.exit(2);
});
process.on('unhandledRejection', (err) => {
  console.error(`::error::integration snapshot: could not be produced: ${err && err.message ? err.message : err}`);
  process.exit(2);
});

// ---------------------------------------------------------------------------
// GitHub REST (read-only). One honest retry for transient transport/5xx
// failures; never a retry that could turn a 4xx judgment into success.
const unavailable = []; // {field, reason}
const knownLimitations = [];

const API_BASE = (() => {
  const base = process.env.FRESS_GITHUB_API_BASE || 'https://api.github.com';
  if (!/^https?:\/\//.test(base)) {
    throw Object.assign(new Error(`FRESS_GITHUB_API_BASE must be an http(s) URL, got "${base}"`), { fatal: true });
  }
  return base.replace(/\/$/, '');
})();

const RETRY_DELAY_MS = Number(process.env.FRESS_API_RETRY_DELAY_MS ?? 3000) || 3000;

async function api(path) {
  if (!REPO_SLUG) {
    throw Object.assign(new Error('no repository slug (set GITHUB_REPOSITORY or add an origin remote)'), { config: true });
  }
  if (!TOKEN) {
    throw Object.assign(new Error('no read token available (set GH_TOKEN)'), { config: true });
  }
  const url = `${API_BASE}${path}`;
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
      if (res.status >= 500 && attempt === 1) { lastErr = err; await sleep(RETRY_DELAY_MS); continue; }
      throw err;
    } catch (err) {
      lastErr = err;
      const transient = !err.status || err.status >= 500; // network / timeout / 5xx
      if (transient && attempt === 1) { await sleep(RETRY_DELAY_MS); continue; }
      throw err;
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A response that arrived but does not have the documented shape. Marked
 * so `observed()` reports it as malformed data, not as a network problem. */
function shapeError(message) {
  return Object.assign(new Error(message), { shape: true });
}

async function observed(field, fn, { required = true } = {}) {
  try {
    return { value: await fn(), unavailable: null };
  } catch (err) {
    let reason;
    if (err && err.config) reason = err.message;
    else if (err && err.shape) reason = `malformed response: ${err.message}`;
    else if (err && err.status) reason = `GitHub API ${err.status} (${err.message})`;
    else reason = `network/transport failure: ${err.message}`;
    if (required) unavailable.push({ field, reason });
    return { value: null, unavailable: reason };
  }
}

/** Fetch a paginated collection. Returns the aggregated items plus honest
 * pagination facts: how many pages were fetched and whether the safety cap
 * (maxPages pages of 100) truncated the inventory. A response whose shape
 * is not the documented one throws a shape error (-> unavailable), so a
 * malformed payload can never masquerade as an empty list. */
async function paged(path, pick, { maxPages = 10 } = {}) {
  const items = [];
  let pagesFetched = 0;
  let truncated = false;
  let totalCount = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await api(`${path}${sep}per_page=100&page=${page}`);
    const arr = pick(body);
    pagesFetched = page;
    if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.total_count === 'number') {
      totalCount = body.total_count;
    }
    items.push(...arr);
    if (arr.length < 100) return { items, pagesFetched, truncated: false, totalCount };
    if (page === maxPages) truncated = true;
  }
  return { items, pagesFetched, truncated, totalCount };
}

// ---------------------------------------------------------------------------
// Observations
const sourceVersion = (() => {
  let raw;
  try {
    raw = JSON.parse(readFileSync('package.json', 'utf8'));
  } catch (err) {
    unavailable.push({ field: 'source_version', reason: `package.json (the authoritative manifest) could not be read/parsed from the checkout: ${err.message}` });
    return null;
  }
  if (!raw || typeof raw.version !== 'string' || raw.version.length === 0) {
    unavailable.push({ field: 'source_version', reason: 'package.json (the authoritative manifest) has no string .version field' });
    return null;
  }
  return raw.version;
})();

const repoMeta = await observed('repository_metadata', async () => {
  const body = await api(`/repos/${REPO}`);
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.default_branch !== 'string') {
    throw shapeError(`repository payload has no string default_branch (got ${body === null ? 'null' : typeof body})`);
  }
  return body;
});
const DEFAULT_BRANCH = repoMeta.value ? repoMeta.value.default_branch : 'main';

const mainHead = await observed('default_branch_head', async () => {
  const body = await api(`/repos/${REPO}/commits/${encodeURIComponent(DEFAULT_BRANCH)}`);
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.sha !== 'string') {
    throw shapeError('default-branch commit payload has no string sha');
  }
  return body;
});

const latestRelease = await observed('latest_published_release', async () => {
  // /releases/latest excludes prereleases (every Fress release is one),
  // so the inventory comes from the releases list instead — the same
  // ordering the releases page shows (newest created first).
  const list = await paged(`/repos/${REPO}/releases`, (b) => {
    if (!Array.isArray(b)) throw shapeError('releases payload is not an array');
    return b;
  }, { maxPages: 1 });
  if (list.items.length === 0) throw Object.assign(new Error('no releases at all'), { status: 404 });
  const rel = list.items[0];
  if (!rel || typeof rel.tag_name !== 'string') {
    throw shapeError('newest release payload has no string tag_name');
  }
  // Resolve the tag to a commit SHA (annotated tags point at a tag object).
  const ref = await api(`/repos/${REPO}/git/ref/tags/${encodeURIComponent(rel.tag_name)}`);
  if (!ref || !ref.object || typeof ref.object.sha !== 'string') {
    throw shapeError(`git ref payload for tag ${rel.tag_name} has no object.sha`);
  }
  let tagSha = ref.object.sha;
  if (ref.object.type === 'tag') {
    const tagObj = await api(`/repos/${REPO}/git/tags/${tagSha}`);
    if (!tagObj || !tagObj.object || typeof tagObj.object.sha !== 'string') {
      throw shapeError('annotated tag payload has no object.sha');
    }
    tagSha = tagObj.object.sha;
  }
  return {
    tag: rel.tag_name,
    html_url: typeof rel.html_url === 'string' ? rel.html_url : null,
    published_at: typeof rel.published_at === 'string' ? rel.published_at : null,
    created_at: typeof rel.created_at === 'string' ? rel.created_at : null,
    prerelease: rel.prerelease === true,
    draft: rel.draft === true,
    tag_sha: tagSha,
  };
});

// Provenance: is the newest release an ancestor of the tested SHA, and how
// far has the tested ref moved since it? (Local git over the full checkout;
// requires fetch-depth: 0 in the workflow.)
let ancestry = { ancestor: null, tested_ahead_of_release: null, release_ahead_of_tested: null, note: '' };
if (!TESTED_SHA) {
  ancestry.note = 'tested SHA could not be determined — provenance not computed';
} else if (latestRelease.value && latestRelease.value.tag_sha) {
  const sha = latestRelease.value.tag_sha;
  // Quiet rev-parse: empty output == commit not in this checkout.
  const haveCommit = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) !== '';
  if (!haveCommit) {
    ancestry.note = 'release commit not present in this checkout (shallow clone or unrelated history) — run with fetch-depth: 0 to prove provenance';
  } else {
    const mergeBase = git(['merge-base', '--is-ancestor', sha, 'HEAD']);
    ancestry.ancestor = mergeBase === '';
    ancestry.tested_ahead_of_release = Number(git(['rev-list', '--count', `${sha}..HEAD`])) || 0;
    ancestry.release_ahead_of_tested = Number(git(['rev-list', '--count', `HEAD..${sha}`])) || 0;
  }
}

const openPrs = await observed('open_pull_requests', async () => {
  const pageData = await paged(`/repos/${REPO}/pulls?state=open`, (b) => {
    if (!Array.isArray(b)) throw shapeError('pull-requests payload is not an array');
    return b;
  });
  const items = pageData.items.map((p) => ({
    number: typeof p?.number === 'number' ? p.number : null,
    title: typeof p?.title === 'string' ? p.title : null,
    html_url: typeof p?.html_url === 'string' ? p.html_url : null,
    head_ref: typeof p?.head?.ref === 'string' ? p.head.ref : null,
    head_sha: typeof p?.head?.sha === 'string' ? p.head.sha : null,
    draft: p?.draft === true,
    created_at: typeof p?.created_at === 'string' ? p.created_at : null,
  }));
  return {
    status: 'ok',
    count: items.length,
    truncated: pageData.truncated,
    pages_fetched: pageData.pagesFetched,
    items,
    ...(pageData.truncated ? { note: `inventory capped at ${pageData.items.length} items (pagination safety limit) — list may be incomplete` } : {}),
  };
});

const CI_FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);

// Without a tested SHA the runs query would be UNFILTERED — every recent
// run of the repository would masquerade as "CI on the tested SHA". That
// is exactly the successful-looking default the schema forbids, so an
// undeterminable tested SHA makes the CI observation (and provenance)
// unavailable instead.
let ciRuns;
if (!TESTED_SHA) {
  unavailable.push({ field: 'tested_sha', reason: 'could not determine the tested SHA (no git checkout and no GITHUB_SHA); the CI query must not run unfiltered' });
  ciRuns = { value: null, unavailable: 'tested SHA could not be determined' };
} else {
  ciRuns = await observed('ci_on_tested_sha', async () => {
  const pageData = await paged(`/repos/${REPO}/actions/runs?head_sha=${TESTED_SHA}`, (b) => {
    if (!b || typeof b !== 'object' || !Array.isArray(b.workflow_runs)) {
      throw shapeError('workflow-runs payload has no workflow_runs array');
    }
    return b.workflow_runs;
  });
  const latest = new Map();
  for (const run of pageData.items) {
    if (!run || typeof run !== 'object') continue;
    const id = typeof run.workflow_id === 'number' ? run.workflow_id : String(run.workflow_id ?? run.name ?? 'unknown');
    const prev = latest.get(id);
    if (!prev || new Date(run.created_at) > new Date(prev.created_at)) latest.set(id, run);
  }
  const runs = [...latest.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((r) => ({
      workflow: typeof r.name === 'string' ? r.name : '(unknown workflow)',
      workflow_id: typeof r.workflow_id === 'number' ? r.workflow_id : null,
      event: typeof r.event === 'string' ? r.event : null,
      status: typeof r.status === 'string' ? r.status : null,
      conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
      run_url: typeof r.html_url === 'string' ? r.html_url : null,
      head_sha: typeof r.head_sha === 'string' ? r.head_sha : null,
      created_at: typeof r.created_at === 'string' ? r.created_at : null,
    }));
  const completed = runs.filter((r) => r.status === 'completed');
  const failing = runs.filter((r) => r.conclusion !== null && CI_FAILURE_CONCLUSIONS.has(r.conclusion));
  const pending = runs.some((r) => r.status && r.status !== 'completed');
  const aggregated = runs.length === 0 ? 'none' : failing.length > 0 ? 'failing' : pending ? 'pending' : 'pass';
    return {
      status: 'ok',
      tested_sha_filter: TESTED_SHA, // every run below was queried by this exact commit SHA
      aggregated_conclusion: aggregated,
      failing_workflows: failing.map((r) => r.workflow),
      runs,
      pages_fetched: pageData.pagesFetched,
      truncated: pageData.truncated,
      ...(pageData.truncated ? { note: `inventory capped at ${pageData.items.length} runs (pagination safety limit) — list may be incomplete` } : {}),
      ...(runs.length === 0 ? { note: 'no workflow runs recorded for the tested SHA (yet)' } : {}),
    };
  });
}

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

// ---------------------------------------------------------------------------
// Gate verdicts measured by earlier steps/jobs (never re-implemented here).
function normalizeAuditVerdict(raw) {
  if (!raw) {
    return { verdict: 'unavailable', reason: 'no --artifact-audit verdict was passed (artifact-audit job did not run, was skipped, or its output was lost)' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { verdict: 'unavailable', reason: `--artifact-audit was not valid JSON: ${raw.slice(0, 120)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { verdict: 'unavailable', reason: `--artifact-audit was not a JSON object: ${raw.slice(0, 120)}` };
  }
  if (parsed.verdict !== 'pass' && parsed.verdict !== 'fail' && parsed.verdict !== 'unavailable') {
    return { verdict: 'unavailable', reason: `--artifact-audit verdict is missing or not one of pass|fail|unavailable (got ${JSON.stringify(parsed.verdict ?? null)})` };
  }
  // A real verdict: normalize the optional detail fields explicitly so a
  // partial payload can never print "undefined" or look richer than it is.
  return {
    verdict: parsed.verdict,
    release_tag: typeof parsed.release_tag === 'string' ? parsed.release_tag : null,
    verifier_exit_code: typeof parsed.verifier_exit_code === 'number' ? parsed.verifier_exit_code : null,
    hard_failures: typeof parsed.hard_failures === 'number' ? parsed.hard_failures : null,
    ...(parsed.verdict === 'unavailable' && typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
  };
}
const artifactAudit = normalizeAuditVerdict(ARTIFACT_AUDIT_RAW);
if (artifactAudit.verdict === 'unavailable') {
  unavailable.push({ field: 'artifact_integrity_audit', reason: artifactAudit.reason || 'artifact-audit verdict unavailable' });
}

function normalizeCoherenceVerdict(value, rc) {
  if (!value) {
    return {
      implementation: 'npm run validate:versions (scripts/ci/validate-versions.ts — the one authoritative validator)',
      result: 'unavailable',
      exit_code: null,
      note: 'no --version-coherence verdict was passed; run the validator in a step before this command',
    };
  }
  if (value !== 'pass' && value !== 'fail') {
    return {
      implementation: 'npm run validate:versions (scripts/ci/validate-versions.ts — the one authoritative validator)',
      result: 'unavailable',
      exit_code: null,
      note: `--version-coherence must be pass or fail (got "${value}")`,
    };
  }
  return {
    implementation: 'npm run validate:versions (scripts/ci/validate-versions.ts — the one authoritative validator)',
    result: value,
    exit_code: rc === null ? null : Number.isFinite(Number(rc)) ? Number(rc) : null,
  };
}
const versionCoherence = normalizeCoherenceVerdict(COHERENCE, COHERENCE_RC);
if (versionCoherence.result === 'unavailable') {
  unavailable.push({ field: 'version_coherence', reason: versionCoherence.note || 'version-coherence verdict unavailable' });
}

// ---------------------------------------------------------------------------
// Verdicts and exit state
const gateFailed = artifactAudit.verdict === 'fail' || versionCoherence.result === 'fail';
const requiredMissing = unavailable.length > 0;

// ---------------------------------------------------------------------------
// JSON artifact (schema fress/integration-snapshot@v2)
//
// Field meanings (the six values the schema exists to keep distinct):
//   tested.sha                  the commit ACTUALLY checked out and observed.
//   tested.event_sha            GITHUB_SHA, recorded when it differs from
//                               tested.sha (checkout override honesty).
//   tested.is_default_branch_head whether tested.sha equaled the LIVE
//                               default-branch head at observation time
//                               (null = the head could not be observed).
//   default_branch.head_sha     the latest observed default-branch head.
//   release.tag_sha             the release tag's target commit.
//   release.is_ancestor_of_tested the actual Git ancestry relationship.
//   ci.runs                     workflow runs whose head SHA is exactly
//                               ci.tested_sha_filter, with ids + URLs.
// Every externally-sourced section carries status "ok" | "unavailable";
// when unavailable, its reason is recorded and no successful-looking
// default (empty array, zero count) is substituted.
const testedMismatch = EVENT_SHA && TESTED_SHA && EVENT_SHA !== TESTED_SHA;

const snapshot = {
  schema: 'fress/integration-snapshot@v2',
  generated_at: new Date().toISOString(),
  repository: REPO_SLUG || null,
  ...(RUN_URL ? { snapshot_run: { url: RUN_URL } } : {}),
  tested: {
    ref: REF_NAME,
    sha: TESTED_SHA,
    ...(testedMismatch ? { event_sha: EVENT_SHA, note: 'GITHUB_SHA differed from the checked-out commit; tested.sha is the actual checkout' } : { event_sha: EVENT_SHA }),
    is_default_branch_head: mainHead.value ? mainHead.value.sha === TESTED_SHA : null,
    note: testedMismatch
      ? 'GITHUB_SHA differed from the checked-out commit; tested.sha is the actual checkout'
      : 'the workflow code producing this snapshot comes from the same checkout as the tested SHA',
  },
  default_branch: mainHead.value
    ? { status: 'ok', name: DEFAULT_BRANCH, head_sha: mainHead.value.sha, html_url: mainHead.value.html_url || null }
    : { status: 'unavailable', reason: mainHead.unavailable },
  source_version: sourceVersion,
  release: latestRelease.value
    ? {
        status: 'ok',
        tag: latestRelease.value.tag,
        tag_sha: latestRelease.value.tag_sha,
        html_url: latestRelease.value.html_url,
        published_at: latestRelease.value.published_at,
        created_at: latestRelease.value.created_at,
        prerelease: latestRelease.value.prerelease,
        draft: latestRelease.value.draft,
        is_ancestor_of_tested: ancestry.ancestor,
        commits_tested_ahead_of_release: ancestry.tested_ahead_of_release,
        commits_release_ahead_of_tested: ancestry.release_ahead_of_tested,
        ...(ancestry.note ? { provenance_note: ancestry.note } : {}),
      }
    : { status: 'unavailable', reason: latestRelease.unavailable },
  open_pull_requests: openPrs.value || { status: 'unavailable', reason: openPrs.unavailable, count: null, items: null },
  ci: ciRuns.value || { status: 'unavailable', reason: ciRuns.unavailable },
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
const fmtRun = (r) => `${r.workflow}: ${r.conclusion || r.status || 'unknown'}${r.run_url ? ` ([run](${r.run_url}))` : ''}`;

const md = [];
md.push(`# Fress integration snapshot`);
md.push('');
md.push(`> Machine-readable copy: the \`integration-snapshot\` artifact of this run. Generated ${snapshot.generated_at}.${RUN_URL ? ` Producing run: ${RUN_URL}.` : ''}`);
md.push('');
md.push('## What was tested');
md.push('');
md.push('| Observation | Value |');
md.push('|---|---|');
md.push(`| Tested ref / full SHA | \`${esc(REF_NAME)}\` @ \`${TESTED_SHA}\` |`);
if (testedMismatch) md.push(`| Event SHA (GITHUB_SHA) | \`${EVENT_SHA}\` — differs from the checked-out commit above |`);
md.push(`| Default-branch head (\`${esc(DEFAULT_BRANCH)}\`) | ${mainHead.value ? `\`${mainHead.value.sha}\`${snapshot.tested.is_default_branch_head ? ' — same commit as tested' : ` — NOT the tested SHA ([compare](https://github.com/${REPO}/compare/${TESTED_SHA.slice(0, 12)}...${mainHead.value.sha.slice(0, 12)}))`}` : `unavailable: ${mainHead.unavailable}`} |`);
md.push(`| Source version (package.json) | ${sourceVersion ? `\`${sourceVersion}\`` : 'unavailable'} |`);
md.push(`| This snapshot was produced from | the checkout of the tested SHA (workflow code and observed tree are the same commit for push/schedule runs) |`);
md.push('');
md.push('## Newest published release and provenance');
md.push('');
if (latestRelease.value) {
  md.push(`| Observation | Value |`);
  md.push(`|---|---|`);
  md.push(`| Release | [${latestRelease.value.tag ? `\`${latestRelease.value.tag}\`` : 'unknown'}](${latestRelease.value.html_url || `https://github.com/${REPO}/releases`}) (prerelease: ${check(latestRelease.value.prerelease)}) |`);
  md.push(`| Tag commit SHA | \`${latestRelease.value.tag_sha}\` |`);
  md.push(`| Published | ${latestRelease.value.published_at ?? '—'} |`);
  md.push(`| Ancestor of tested SHA | ${ancestry.ancestor === null ? `unproven — ${ancestry.note}` : check(ancestry.ancestor)} |`);
  md.push(`| Tested ref ahead of release by | ${ancestry.tested_ahead_of_release === null ? '—' : `${ancestry.tested_ahead_of_release} commit(s)`} |`);
} else {
  md.push(`unavailable: ${latestRelease.unavailable}`);
}
md.push('');
md.push('## Open pull requests');
md.push('');
if (openPrs.value) {
  const trunc = openPrs.value.truncated
    ? ` — **pagination cap reached, list may be incomplete**`
    : openPrs.value.pages_fetched > 1
      ? ` (${openPrs.value.pages_fetched} API pages fetched)`
      : '';
  md.push(`**${openPrs.value.count} open**${trunc}`);
  md.push('');
  if (openPrs.value.items && openPrs.value.items.length > 0) {
    md.push('| # | Title | Head |');
    md.push('|---|---|---|');
    for (const p of openPrs.value.items) {
      const title = p.title ? (p.html_url ? `[${esc(p.title)}](${p.html_url})` : esc(p.title)) : '(untitled)';
      const head = p.head_sha ? `\`${p.head_ref ?? '?'}\` @ ${p.head_sha.slice(0, 7)}` : '`?`';
      md.push(`| ${p.number !== null ? `#${p.number}` : '?'} | ${title}${p.draft ? ' (draft)' : ''} | ${head} |`);
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
    md.push('**CI aggregate: none** — no workflow runs recorded for the tested SHA.');
  } else {
    const agg = ciRuns.value.aggregated_conclusion;
    const aggLine =
      agg === 'pass'
        ? '**CI aggregate: PASS** (every observed workflow run on the tested SHA concluded success)'
        : agg === 'failing'
          ? `**CI aggregate: FAILING** — ${ciRuns.value.failing_workflows.join(', ')} concluded with a failure on the tested SHA`
          : agg === 'pending'
            ? '**CI aggregate: PENDING** — at least one workflow run on the tested SHA had not finished at observation time'
            : '**CI aggregate: none** — no workflow runs recorded for the tested SHA';
    md.push(aggLine);
    md.push('');
    md.push(`Every run below was queried by the exact tested SHA (\`${TESTED_SHA.slice(0, 12)}…\`).`);
    md.push('');
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
md.push(`| Version coherence (\`validate:versions\`) | ${versionCoherence.result.toUpperCase()} | ${esc(versionCoherence.implementation)}${versionCoherence.exit_code !== null && versionCoherence.exit_code !== undefined ? `, exit ${versionCoherence.exit_code}` : ''}${versionCoherence.note ? ` — ${esc(versionCoherence.note)}` : ''} |`);
md.push(`| Artifact integrity (newest release) | ${String(artifactAudit.verdict).toUpperCase()} | ${artifactAudit.release_tag ? `release \`${artifactAudit.release_tag}\`` + (artifactAudit.verifier_exit_code !== null ? `, verifier exit ${artifactAudit.verifier_exit_code}` : '') + (artifactAudit.hard_failures !== null ? `, ${artifactAudit.hard_failures} hard failure(s)` : '') + (artifactAudit.reason ? ` — ${esc(artifactAudit.reason)}` : '') : esc(artifactAudit.reason || 'no detail')} |`);
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

// Final verdict + exit state (0 complete & green, 2 could not produce, 3 incomplete, 4 gate failed)
console.log(`\nintegration-snapshot: ${OUT} written; unavailable=${unavailable.length}, gateFailed=${gateFailed}, ciAggregate=${ciRuns.value ? ciRuns.value.aggregated_conclusion : 'unavailable'}`);
if (gateFailed) {
  console.error('::error::integration snapshot: a reported gate FAILED (version coherence or artifact integrity) — see the step summary');
  process.exit(4);
}
if (requiredMissing) {
  console.error(`::error::integration snapshot: ${unavailable.length} required observation(s) unavailable (${unavailable.map((u) => u.field).join(', ')}) — the inventory is not silently incomplete`);
  process.exit(3);
}
if (ciRuns.value && ciRuns.value.aggregated_conclusion === 'failing') {
  console.error(`::warning::integration snapshot: CI on the tested SHA is FAILING (${ciRuns.value.failing_workflows.join(', ')}) — recorded as an observation; gate failures decide the exit code`);
}
console.log('::notice::integration snapshot complete: every required observation was available and no reported gate is failing');
