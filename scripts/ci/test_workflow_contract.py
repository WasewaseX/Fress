#!/usr/bin/env python3
# Fress - a catalog of free and open-source software.
# Copyright (c) 2026 WasewaseX and Fress contributors
# SPDX-License-Identifier: MIT
"""Workflow-contract tests: the publication boundary as executable checks.

The release-blocking properties that live in workflow STRUCTURE (which job
runs the authoritative version validator, which needs: edges make a failed
check block the build and the publish step) are otherwise only prose in
docs/quality-gates.md. These tests pin that structure: if a future edit
rewires the release path so that a version-coherence failure no longer
prevents publication, or the artifact audit no longer runs before the
draft is flipped, the suite fails in ordinary CI.

The parser is deliberately dependency-free (PyYAML is not guaranteed on
every runner image) and leans on this repository's own formatting: job
keys at exactly two spaces under `jobs:`. Any reformatting of the
workflows fails here loudly, and the map must then be updated
deliberately - which is the point of a contract test.

Run:  python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v
"""
import os
import re
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, "..", ".."))
_CI = os.path.join(_REPO, ".github", "workflows", "ci.yml")
_RELEASE = os.path.join(_REPO, ".github", "workflows", "release.yml")


def _jobs(path: str) -> dict:
    """Parse a workflow into {job_name: {"needs": [...], "body": str}}.
    Only the `jobs:` section is parsed; job keys are lines at exactly two
    spaces of indentation. needs: is parsed from the inline-list form this
    repository always uses."""
    text = open(path, encoding="utf-8").read()
    lines = text.splitlines()
    start = next(i for i, l in enumerate(lines) if l.rstrip() == "jobs:")
    jobs: dict[str, dict] = {}
    current = None
    header = re.compile(r"^  ([A-Za-z][A-Za-z0-9_-]*):\s*$")
    for line in lines[start + 1 :]:
        m = header.match(line)
        if m:
            current = m.group(1)
            jobs[current] = {"needs": [], "body": []}
        elif current is not None:
            jobs[current]["body"].append(line)
    for name, job in jobs.items():
        body = "\n".join(job["body"])
        inline = re.search(r"^\s*needs:\s*\[(.*?)\]\s*$", body, re.M)
        if inline:
            job["needs"] = [n.strip() for n in inline.group(1).split(",") if n.strip()]
        else:
            listed = re.findall(r"^\s+-\s+(\S+)\s*$", body, re.M)
            if listed:
                job["needs"] = listed
            else:
                scalar = re.search(r"^\s*needs:\s*([^\[\]#]+?)\s*$", body, re.M)
                if scalar:
                    job["needs"] = [scalar.group(1).strip()]
        job["body"] = body
    return jobs


def _code(body: str) -> str:
    """Job body with comment lines removed, so assertions judge the
    executed commands, not the documentation around them."""
    return "\n".join(l for l in body.splitlines() if not l.lstrip().startswith("#"))


class TestCiWorkflowContract(unittest.TestCase):
    """ci.yml: the version validator is a required check in development
    mode (no tag binding), and the verifier's rejection suite runs as its
    own blocking job."""

    def setUp(self):
        self.jobs = _jobs(_CI)
        self.text = open(_CI, encoding="utf-8").read()

    def test_version_guard_runs_the_one_validator_in_dev_mode(self):
        job = self.jobs.get("version-guard")
        self.assertIsNotNone(job, "ci.yml must keep the version-guard job")
        code = _code(job["body"])
        self.assertIn("npm run validate:versions", code)
        # Development mode: a newer source version than the latest
        # published release is legitimate, so the PR job must never pass a
        # tag to compare against.
        self.assertNotIn("--release-tag", code)

    def test_frontend_build_reruns_the_validator_before_the_build(self):
        job = self.jobs.get("frontend")
        self.assertIsNotNone(job)
        self.assertIn("npm run validate:versions", job["body"])
        self.assertLess(
            job["body"].index("npm run validate:versions"),
            job["body"].index("npm run build"),
            "version coherence must be checked before artifacts are built",
        )

    def test_verifier_rejection_suite_is_its_own_blocking_job(self):
        job = self.jobs.get("artifact-audit-tests")
        self.assertIsNotNone(job, "the verifier's tests need a dedicated CI job")
        self.assertIn("python3 -m unittest discover -s scripts/ci", job["body"])

    def test_no_continue_on_error_anywhere_in_ci(self):
        self.assertNotIn("continue-on-error", self.text)


class TestReleaseWorkflowContract(unittest.TestCase):
    """release.yml: tag mode binds the validator to the pushed tag, every
    build job is downstream of the version job, and the draft is published
    only after the artifact audit passes on the exact bytes."""

    def setUp(self):
        self.jobs = _jobs(_RELEASE)
        self.text = open(_RELEASE, encoding="utf-8").read()

    def test_version_job_binds_tag_on_tag_pushes_only(self):
        job = self.jobs.get("version")
        self.assertIsNotNone(job)
        body = job["body"]
        self.assertIn('npm run validate:versions -- --release-tag', body)
        self.assertIn('npm run validate:versions', body)
        self.assertIn('GITHUB_REF_TYPE', body, "tag binding must be conditional on an actual tag push")
        # The dev/dispatch branch must NOT bind a tag.
        self.assertLess(body.index("if [ \"${GITHUB_REF_TYPE:-branch}\" = \"tag\" ]; then"), body.index("--release-tag"))

    def test_every_build_job_is_downstream_of_the_version_job(self):
        builds = [n for n in self.jobs if n.startswith("build-")]
        self.assertGreaterEqual(len(builds), 5, "the six-platform build matrix must be present")
        for n in builds + ["create-release", "updater-manifest", "checksums"]:
            self.assertIn("version", self.jobs[n]["needs"], f"{n} must need the version job")

    def test_verify_release_needs_version_and_checksums_not_virustotal(self):
        needs = self.jobs["verify-release"]["needs"]
        self.assertIn("version", needs)
        self.assertIn("checksums", needs)
        # VirusTotal is an informational overlay: one transient VT API
        # error must never leave a verified release stuck as a draft.
        self.assertNotIn("virustotal", needs)

    def test_publish_happens_only_after_the_artifact_audit(self):
        code = _code(self.jobs["verify-release"]["body"])
        audit_at = code.find("verify-release-artifacts.py")
        publish_at = code.find("--draft=false")
        self.assertGreater(audit_at, -1, "verify-release must invoke the artifact auditor")
        self.assertGreater(publish_at, -1, "verify-release must contain the publish step")
        self.assertLess(audit_at, publish_at, "the audit must run BEFORE the draft is published")

    def test_verify_release_audits_freshly_downloaded_release_bytes(self):
        # The audit must judge the EXACT bytes uploaded to the release, never
        # a stale workspace copy: the job downloads the whole release fresh
        # (--clobber) at the start of every run, BEFORE the audit. This also
        # carries the retry contract: a transient download failure re-runs
        # the whole job (fresh bytes each time), while a hard integrity
        # verdict can never retry itself into a pass because the verdict is
        # recomputed from scratch on every run.
        code = _code(self.jobs["verify-release"]["body"])
        download_at = code.find("gh release download")
        clobber_at = code.find("--clobber")
        audit_at = code.find("verify-release-artifacts.py")
        self.assertGreater(download_at, -1, "verify-release must download the release assets it audits")
        self.assertGreater(clobber_at, -1, "the download must --clobber so no stale copy can survive a re-run")
        self.assertLess(download_at, clobber_at, "--clobber must belong to the download step")
        self.assertLess(clobber_at, audit_at, "the audit must run on the freshly downloaded bytes")

    def test_draft_flip_is_the_only_publication_switch(self):
        self.assertEqual(
            self.text.count("--draft=false"), 1,
            "exactly one place may publish the release",
        )
        publishers = [n for n, j in self.jobs.items() if "--draft=false" in j["body"]]
        self.assertEqual(publishers, ["verify-release"], "only verify-release may publish")

    def test_no_continue_on_error_anywhere_in_release(self):
        self.assertNotIn("continue-on-error", self.text)

    def test_the_one_validator_is_referenced_not_duplicated(self):
        # The rules must live in scripts/ci/validate-versions.ts only: the
        # workflow may invoke `npm run validate:versions`, but must not
        # grow inline rule copies (grep-for-version shells etc.).
        for path in (_CI, _RELEASE):
            body = open(path, encoding="utf-8").read()
            for legacy in ("validate-versions.mjs", "expect-tag"):
                self.assertNotIn(legacy, body, f"{path} must not reference the retired duplicate")

    def test_no_chinese_gate_runs_in_the_version_job_before_anything_is_built(self):
        # The no-Chinese gate is Agent 2's single source checker, invoked -
        # never re-implemented - by the release workflow, inside the FIRST
        # job so every build job (which all need the version job) runs after
        # the scan. The gate must fail closed when the checker is missing: a
        # release that could not be scanned must never publish silently.
        job = self.jobs.get("version")
        self.assertIsNotNone(job)
        code = _code(job["body"])
        self.assertIn("check-no-chinese.mjs", code)
        self.assertIn("node scripts/ci/check-no-chinese.mjs", code)
        missing_at = code.find("check-no-chinese.mjs is missing")
        self.assertGreater(missing_at, -1, "the gate must fail closed when the checker is absent")

    def test_prerelease_inference_uses_the_one_classifier_not_a_suffix_grep(self):
        # The GitHub prerelease flag decides whether a release is stable or
        # prerelease and which release-notes wording it gets. That decision
        # must come from the authoritative version grammar
        # (validate-versions.ts --is-prerelease), never from a second
        # hardcoded suffix list that can drift from the app's own parser.
        code = _code(self.jobs["version"]["body"])
        self.assertIn("--is-prerelease", code)
        self.assertNotIn(
            "grep -qiE 'beta|rc|alpha|dev'",
            code,
            "a suffix grep is a second grammar and must not decide release stability",
        )

    def test_tag_conflicting_state_is_refused_on_tag_pushes(self):
        # A tag that does not resolve to the exact commit being built is a
        # conflicting state (re-pointed tag, stale ref); the version job must
        # refuse it before anything is built, and only on tag pushes - a
        # workflow_dispatch run has no tag to compare.
        code = _code(self.jobs["version"]["body"])
        self.assertIn("github.ref_type == 'tag'", code)
        self.assertIn('refs/tags/${GITHUB_REF_NAME}^{commit}', code)
        self.assertIn("conflicting state", code)

    def test_release_notes_wording_is_channel_conditional(self):
        # A stable release must never carry prerelease wording and a
        # prerelease must never pose as stable: the notes line is an output
        # of the version job (channel_note), interpolated into the release
        # body - not a static line that contradicts one of the tracks.
        create_body = self.jobs["create-release"]["body"]
        self.assertIn("${{ needs.version.outputs.channel_note }}", create_body)
        self.assertNotIn(
            "Pre-release: features may change between releases.",
            create_body,
            "the static prerelease line must not be an unconditional release-notes literal",
        )

    # ------------------------------------------------------------------
    # v1.0.0 stable: gate hardening (agent3/b-gates). Each test pins one
    # property of the publication boundary listed in docs/quality-gates.md.

    def test_no_chinese_gate_step_fails_closed_on_every_failure_mode(self):
        # Three failure modes must all stop the release: the checker file is
        # missing, the checker rejects the tree (exit 1), or the scan cannot
        # run at all (exit 2 - node throws). None may be swallowed: the gate
        # step starts with set -euo pipefail, exits 1 on the missing checker,
        # and invokes the checker as a bare node command whose exit code
        # becomes the step's exit code (default bash -e + explicit errexit).
        code = _code(self.jobs["version"]["body"])
        gate_at = code.index("No-Chinese source gate")
        gate = code[gate_at : code.index("- id: v", gate_at)]
        self.assertIn(
            "set -euo pipefail", gate,
            "the no-Chinese gate must set errexit explicitly, not rely on the runner default",
        )
        self.assertIn("if [ ! -f scripts/ci/check-no-chinese.mjs ]; then", gate)
        self.assertIn("::error::scripts/ci/check-no-chinese.mjs is missing", gate)
        missing_at = gate.index("check-no-chinese.mjs is missing")
        self.assertGreater(gate.find("exit 1", missing_at), -1,
                           "a missing checker must exit nonzero, not print and continue")
        self.assertRegex(
            gate, r"(?m)^\s*node scripts/ci/check-no-chinese\.mjs\s*$",
            "the checker must be invoked bare (PR #79 contract) so its exit code decides",
        )
        for swallow in ("|| true", "|| :", "; true", "set +e", "2>/dev/null"):
            self.assertNotIn(swallow, gate, f"the gate must not swallow failures via {swallow!r}")

    def test_version_job_runs_both_gates_and_never_uploads_or_publishes(self):
        # The version job is the root of the release graph and carries both
        # gates (no-Chinese scan, version validation). It must contain no
        # upload, publish or build command of its own: everything it produces
        # is an output consumed by downstream jobs.
        code = _code(self.jobs["version"]["body"])
        gate_at = code.index("node scripts/ci/check-no-chinese.mjs")
        validator_at = code.index("npm run validate:versions")
        self.assertLess(
            gate_at, validator_at,
            "the no-Chinese scan must run before the version step finalizes the job outputs",
        )
        for forbidden in ("gh release", "--draft=false", "tauri build", "gh api -X PATCH"):
            self.assertNotIn(forbidden, code, f"the version job must not {forbidden}")

    def test_gate_steps_cannot_swallow_failures_anywhere(self):
        # No release step may neutralize a nonzero exit: `|| true` and its
        # variants would turn a red gate green at the exact point the release
        # depends on it.
        for pattern in ("|| true", "|| :", "&& true", "set +e"):
            self.assertNotIn(pattern, self.text)

    def test_prerelease_flag_is_derived_from_the_validator_and_consumed_as_an_expression(self):
        # The GitHub prerelease flag must be wired end to end from the one
        # authoritative classifier: validate-versions.ts --is-prerelease
        # writes the job output, and create-release consumes it as an
        # expression - never as a hardcoded true/false literal.
        version_code = _code(self.jobs["version"]["body"])
        derived_at = version_code.index(
            'PRERELEASE=$(npx tsx scripts/ci/validate-versions.ts --is-prerelease "$VERSION")'
        )
        output_at = version_code.index('echo "prerelease=$PRERELEASE" >> "$GITHUB_OUTPUT"')
        self.assertLess(derived_at, output_at,
                        "the prerelease output must be written from the validator's verdict")
        create_body = self.jobs["create-release"]["body"]
        self.assertIn("prerelease: ${{ needs.version.outputs.prerelease == 'true' }}", create_body)
        self.assertIsNone(
            re.search(r"(?m)^\s*prerelease:\s*(?:true|false)\s*$", create_body),
            "the GitHub prerelease flag must be the validator-derived expression, never a hardcoded literal",
        )

    def test_stable_channel_note_says_stable_without_prerelease_wording(self):
        # Both branches of the channel-conditional note must exist and each
        # must keep its own vocabulary: the prerelease branch carries the
        # "Pre-release:" line; the stable branch carries "**Stable release.**"
        # and must not borrow prerelease vocabulary that would contradict a
        # prerelease:false flag on the published release.
        code = _code(self.jobs["version"]["body"])
        self.assertIn('if [ "$PRERELEASE" = "true" ]; then', code)
        # Anchor on the PRERELEASE conditional itself: the version job also
        # has an if/else around GITHUB_REF_TYPE, which comes first.
        if_at = code.index('if [ "$PRERELEASE" = "true" ]; then')
        m_else = re.search(r"(?m)^\s*else\s*$", code[if_at:])
        self.assertIsNotNone(m_else, "the channel note must have a stable else-branch")
        else_at = if_at + m_else.start()
        else_end = if_at + m_else.end()
        m_fi = re.search(r"(?m)^\s*fi\s*$", code[else_end:])
        self.assertIsNotNone(m_fi, "the channel-note conditional must be closed")
        pre_branch = code[if_at:else_at]
        stable_branch = code[else_end:else_end + m_fi.start()]
        self.assertIn("Pre-release: features may change between releases.", pre_branch,
                      "the prerelease branch must keep its prerelease wording")
        self.assertIn("**Stable release.**", stable_branch,
                      "the stable branch must say stable in so many words")
        self.assertIsNone(
            re.search(r"pre.?release", stable_branch, re.I),
            "the stable release notes must contain no contradictory prerelease wording",
        )

    def test_static_release_body_carries_no_contradictory_channel_wording(self):
        # The only prerelease mention in create-release must be the flag
        # expression itself; the hand-written body template must be neutral
        # so the channel note alone decides the wording.
        code = _code(self.jobs["create-release"]["body"])
        mentions = [l for l in code.splitlines() if re.search(r"pre.?release", l, re.I)]
        self.assertEqual(
            len(mentions), 1,
            f"create-release must mention prerelease only on the flag line, got: {mentions}",
        )
        self.assertIn("prerelease: ${{", mentions[0])

    def test_draft_first_flow_creates_private_and_needs_every_build(self):
        # The release is born a draft (a failed build then leaves nothing
        # public), every build job uploads against the draft's release_id,
        # and only the verify job - after the artifact audit - flips the
        # draft (pinned elsewhere). A failed platform build, signing step or
        # audit therefore leaves the release a private draft forever.
        create_code = _code(self.jobs["create-release"]["body"])
        self.assertRegex(
            create_code, r"(?m)^\s*draft:\s*true\s*$",
            "the release must be created as a draft",
        )
        for n in ("build-windows", "build-windows-arm64", "build-linux",
                  "build-macos-arm", "build-macos-intel", "build-android",
                  "updater-manifest", "checksums"):
            self.assertIn("create-release", self.jobs[n]["needs"],
                          f"{n} must upload against the draft created by create-release")

    def test_tag_conflict_refusal_compares_candidate_sha_and_exits_nonzero(self):
        # On a tag push the version job re-resolves the pushed tag from the
        # remote and compares it against the checked-out candidate commit
        # (HEAD); a mismatch - a re-pointed or stale tag - must print an
        # error annotation and exit nonzero, before anything is built.
        code = _code(self.jobs["version"]["body"])
        conflict_at = code.index("Refuse a tag that exists in a conflicting state")
        step = code[conflict_at : code.index("No-Chinese source gate", conflict_at)]
        self.assertIn('git fetch --force origin "refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"', step)
        self.assertIn('git rev-parse "refs/tags/${GITHUB_REF_NAME}^{commit}"', step)
        self.assertIn("git rev-parse HEAD", step)
        mismatch_at = step.index('if [ "$TAGGED" != "$HEAD_SHA" ]; then')
        self.assertIn("::error::", step[mismatch_at:])
        self.assertGreater(step.find("exit 1", mismatch_at), -1,
                           "a conflicting tag must exit nonzero, never be built anyway")

    def test_workflow_never_pushes_deletes_or_repoints_a_tag(self):
        # Refusal is the only remedy for a conflicting tag: no step may push,
        # delete or rewrite any ref. The only remote ref operation in the
        # file is the read-only fetch used to RESOLVE the tag for comparison.
        for pattern, what in ((r"git\s+push", "push"),
                              (r"git\s+tag\s+(?:-d|--delete)", "delete a tag"),
                              (r"git\s+update-ref", "rewrite a ref"),
                              (r"git\s+replace", "replace an object")):
            self.assertIsNone(re.search(pattern, self.text),
                              f"release.yml must never {what}")

    def test_needs_graph_is_well_founded_and_acyclic(self):
        # Every needs: edge must point at a defined job and the graph must
        # be resolvable: a typo'd or cyclic needs list would silently change
        # what blocks publication.
        for name, job in self.jobs.items():
            for dep in job["needs"]:
                self.assertIn(dep, self.jobs, f"{name} needs unknown job {dep!r}")
        resolved = set()
        pending = set(self.jobs)
        while pending:
            ready = {n for n in pending if all(d in resolved for d in self.jobs[n]["needs"])}
            if not ready:
                self.fail(f"needs graph has a cycle or unresolvable edges: {sorted(pending)}")
            resolved |= ready
            pending -= ready

    def test_verify_release_transitively_depends_on_every_build_job(self):
        # The publish gate sits at the bottom of the whole graph: if any
        # build job could be bypassed on the path to verify-release, its
        # missing artifacts would surface as a published hole instead of a
        # skipped draft fill.
        seen = set()
        stack = ["verify-release"]
        while stack:
            cur = stack.pop()
            for dep in self.jobs[cur]["needs"]:
                if dep not in seen:
                    seen.add(dep)
                    stack.append(dep)
        for n in self.jobs:
            if n.startswith("build-"):
                self.assertIn(n, seen, f"verify-release must transitively depend on {n}")

    def test_release_workflow_contains_zero_chinese_characters(self):
        # The zero-Chinese rule (PR #79's checker) applies to the workflow
        # files too: the release pipeline itself must be free of Chinese/CJK
        # content so the tree-wide scan can stay zero-hit.
        cjk = re.compile(
            "[\u2e80-\u2eff\u2f00-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f"
            "\u3130-\u318f\u3190-\u319f\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff"
            "\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]"
        )
        m = cjk.search(self.text)
        if m:
            self.fail(f"Chinese/CJK content in release.yml at offset {m.start()}: {m.group(0)!r}")

    def test_checker_path_and_invocation_match_the_ci_agents_contract(self):
        # Cross-PR contract (PR #79): the ONE no-Chinese checker lives at
        # scripts/ci/check-no-chinese.mjs and is invoked bare - no flags, no
        # redirections - with its exit code deciding the step. The release
        # gate must use exactly that path and invocation so the PR gate and
        # the release gate judge the tree with the same command.
        code = _code(self.jobs["version"]["body"])
        self.assertIn("scripts/ci/check-no-chinese.mjs", code)
        for drift in ("check-no-chinese.js", "no-chinese.sh", "check_no_chinese"):
            self.assertNotIn(drift, code, f"checker path drifted from the PR #79 contract: {drift}")
        self.assertRegex(code, r"(?m)^\s*node scripts/ci/check-no-chinese\.mjs\s*$",
                         "the release gate must invoke the checker bare, exactly like the CI job")

    def test_stable_channel_note_is_version_agnostic_not_hardcoded(self):
        # Round-2 critique fix, restored after the r3 integration silently
        # reverted it: the stable migration instructions must interpolate
        # the release version. A hardcoded v1.0.0 would tell every FUTURE
        # stable release's users to download a v1.0.0 artifact that is not
        # the one this release shipped.
        code = _code(self.jobs["version"]["body"])
        self.assertIn("v$VERSION setup.exe", code)
        self.assertIn("v$VERSION bundle", code)
        self.assertNotIn("v1.0.0 setup.exe", code)
        self.assertNotIn("v1.0.0 bundle", code)

    def test_no_swallowed_failures_on_release_gates(self):
        # `|| true` turns any failing gate into a pass. The release path
        # has no legitimate use for it: every check must be allowed to
        # fail the job. (continue-on-error is pinned separately above.)
        self.assertNotIn("|| true", self.text)


_DIST_SCAN = "node scripts/ci/check-no-chinese.mjs --include-dist"
_DIST_SOURCE_SCAN = "node scripts/ci/check-no-chinese.mjs"

# Every release.yml job that builds the frontend (tauri-action and
# `tauri android build` both run beforeBuildCommand = npm run build ->
# vite build -> dist/) and uploads release artifacts, mapped to
# (last-frontend-build anchor, first job-owned upload anchor or None when
# all of the job's uploads happen inside tauri-action's own step).
_DIST_JOB_ANCHORS = {
    "build-windows": (
        "npx tauri build --target x86_64-pc-windows-msvc --bundles msi",
        "gh release upload",
    ),
    "build-windows-arm64": (
        "--target aarch64-pc-windows-msvc --bundles nsis",
        "gh release upload",
    ),
    "build-linux": ("--bundles appimage deb rpm", None),
    "build-macos-arm": ("--target aarch64-apple-darwin --bundles dmg", None),
    "build-macos-intel": ("--target x86_64-apple-darwin --bundles dmg", None),
    "build-android": ("npx tauri android build", "gh release upload"),
}


class TestNoChineseDistGateContract(unittest.TestCase):
    """release.yml x Agent 2's checker (scripts/ci/check-no-chinese.mjs,
    PR #79): the workflow invokes the one checker - never re-implements it -
    in exactly two passes: a source-only pre-build gate in the version job,
    and a post-build --include-dist pass in EVERY job that builds the
    frontend and uploads artifacts. The dist pass must run after the build
    that produces dist/ and before the job's own uploads, and must fail
    closed on a missing dist/ (the checker only warns there), on a checker
    crash (exit 2) and on any hit (exit 1)."""

    def setUp(self):
        self.jobs = _jobs(_RELEASE)
        self.text = open(_RELEASE, encoding="utf-8").read()
        self.code = {name: _code(job["body"]) for name, job in self.jobs.items()}

    def test_every_frontend_building_upload_job_has_the_dist_scan(self):
        # Discover the frontend-building jobs structurally (the bundler
        # actions that run beforeBuildCommand), so a NEW build job added
        # later without the dist gate fails here instead of shipping
        # unscanned dist/ bytes.
        builders = {
            name
            for name, code in self.code.items()
            if "tauri-apps/tauri-action" in code or "tauri android build" in code
        }
        self.assertEqual(
            builders,
            set(_DIST_JOB_ANCHORS),
            "the set of frontend-building jobs changed; wire the post-build "
            "--include-dist pass into every new builder and update "
            "_DIST_JOB_ANCHORS",
        )
        for name in _DIST_JOB_ANCHORS:
            self.assertEqual(
                self.code[name].count(_DIST_SCAN),
                1,
                f"{name} must run the post-build dist scan exactly once",
            )

    def test_dist_scan_runs_after_the_build_and_before_job_owned_uploads(self):
        for name, (build_anchor, upload_anchor) in _DIST_JOB_ANCHORS.items():
            code = self.code[name]
            scan_at = code.index(_DIST_SCAN)
            self.assertGreater(
                scan_at,
                code.rindex(build_anchor),
                f"{name}: the dist scan must run AFTER the job's last "
                f"frontend build (anchor: {build_anchor}) - the checker only "
                "warns when dist/ is missing, so a scan placed before the "
                "build would be a false guarantee",
            )
            if upload_anchor:
                self.assertLess(
                    scan_at,
                    code.index(upload_anchor),
                    f"{name}: the dist scan must run BEFORE the first "
                    f"job-owned upload (anchor: {upload_anchor})",
                )
            else:
                # Every upload in this job happens inside tauri-action's own
                # build step and cannot be interleaved; enforcement there is
                # the needs-chain (failed scan -> failed job -> checksums and
                # verify-release never run -> the draft can never publish).
                # Pin that no separate upload step is smuggled in either.
                self.assertNotIn(
                    "gh release upload",
                    code,
                    f"{name} grew a job-owned upload step; the dist scan "
                    "must then be ordered before it",
                )

    def test_pre_build_gate_stays_source_only(self):
        # The hard rule: --include-dist must never run before a build
        # exists. The version job's pre-build gate is source-only; no
        # non-build job may grow a --include-dist pass either.
        version = self.code["version"]
        self.assertIn(_DIST_SOURCE_SCAN, version)
        self.assertNotIn(
            "--include-dist",
            version,
            "the pre-build gate must stay source-only: dist/ does not exist "
            "before the build and the checker only warns about that, so a "
            "pre-build --include-dist pass would be a false guarantee",
        )
        for name in (
            "create-release",
            "updater-manifest",
            "checksums",
            "verify-release",
            "virustotal",
        ):
            self.assertNotIn(
                "--include-dist",
                self.code[name],
                f"{name} builds no frontend; --include-dist is meaningless there",
            )

    def test_dist_scan_fails_closed(self):
        # Three failure paths, all of which must fail the job: a missing
        # dist/ (the checker only emits a warning for that - the workflow
        # guard turns it into an error BEFORE the scan is even attempted),
        # a checker crash (exit 2 propagates under set -euo pipefail) and
        # any hit (exit 1).
        for name in _DIST_JOB_ANCHORS:
            code = self.code[name]
            guard_at = code.find("[ ! -d dist ]")
            self.assertGreater(
                guard_at,
                -1,
                f"{name}: the dist pass must fail closed when dist/ is missing",
            )
            exit_at = code.find("exit 1", guard_at)
            self.assertGreater(
                exit_at,
                -1,
                f"{name}: the missing-dist guard must exit nonzero",
            )
            self.assertLess(
                exit_at,
                code.index(_DIST_SCAN),
                f"{name}: the missing-dist guard must fire before the scan "
                "invocation",
            )
            self.assertIn(
                "set -euo pipefail",
                code,
                f"{name}: the dist pass must run under set -euo pipefail so a "
                "checker crash cannot pass silently",
            )

    def test_dist_scan_uses_the_ci_agents_documented_flag(self):
        # The checker's usage header documents exactly one spelling:
        # --include-dist. The workflow must invoke the checker with that
        # exact spelling - no variant that a refactor might introduce and
        # the checker would silently treat as an unknown argument.
        for name in _DIST_JOB_ANCHORS:
            self.assertIn(_DIST_SCAN, self.code[name])
        self.assertNotIn("--include_dist", self.text)
        self.assertNotIn("--includedist", self.text)
        self.assertNotIn("--includeDist", self.text)


if __name__ == "__main__":
    unittest.main()
