#!/usr/bin/env python3
# Fress - a catalog of free and open-source software.
# Copyright (c) 2026 WasewaseX and Fress contributors
# SPDX-License-Identifier: MIT
"""Integration-snapshot workflow contract tests.

docs/quality-gates.md promises specific properties of the public
integration snapshot: that it is READ-ONLY, that a failed artifact audit
still hands its verdict to the snapshot (so the public summary shows
FAIL instead of silently skipping), that gate verdicts come from the
authoritative implementations (the real verifier and the real version
validator, never a YAML re-implementation), and that no step can push
generated output back into the repository. This suite pins those
properties as executable checks on `.github/workflows/integration-snapshot.yml`.

Run:  python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v
"""
import os
import re
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, "..", ".."))
_SNAPSHOT = os.path.join(_REPO, ".github", "workflows", "integration-snapshot.yml")


def _jobs(path: str) -> dict:
    """Parse a workflow into {job_name: {"needs": [...], "if": str|None, "body": str}}.
    Same deliberately dependency-free parser convention as
    test_workflow_contract.py: job keys at exactly two spaces under `jobs:`."""
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
            jobs[current] = {"needs": [], "if": None, "body": []}
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
        ifmatch = re.search(r"^\s*if:\s*(.+?)\s*$", body, re.M)
        job["if"] = ifmatch.group(1) if ifmatch else None
        job["body"] = body
    return jobs


def _code(body: str) -> str:
    """Job body without comment lines: assertions judge executed commands."""
    return "\n".join(l for l in body.splitlines() if not l.lstrip().startswith("#"))


class TestIntegrationSnapshotWorkflowContract(unittest.TestCase):
    """integration-snapshot.yml: read-only evidence pipeline with honest
    failure semantics."""

    def setUp(self):
        self.path = _SNAPSHOT
        self.text = open(self.path, encoding="utf-8").read()
        self.jobs = _jobs(self.path)

    # -- triggers and permissions ------------------------------------------

    def test_triggers_cover_push_schedule_and_dispatch(self):
        self.assertIn("push:", self.text)
        self.assertIn("branches: [main]", self.text)
        self.assertIn("schedule:", self.text)
        self.assertIn("cron:", self.text)
        self.assertIn("workflow_dispatch:", self.text)

    def test_permissions_are_exactly_the_least_privilege_read_set(self):
        block = re.search(r"^permissions:\n((?:  .+\n)+)", self.text, re.M)
        self.assertIsNotNone(block, "the workflow must declare explicit permissions")
        perms = dict(re.findall(r"^\s+(\w[\w-]*):\s*(\w+)\s*$", block.group(1), re.M))
        self.assertEqual(
            perms,
            {"contents": "read", "pull-requests": "read", "actions": "read"},
            "the snapshot token must stay read-only; widen only with a recorded decision",
        )

    def test_every_action_is_pinned_to_a_commit_sha(self):
        for ref in re.findall(r"^\s*uses:\s*(\S+)", self.text, re.M):
            self.assertRegex(
                ref,
                r"^[^@]+@[0-9a-f]{40}",
                f"action {ref} must be pinned to a full commit SHA (supply-chain rule)",
            )

    # -- read-only guarantee -------------------------------------------------

    def test_no_step_can_mutate_the_repository_or_releases(self):
        code = "\n".join(_code(j["body"]) for j in self.jobs.values())
        for forbidden in (
            "git push",
            "git commit",
            "gh release edit",
            "gh release create",
            "gh release upload",
            "gh release delete",
            "--draft=false",
            "gh pr merge",
            "gh api -X POST",
            "gh api --method POST",
            "gh api -X PUT",
            "gh api --method PUT",
        ):
            self.assertNotIn(forbidden, code, f"the snapshot must never mutate state: found {forbidden!r}")

    def test_no_third_party_secrets_are_referenced(self):
        secrets = set(re.findall(r"secrets\.([A-Za-z_]+)", self.text))
        self.assertEqual(secrets, {"GITHUB_TOKEN"}, f"only the workflow's own GITHUB_TOKEN may be used, found {secrets}")

    def test_no_unbounded_retry_loops(self):
        code = "\n".join(_code(j["body"]) for j in self.jobs.values())
        self.assertNotIn("while true", code)
        self.assertNotIn("while :", code)
        # The documented bounded download retry must stay bounded.
        for m in re.finditer(r"for attempt in (\d+) (\d+)", code):
            self.assertLessEqual(int(m.group(2)), 5, "retries must stay bounded and small")

    # -- failure semantics ---------------------------------------------------

    def test_snapshot_job_runs_even_when_the_audit_fails_and_declares_the_dependency(self):
        self.assertIn("artifact-audit", self.jobs)
        self.assertEqual(self.jobs["snapshot"]["needs"], ["artifact-audit"])
        self.assertIsNotNone(self.jobs["snapshot"]["if"], "snapshot must declare if: always()")
        self.assertIn("always()", self.jobs["snapshot"]["if"])

    def test_a_failed_audit_still_hands_its_verdict_to_the_snapshot(self):
        audit = self.jobs["artifact-audit"]["body"]
        self.assertRegex(audit, r"if:\s*always\(\)\n\s+id: verdict", "the verdict export step must run even on failure")
        self.assertIn("audit-result.json", audit)
        # The raw log + verdict JSON are retained for diagnostics.
        upload = re.search(r"name: Keep the raw audit log.*?(?=\n      - |\Z)", audit, re.S)
        self.assertIsNotNone(upload, "the audit log must be retained as an artifact")
        self.assertIn("if: always()", upload.group(0))

    def test_snapshot_outputs_are_attached_even_on_red_runs(self):
        body = self.jobs["snapshot"]["body"]
        upload = re.search(r"name: Attach the machine-readable snapshot.*?(?=\Z)", body, re.S)
        self.assertIsNotNone(upload)
        self.assertIn("if: always()", upload.group(0))

    # -- authoritative implementations, never re-implemented -----------------

    def test_artifact_audit_runs_the_real_verifier(self):
        code = _code(self.jobs["artifact-audit"]["body"])
        self.assertIn("scripts/ci/verify-release-artifacts.py", code)
        self.assertIn("gh release download", code, "the audit must fetch the exact uploaded bytes")

    def test_version_coherence_comes_from_the_one_validator(self):
        code = _code(self.jobs["snapshot"]["body"])
        self.assertIn("npm run validate:versions", code)
        # No inline rule re-implementations in YAML.
        for legacy in ("grep -o", "jq -r .version", "package.json | grep", "validate-versions.mjs", "expect-tag"):
            self.assertNotIn(legacy, code, f"version rules must live in the validator, not in YAML ({legacy!r})")

    def test_snapshot_script_receives_both_gate_verdicts(self):
        code = _code(self.jobs["snapshot"]["body"])
        self.assertIn("integration-snapshot.mjs", code)
        self.assertIn("--version-coherence", code)
        self.assertIn("--artifact-audit", code)
        self.assertIn("needs.artifact-audit.outputs", code, "the audit verdict must travel through the job output")


if __name__ == "__main__":
    unittest.main()
