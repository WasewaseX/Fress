// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Behavior tests for scripts/ci/integration-snapshot.mjs
 * (the public integration-state audit command).
 *
 * The script is exercised as a real subprocess against temporary git
 * fixture checkouts, with the GitHub REST boundary replaced by a local
 * mock server (FRESS_GITHUB_API_BASE) — no production token, no real
 * repository access, no repository mutations, no real Git tags. Every
 * test asserts the OBSERVABLE CONTRACT: the JSON artifact's fields, the
 * Markdown summary text and the process exit code — not an internal
 * function's return value.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/ci/integration-snapshot.mjs');
const REPO = 'WasewaseX/Fress';
const TAG = 'v1.0.11-beta';
const VERSION = '1.0.11-beta';

// -- scratch management (gitignored node_modules/.tmp-*, self-cleaning) ------
const scratchRoots: string[] = [];
afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return (run.stdout || '').trim();
}

/** A fixture checkout with 1..n commits; returns the full SHAs in order. */
function makeFixture(commits = 1): { root: string; shas: string[] } {
  const root = mkdtempSync(join(resolve(process.cwd()), 'node_modules', '.tmp-snapshot-fixture-'));
  scratchRoots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  // A realistic origin so the script's slug resolution (origin URL parsing)
  // is exercised, not the fallback diagnostic.
  git(root, ['remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
  const shas: string[] = [];
  const messages = ['release: ship it', 'docs: note the release', 'test: extend coverage', 'chore: more work after the release'];
  for (let i = 0; i < commits; i += 1) {
    writeFileSync(join(root, `file-${i}.txt`), `commit ${i}\n`);
    git(root, ['add', '-A']);
    git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', messages[i % messages.length]]);
    shas.push(git(root, ['rev-parse', 'HEAD']));
  }
  // The snapshot reads the source version from the checkout.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fress', version: VERSION }, null, 2));
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'chore: record source version']);
  shas.push(git(root, ['rev-parse', 'HEAD']));
  return { root, shas };
}

// -- GitHub API mock ----------------------------------------------------------
interface MockState {
  /** default-branch head reported by /commits/<branch> */
  branchHead: string;
  /** release inventory (first entry is "newest") */
  releases: Array<{ tag_name: string; html_url?: string; published_at?: string; created_at?: string; prerelease?: boolean; draft?: boolean }>;
  /** tag -> target commit sha (type commit; annotated tags not needed here) */
  tagTargets: Record<string, string>;
  /** open PRs; a function may synthesize per-page bodies */
  pulls: Array<Record<string, unknown>> | ((page: number) => unknown);
  /** workflow runs for the tested SHA; a function may synthesize per-page bodies */
  runs: Array<Record<string, unknown>> | ((page: number) => unknown);
  /** force a raw (malformed) body for a path substring */
  malformed?: { match: string; body: unknown };
  /** force an HTTP status for a path substring */
  fail?: { match: string; status: number };
}

const NOT_FOUND_SHA = 'f'.repeat(40);
let state: MockState | null = null;
const requestLog: string[] = [];

function pr(number: number, title: string): Record<string, unknown> {
  return {
    number,
    title,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    head: { ref: `feature/${number}`, sha: `p${number}`.padEnd(40, '0').slice(0, 40) },
    draft: false,
    created_at: '2026-10-13T00:00:00Z',
  };
}

function defaultRun(headSha: string, conclusion = 'success', status = 'completed'): Record<string, unknown> {
  return {
    name: 'CI',
    workflow_id: 364055487,
    event: 'push',
    status,
    conclusion,
    html_url: `https://github.com/${REPO}/actions/runs/999`,
    head_sha: headSha,
    created_at: '2026-10-13T00:10:00Z',
  };
}

function handle(method: string, pathname: string, query: URLSearchParams): { status: number; body: unknown } {
  if (method !== 'GET') return { status: 405, body: { message: 'method not allowed' } };
  requestLog.push(`${pathname}?${query.toString()}`);
  const s = state!;
  if (s.fail && pathname.includes(s.fail.match)) return { status: s.fail.status, body: { message: 'injected failure' } };
  if (s.malformed && pathname.includes(s.malformed.match)) return { status: 200, body: s.malformed.body };

  if (pathname === `/repos/${REPO}`) return { status: 200, body: { default_branch: 'main', full_name: REPO } };
  if (pathname.startsWith(`/repos/${REPO}/commits/`)) return { status: 200, body: { sha: s.branchHead, html_url: `https://github.com/${REPO}/commit/${s.branchHead}` } };
  if (pathname.startsWith(`/repos/${REPO}/releases`)) {
    const page = Number(query.get('page') || '1');
    const arr = s.releases;
    return { status: 200, body: page === 1 ? arr : [] };
  }
  const tagRef = pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/ref\/tags\/(.+)$/);
  if (tagRef) {
    const tag = decodeURIComponent(tagRef[1]);
    const target = s.tagTargets[tag];
    if (!target) return { status: 404, body: { message: 'tag not found' } };
    return { status: 200, body: { object: { sha: target, type: 'commit' } } };
  }
  if (pathname.startsWith(`/repos/${REPO}/pulls`)) {
    const page = Number(query.get('page') || '1');
    return { status: 200, body: typeof s.pulls === 'function' ? s.pulls(page) : s.pulls };
  }
  if (pathname.startsWith(`/repos/${REPO}/actions/runs`)) {
    const page = Number(query.get('page') || '1');
    const body = typeof s.runs === 'function' ? s.runs(page) : s.runs;
    const runs = Array.isArray(body) ? body : (body as { workflow_runs: unknown[] }).workflow_runs;
    return { status: 200, body: { total_count: runs.length, workflow_runs: runs } };
  }
  if (pathname.includes('/branches/main/protection')) return { status: 404, body: { message: 'Not Found' } };
  return { status: 404, body: { message: `unmocked path ${pathname}` } };
}

let server: Server | null = null;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const out = handle(req.method || 'GET', url.pathname, url.searchParams);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const addr = server.address();
  if (addr === null || typeof addr === 'object') baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  else baseUrl = `http://127.0.0.1:${addr}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server!.close(() => done()));
});

function freshHandlers(root: string, overrides: Partial<MockState> = {}): void {
  const head = git(root, ['rev-parse', 'HEAD']);
  state = {
    branchHead: head,
    releases: [{ tag_name: TAG, html_url: `https://github.com/${REPO}/releases/tag/${TAG}`, published_at: '2026-10-12T20:09:33Z', created_at: '2026-10-12T19:00:00Z', prerelease: true, draft: false }],
    tagTargets: { [TAG]: head },
    pulls: [],
    runs: [defaultRun(head)],
    ...overrides,
  };
}

/** Spawn the real script in the fixture checkout with a hermetic
 * environment: no GITHUB_* leakage from the outer CI environment.
 *
 * ASYNC ON PURPOSE: the GitHub mock server lives in this worker's event
 * loop, so the child must run while the loop stays free. A synchronous
 * spawnSync here would deadlock (child waits for HTTP answers the blocked
 * parent can never deliver). A hard-kill timer bounds a runaway child. */
async function runSnapshot(
  root: string,
  opts: { args?: string[]; env?: Record<string, string>; out?: string; noToken?: boolean } = {},
): Promise<{ status: number; stdout: string; stderr: string; json: () => any }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (k.startsWith('GITHUB_') || k === 'GH_TOKEN' || k.startsWith('FRESS_')) continue; // strip boundaries
    env[k] = v;
  }
  if (!opts.noToken) env.GH_TOKEN = 'fixture-read-token';
  env.FRESS_GITHUB_API_BASE = baseUrl;
  env.FRESS_API_RETRY_DELAY_MS = '5';
  Object.assign(env, opts.env || {});
  const outPath = opts.out || join(root, 'integration-snapshot.json');
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT, '--out', outPath, ...(opts.args || [])], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      clearTimeout(killer);
      resolvePromise({ status: -1, stdout, stderr: `spawn error: ${err.message}`, json: () => { throw new Error(`no artifact written (${err.message})`); } });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolvePromise({
        status: code ?? -1,
        stdout,
        stderr,
        json: () => JSON.parse(readFileSync(outPath, 'utf8')),
      });
    });
  });
}

// -- tests --------------------------------------------------------------------
afterEach(() => {
  state = null;
  requestLog.length = 0;
});

describe('integration-snapshot.mjs (spawned against fixtures + a mock GitHub API)', () => {
  it('1. records a correct default-branch checkout with passing CI and exits 0', async () => {
    const { root, shas } = makeFixture(1);
    freshHandlers(root);
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(0);
    const snap = r.json();
    expect(snap.schema).toBe('fress/integration-snapshot@v2');
    expect(snap.tested.sha).toBe(shas[shas.length - 1]);
    expect(snap.tested.is_default_branch_head).toBe(true);
    expect(snap.default_branch.status).toBe('ok');
    expect(snap.default_branch.head_sha).toBe(shas[shas.length - 1]);
    expect(snap.source_version).toBe(VERSION);
    expect(snap.ci.status).toBe('ok');
    expect(snap.ci.tested_sha_filter).toBe(shas[shas.length - 1]);
    expect(snap.ci.aggregated_conclusion).toBe('pass');
    expect(snap.ci.runs[0].head_sha).toBe(shas[shas.length - 1]);
    expect(snap.ci.runs[0].workflow_id).toBe(364055487);
    expect(snap.unavailable_observations).toEqual([]);
    // Summary text: the proven pair is stated, the aggregate is stated.
    expect(r.stdout).toContain('same commit as tested');
    expect(r.stdout).toContain('**CI aggregate: PASS**');
    expect(r.stdout).toContain('::notice::');
  });

  it('2. a successful run against a commit that is no longer the branch head says so (and links the compare)', async () => {
    const { root } = makeFixture(1);
    const other = 'a'.repeat(40);
    freshHandlers(root, { branchHead: other });
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', release_tag: TAG })] });
    expect(r.status).toBe(0);
    const snap = r.json();
    expect(snap.tested.is_default_branch_head).toBe(false);
    expect(snap.default_branch.head_sha).toBe(other);
    expect(r.stdout).toContain('NOT the tested SHA');
    expect(r.stdout).toContain('/compare/');
  });

  it('3. a release tag equal to the default-branch tip proves full provenance', async () => {
    const { root, shas } = makeFixture(1);
    freshHandlers(root);
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(0);
    const snap = r.json();
    expect(snap.release.tag_sha).toBe(shas[shas.length - 1]);
    expect(snap.release.is_ancestor_of_tested).toBe(true);
    expect(snap.release.commits_tested_ahead_of_release).toBe(0);
    expect(snap.release.commits_release_ahead_of_tested).toBe(0);
    expect(r.stdout).toContain('Ancestor of tested SHA | yes');
  });

  it('4. a release tag that is an ancestor of main with several later commits reports the exact distance', async () => {
    // 4 commits; the release was cut at the FIRST one.
    const { root, shas } = makeFixture(4);
    freshHandlers(root, { tagTargets: { [TAG]: shas[0] } });
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(0);
    const snap = r.json();
    expect(snap.release.is_ancestor_of_tested).toBe(true);
    // The version-recording commit is also ahead of the release tag.
    expect(snap.release.commits_tested_ahead_of_release).toBe(shas.length - 1);
    expect(snap.release.commits_release_ahead_of_tested).toBe(0);
  });

  it('5. a release commit not found in the tested history is honestly UNPROVEN, never fabricated', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root, { tagTargets: { [TAG]: NOT_FOUND_SHA } });
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(0);
    const snap = r.json();
    expect(snap.release.is_ancestor_of_tested).toBeNull();
    expect(snap.release.provenance_note).toContain('not present in this checkout');
    expect(r.stdout).toContain('unproven');
  });

  it('6. fetches ALL pages of the open-PR inventory and reports the pagination facts', async () => {
    const { root } = makeFixture(1);
    const full = Array.from({ length: 100 }, (_, i) => pr(i + 1, `PR number ${i + 1}`));
    const rest = [pr(101, 'PR number 101'), pr(102, 'PR number 102'), pr(103, 'PR number 103')];
    freshHandlers(root, { pulls: (page) => (page === 1 ? full : rest) });
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(0);
    const snap = r.json();
    expect(snap.open_pull_requests.status).toBe('ok');
    expect(snap.open_pull_requests.count).toBe(103);
    expect(snap.open_pull_requests.pages_fetched).toBe(2);
    expect(snap.open_pull_requests.truncated).toBe(false);
    expect(snap.open_pull_requests.items).toHaveLength(103);
    const pullRequests = requestLog.filter((p) => p.includes('/pulls'));
    expect(pullRequests).toHaveLength(2);
    expect(r.stdout).toContain('**103 open**');
    expect(r.stdout).toContain('(2 API pages fetched)');
  });

  it('7. a failed PR API request never becomes an empty open-PR inventory (exit 3)', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root, { fail: { match: '/pulls', status: 500 } });
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(3);
    const snap = r.json();
    expect(snap.open_pull_requests.status).toBe('unavailable');
    expect(snap.open_pull_requests.count).toBeNull();
    expect(snap.open_pull_requests.items).toBeNull();
    expect(snap.unavailable_observations.some((u: { field: string; reason: string }) => u.field === 'open_pull_requests' && u.reason.includes('GitHub API 500'))).toBe(true);
    expect(r.stdout).toContain('**unavailable:');
    expect(r.stdout).not.toContain('**0 open**');
    expect(r.stderr).toContain('::error::');
    expect(r.stderr).toContain('open_pull_requests');
  });

  it('8. missing Actions results for the tested SHA are a real observation, not a failure', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root, { runs: [] });
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(0);
    const snap = r.json();
    expect(snap.ci.status).toBe('ok');
    expect(snap.ci.runs).toEqual([]);
    expect(snap.ci.aggregated_conclusion).toBe('none');
    expect(snap.ci.note).toContain('no workflow runs recorded');
    expect(r.stdout).toContain('**CI aggregate: none**');
  });

  it('9. a failed version check is a gate failure: exit 4 with an annotation', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root);
    const r = await runSnapshot(root, { args: ['--version-coherence', 'fail', '--version-coherence-rc', '1'] });
    expect(r.status).toBe(4);
    const snap = r.json();
    expect(snap.version_coherence.result).toBe('fail');
    expect(snap.version_coherence.exit_code).toBe(1);
    expect(r.stdout).toContain('| Version coherence');
    expect(r.stdout).toContain('| FAIL');
    expect(r.stderr).toContain('::error::');
    expect(r.stderr).toContain('gate FAILED');
  });

  it('10. a failed artifact audit is a gate failure with its hard-failure count', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root);
    const r = await runSnapshot(root, { args: ['--artifact-audit', JSON.stringify({ verdict: 'fail', verifier_exit_code: 2, hard_failures: 3, release_tag: TAG })] });
    expect(r.status).toBe(4);
    const snap = r.json();
    expect(snap.artifact_integrity_audit.verdict).toBe('fail');
    expect(snap.artifact_integrity_audit.hard_failures).toBe(3);
    expect(r.stdout).toContain('| Artifact integrity');
    expect(r.stdout).toContain('3 hard failure(s)');
    expect(r.stderr).toContain('::error::');
  });

  it('11a. malformed package.json becomes an unavailable REQUIRED observation (exit 3), not a crash', async () => {
    const { root, shas } = makeFixture(1);
    writeFileSync(join(root, 'package.json'), '{ "name": "fress", "version": trunc');
    freshHandlers(root);
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(3);
    const snap = r.json();
    expect(snap.source_version).toBeNull();
    expect(snap.unavailable_observations.some((u: { field: string }) => u.field === 'source_version')).toBe(true);
    expect(snap.tested.sha).toBe(shas[shas.length - 1]); // every other observation still made
  });

  it('11b. a non-string package.json version is malformed, not silently displayed', async () => {
    const { root } = makeFixture(1);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fress', version: 42 }));
    freshHandlers(root);
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(3);
    expect(r.json().unavailable_observations.some((u: { field: string; reason: string }) => u.field === 'source_version' && u.reason.includes('no string .version'))).toBe(true);
  });

  it('11c. an empty/partial artifact-audit verdict is unavailable-with-reason and never prints undefined', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root);
    const empty = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', '{}'] });
    expect(empty.status).toBe(3);
    const emptySnap = empty.json();
    expect(emptySnap.artifact_integrity_audit.verdict).toBe('unavailable');
    expect(emptySnap.artifact_integrity_audit.reason).toContain('verdict is missing');
    expect(emptySnap.unavailable_observations.some((u: { field: string }) => u.field === 'artifact_integrity_audit')).toBe(true);

    requestLog.length = 0;
    const partial = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', '{"verdict":"pass"}'] });
    expect(partial.status).toBe(0);
    const partialSnap = partial.json();
    expect(partialSnap.artifact_integrity_audit).toEqual({ verdict: 'pass', release_tag: null, verifier_exit_code: null, hard_failures: null });
    expect(partial.stdout).toContain('no detail');
    expect(partial.stdout).not.toContain('undefined');
    expect(JSON.stringify(partialSnap)).not.toContain('undefined');
  });

  it('11d. a nonsense --version-coherence value is unavailable-with-reason (fail closed), not a silent pass', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root);
    const r = await runSnapshot(root, { args: ['--version-coherence', 'PASS', '--version-coherence-rc', '0'] });
    expect(r.status).toBe(3);
    const snap = r.json();
    expect(snap.version_coherence.result).toBe('unavailable');
    expect(snap.version_coherence.note).toContain('must be pass or fail');
    expect(snap.unavailable_observations.some((u: { field: string }) => u.field === 'version_coherence')).toBe(true);
  });

  it('11e. a malformed workflow-runs payload is unavailable, never a silent zero-inventory', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root, { malformed: { match: '/actions/runs', body: { total_count: 2, workflow_runs: 'not-an-array' } } });
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(3);
    const snap = r.json();
    expect(snap.ci.status).toBe('unavailable');
    expect(snap.ci.reason).toContain('malformed response');
    expect(snap.unavailable_observations.some((u: { field: string; reason: string }) => u.field === 'ci_on_tested_sha' && u.reason.includes('malformed'))).toBe(true);
  });

  it('11f. a malformed releases payload cannot fake a release', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root, { malformed: { match: '/releases', body: { message: 'unexpected object' } } });
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(3);
    const snap = r.json();
    expect(snap.release.status).toBe('unavailable');
    expect(snap.release.reason).toContain('not an array');
  });

  it('12. exit codes stay distinct and annotated: 2 crash, 3 unavailable, 4 gate, 0 ok, --help 0', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root);

    // Crash path: the artifact cannot be written -> distinct exit 2 + annotation.
    const crash = await runSnapshot(root, { out: join(root, 'no-such-dir', 'snap.json'), args: ['--version-coherence', 'pass', '--version-coherence-rc', '0'] });
    expect(crash.status).toBe(2);
    expect(crash.stderr).toContain('::error::');
    expect(crash.stderr).toContain('could not be produced');

    // Usage/help path: exit 0 with the usage text.
    const help = await runSnapshot(root, { args: ['--help'], out: join(root, 'help-unused.json') });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('usage:');

    // 3 and 4 are the documented observation/gate codes (proved by tests 7/9/10);
    // a failing CI aggregate is a warning annotation without exit-code change (test 12b).
  });

  it('12b. a failing CI workflow shows up in the aggregate and gets a warning annotation without flipping the exit code', async () => {
    const { root, shas } = makeFixture(1);
    const head = shas[shas.length - 1];
    freshHandlers(root, {
      runs: [defaultRun(head, 'success'), { ...defaultRun(head, 'failure'), name: 'E2E', workflow_id: 7 }],
    });
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(0);
    const snap = r.json();
    expect(snap.ci.aggregated_conclusion).toBe('failing');
    expect(snap.ci.failing_workflows).toEqual(['E2E']);
    expect(r.stdout).toContain('**CI aggregate: FAILING**');
    expect(r.stdout).toContain('E2E');
    expect(r.stderr).toContain('::warning::');
  });

  it('12c. CI runs are queried strictly by the tested SHA and a pending run yields aggregate PENDING', async () => {
    const { root, shas } = makeFixture(1);
    const head = shas[shas.length - 1];
    freshHandlers(root, { runs: [defaultRun(head, null, 'in_progress')] });
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })] });
    expect(r.status).toBe(0);
    expect(r.json().ci.aggregated_conclusion).toBe('pending');
    expect(r.stdout).toContain('**CI aggregate: PENDING**');
    // The query must carry the exact tested SHA.
    expect(requestLog.some((p) => p.includes(`/actions/runs?head_sha=${head}`))).toBe(true);
  });

  it('12d. a GITHUB_SHA different from the actual checkout is recorded as event_sha (never mislabels tested.sha)', async () => {
    const { root, shas } = makeFixture(1);
    freshHandlers(root);
    const claimed = 'b'.repeat(40);
    const r = await runSnapshot(root, { args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })], env: { GITHUB_SHA: claimed, GITHUB_REF_NAME: 'main' } });
    expect(r.status).toBe(0);
    const snap = r.json();
    expect(snap.tested.sha).toBe(shas[shas.length - 1]);
    expect(snap.tested.event_sha).toBe(claimed);
    expect(snap.tested.note).toContain('GITHUB_SHA differed');
    expect(r.stdout).toContain('differs from the checked-out commit');
  });

  it('12e. without a token the API observations are unavailable (exit 3), each with an actionable reason', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root);
    const run = await runSnapshot(root, { noToken: true });
    expect(run.status).toBe(3);
    const snap = run.json();
    const fields = snap.unavailable_observations.map((u: { field: string }) => u.field);
    expect(fields).toContain('repository_metadata');
    expect(fields).toContain('default_branch_head');
    expect(fields).toContain('latest_published_release');
    expect(fields).toContain('open_pull_requests');
    expect(snap.unavailable_observations[0].reason).toContain('no read token');
  });

  // Brief case 14: a RED run must still publish its evidence. The workflow
  // attaches the JSON artifact with `if: always()` (pinned by the contract
  // test), and the script writes the step summary BEFORE it exits non-zero —
  // so the diagnosing reader gets the full picture even when the check fails.
  it('14a. a gate-failed run (exit 4) still writes the step summary AND the JSON artifact', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root);
    const summaryPath = join(root, 'step-summary.md');
    const r = await runSnapshot(root, {
      args: ['--version-coherence', 'fail', '--version-coherence-rc', '1'],
      env: { GITHUB_STEP_SUMMARY: summaryPath },
    });
    expect(r.status).toBe(4);
    // The JSON artifact exists and is parseable even though the run is red.
    const snap = r.json();
    expect(snap.version_coherence.result).toBe('fail');
    // The step summary was written to $GITHUB_STEP_SUMMARY (append mode) and
    // carries the sections a diagnostic reader needs.
    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain('# Fress integration snapshot');
    expect(summary).toContain('| Version coherence');
    expect(summary).toContain('| FAIL');
    expect(summary).toContain('## Known unavailable observations');
  });

  it('14b. an unavailable-observations run (exit 3) also retains its step summary', async () => {
    const { root } = makeFixture(1);
    freshHandlers(root, { fail: { match: '/pulls', status: 500 } });
    const summaryPath = join(root, 'step-summary-3.md');
    const r = await runSnapshot(root, {
      args: ['--version-coherence', 'pass', '--version-coherence-rc', '0', '--artifact-audit', JSON.stringify({ verdict: 'pass', verifier_exit_code: 0, hard_failures: 0, release_tag: TAG })],
      env: { GITHUB_STEP_SUMMARY: summaryPath },
    });
    expect(r.status).toBe(3);
    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain('**unavailable:');
    expect(summary).toContain('### Observations that could not be made this run');
    // The artifact is still there for the diagnosing reader.
    expect(r.json().open_pull_requests.status).toBe('unavailable');
  });
});
