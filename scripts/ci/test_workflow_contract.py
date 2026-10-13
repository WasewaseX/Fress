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


if __name__ == "__main__":
    unittest.main()
