#!/usr/bin/env python3
# Fress - a catalog of free and open-source software.
# Copyright (c) 2026 WasewaseX and Fress contributors
# SPDX-License-Identifier: MIT
"""Rejection-behavior tests for scripts/ci/verify-release-artifacts.py.

The release-artifact audit is the gate that keeps a corrupted or
mis-manifested release a private draft; these tests prove it actually
REJECTS every corruption class it claims to, using synthetic asset sets in
temporary directories and a dedicated test key generated with the module's
own Ed25519/minisign primitives. A real release is never touched, and no
test needs the production private key (which exists only as a GitHub
secret).

Run:  python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v
(the same command is a blocking step in ci.yml -> artifact-audit-tests)
"""
import base64
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "verify_release_artifacts", os.path.join(_HERE, "verify-release-artifacts.py")
)
V = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(V)

VERSION = "1.0.10-beta"
TAG = f"v{VERSION}"
REPO = "WasewaseX/Fress"

# ---- a dedicated test signing key (NEVER the production key) -------------
_TEST_KEYNUM = b"ci-test1"


def _scalar(seed: bytes) -> int:
    return int.from_bytes(hashlib.sha512(seed).digest(), "little") % (V.L - 1) + 1


_TEST_A = _scalar(b"fress ci artifact-audit test key")
_TEST_PK = V._compress(V._mul(V._B, _TEST_A))
TEST_PUBKEY_DOC = "untrusted comment: minisign public key (ci test)\n" + base64.b64encode(
    b"Ed" + _TEST_KEYNUM + _TEST_PK
).decode() + "\n"


def _sign(msg: bytes, scalar: int | None = None) -> str:
    """minisign Ed-mode signature over msg: Ed25519 over BLAKE2b-64(msg),
    exactly the recipe the verifier enforces. `scalar` overrides the test
    key's secret scalar (used to produce a WRONG-KEY signature)."""
    a = _TEST_A if scalar is None else scalar
    prehash = hashlib.blake2b(msg, digest_size=64).digest()
    r = _scalar(b"nonce:" + msg)
    big_r = V._compress(V._mul(V._B, r))
    k = int.from_bytes(hashlib.sha512(big_r + _TEST_PK + prehash).digest(), "little") % V.L
    s = (r + k * a) % V.L
    box = b"Ed" + _TEST_KEYNUM + big_r + s.to_bytes(32, "little")
    return (
        "untrusted comment: signature from ci test key\n"
        + base64.b64encode(box).decode()
        + "\ntrusted comment: timestamp:0000000000\tfile:fixture\n"
        + base64.b64encode(hashlib.blake2b(box, digest_size=32).digest()).decode()
        + "\n"
    )


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


SIGNED_ASSETS = {
    f"Fress_{VERSION}_x64-setup.exe": b"MZ fake nsis installer x64 " + b"A" * 256,
    f"Fress_{VERSION}_arm64-setup.exe": b"MZ fake nsis installer arm64 " + b"B" * 256,
    f"Fress_{VERSION}_amd64.AppImage": b"\x7fELF fake appimage " + b"C" * 256,
    f"Fress_{VERSION}_amd64.deb": b"!<arch> fake deb " + b"D" * 256,
}
UNSIGNED_ASSETS = {
    f"Fress_{VERSION}_x64.dmg": b"fake dmg " + b"E" * 128,
    f"Fress_{VERSION}_x64_en-US.msi": b"fake msi " + b"F" * 128,
    f"Fress_{VERSION}_x64-portable.zip": b"PK fake portable " + b"G" * 128,
    f"Fress_{VERSION}_universal.apk": b"PK fake apk " + b"H" * 128,
}


def _latest_json(sigs: dict, version: str = VERSION, tag: str = TAG) -> str:
    base = f"https://github.com/{REPO}/releases/download/{tag}"
    platforms = {
        "windows-x86_64": {
            "signature": sigs[f"Fress_{VERSION}_x64-setup.exe.sig"],
            "url": f"{base}/Fress_{VERSION}_x64-setup.exe",
        },
        "windows-aarch64": {
            "signature": sigs[f"Fress_{VERSION}_arm64-setup.exe.sig"],
            "url": f"{base}/Fress_{VERSION}_arm64-setup.exe",
        },
        "linux-x86_64": {
            "signature": sigs[f"Fress_{VERSION}_amd64.AppImage.sig"],
            "url": f"{base}/Fress_{VERSION}_amd64.AppImage",
        },
    }
    return json.dumps(
        {"version": version, "pub_date": "2026-10-12T00:00:00Z", "platforms": platforms},
        indent=2,
    )


class ArtifactAuditTestBase(unittest.TestCase):
    """Builds a complete, correct synthetic asset set; each test corrupts
    its own copy in an isolated temp dir."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fress-artifact-audit-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.dir = os.path.join(self.tmp, "assets")
        self.build()

    def build(self):
        os.makedirs(self.dir)
        blobs = dict(SIGNED_ASSETS)
        blobs.update(UNSIGNED_ASSETS)
        sigs = {}
        for name, blob in blobs.items():
            with open(os.path.join(self.dir, name), "wb") as f:
                f.write(blob)
            if name in SIGNED_ASSETS:
                sig = _sign(blob)
                sigs[name + ".sig"] = sig
                with open(os.path.join(self.dir, name + ".sig"), "w") as f:
                    f.write(sig)
        with open(os.path.join(self.dir, "latest.json"), "w") as f:
            f.write(_latest_json(sigs))
        # SHA256SUMS.txt over every asset except itself, sidecars included
        # (the release pipeline's checksums job runs after every upload),
        # deterministic order.
        names = sorted(blobs) + sorted(sigs) + ["latest.json"]
        lines = [f"{_sha256(open(os.path.join(self.dir, n), 'rb').read())}  {n}" for n in names]
        with open(os.path.join(self.dir, "SHA256SUMS.txt"), "w") as f:
            f.write("\n".join(lines) + "\n")

    def audit(self):
        return V.run_audit(self.dir, TAG, VERSION, REPO, TEST_PUBKEY_DOC)


class TestCorrectSetPasses(ArtifactAuditTestBase):
    def test_a_complete_correct_set_has_zero_hard_failures(self):
        failures, findings = self.audit()
        self.assertEqual(failures, [], f"correct set must pass, got: {failures}")
        # The honest matrix is informational, never a failure: unsigned
        # classes (dmg/msi/portable/apk) legitimately carry no sidecars.
        self.assertTrue(any("without sidecars" in f for f in findings))

    def test_signatures_verify_over_the_exact_bytes(self):
        # The audit prints per-sidecar verification; drive minisign_verify
        # directly once to prove the test key itself is sound (guards
        # against a broken test signer silently passing everything).
        blob = SIGNED_ASSETS[f"Fress_{VERSION}_x64-setup.exe"]
        ok, detail = V.minisign_verify(TEST_PUBKEY_DOC, _sign(blob), blob)
        self.assertTrue(ok, detail)


class TestCorruptionRejection(ArtifactAuditTestBase):
    def _failures(self):
        failures, _ = self.audit()
        return failures

    def test_one_byte_artifact_change_fails_checksum(self):
        target = f"Fress_{VERSION}_amd64.AppImage"
        path = os.path.join(self.dir, target)
        blob = bytearray(open(path, "rb").read())
        blob[10] ^= 0x01
        open(path, "wb").write(bytes(blob))
        failures = self._failures()
        self.assertTrue(any("hashes to" in f and "SHA256SUMS.txt says" in f for f in failures), failures)

    def test_missing_listed_asset_fails(self):
        os.remove(os.path.join(self.dir, f"Fress_{VERSION}_amd64.deb"))
        failures = self._failures()
        self.assertTrue(any("lists Fress_" in f and "not on the release" in f for f in failures), failures)

    def test_unlisted_asset_fails(self):
        with open(os.path.join(self.dir, f"Fress_{VERSION}_extra-tool.exe"), "wb") as f:
            f.write(b"stray asset")
        failures = self._failures()
        self.assertTrue(any("without a SHA256SUMS.txt entry" in f for f in failures), failures)

    def test_checksum_manifest_listing_itself_fails(self):
        path = os.path.join(self.dir, "SHA256SUMS.txt")
        body = open(path).read()
        open(path, "w").write(body + f"{_sha256(body.encode())}  SHA256SUMS.txt\n")
        failures = self._failures()
        self.assertTrue(any("lists itself" in f for f in failures), failures)

    def test_duplicated_checksum_mapping_fails(self):
        path = os.path.join(self.dir, "SHA256SUMS.txt")
        body = open(path).read()
        first = body.splitlines()[0]
        open(path, "w").write(body + first + "\n")
        failures = self._failures()
        self.assertTrue(any("more than once" in f for f in failures), failures)

    def test_manifest_version_for_another_tag_fails(self):
        path = os.path.join(self.dir, "latest.json")
        lj = json.load(open(path))
        lj["version"] = "9.9.9"
        json.dump(lj, open(path, "w"))
        failures = self._failures()
        self.assertTrue(any("version field" in f and "!= release version" in f for f in failures), failures)

    def test_manifest_url_for_another_tag_fails(self):
        path = os.path.join(self.dir, "latest.json")
        lj = json.load(open(path))
        lj["platforms"]["linux-x86_64"]["url"] = (
            f"https://github.com/{REPO}/releases/download/v9.9.9/Fress_{VERSION}_amd64.AppImage"
        )
        json.dump(lj, open(path, "w"))
        failures = self._failures()
        self.assertTrue(any("not this release's versioned download URL" in f for f in failures), failures)

    def test_manifest_referencing_nonexistent_asset_fails(self):
        path = os.path.join(self.dir, "latest.json")
        lj = json.load(open(path))
        lj["platforms"]["linux-x86_64"]["url"] = f"https://github.com/{REPO}/releases/download/{TAG}/Ghost_1.0.0.AppImage"
        json.dump(lj, open(path, "w"))
        failures = self._failures()
        self.assertTrue(any("references nonexistent asset Ghost_1.0.0.AppImage" in f for f in failures), failures)

    def test_altered_embedded_signature_fails(self):
        # latest.json's embedded signature must equal the sidecar bytes:
        # flipping one character of the embedded copy breaks the binding.
        path = os.path.join(self.dir, "latest.json")
        lj = json.load(open(path))
        sig = lj["platforms"]["linux-x86_64"]["signature"]
        flipped = ("A" if sig[30] != "A" else "B") + sig[31:]
        lj["platforms"]["linux-x86_64"]["signature"] = flipped
        json.dump(lj, open(path, "w"))
        failures = self._failures()
        self.assertTrue(any("embedded signature differs" in f for f in failures), failures)

    def test_sidecar_tampered_in_signature_bytes_fails_crypto(self):
        # Mutate the R point inside the sidecar's base64 box: the sidecar
        # still parses, but the cryptographic check must reject it.
        sidecar = os.path.join(self.dir, f"Fress_{VERSION}_amd64.AppImage.sig")
        lines = open(sidecar).read().splitlines()
        box = bytearray(base64.b64decode(lines[1]))
        box[12] ^= 0x01  # inside R
        lines[1] = base64.b64encode(bytes(box)).decode()
        open(sidecar, "w").write("\n".join(lines) + "\n")
        failures = self._failures()
        self.assertTrue(any("does NOT verify" in f for f in failures), failures)

    def test_wrong_key_sidecar_fails_crypto(self):
        # A signature from a DIFFERENT key (not the production key) must
        # never verify, even over untouched bytes.
        sidecar = os.path.join(self.dir, f"Fress_{VERSION}_x64-setup.exe.sig")
        other_scalar = _scalar(b"a completely different test key")
        open(sidecar, "w").write(_sign(SIGNED_ASSETS[f"Fress_{VERSION}_x64-setup.exe"], scalar=other_scalar))
        failures = self._failures()
        self.assertTrue(any("does NOT verify" in f for f in failures), failures)

    def test_stray_sidecar_on_unsigned_class_fails(self):
        blob = UNSIGNED_ASSETS[f"Fress_{VERSION}_x64.dmg"]
        with open(os.path.join(self.dir, f"Fress_{VERSION}_x64.dmg.sig"), "w") as f:
            f.write(_sign(blob))
        # ...and the sums/manifest stay consistent (the sidecar itself is
        # listed); the contract violation alone must fail the audit.
        path = os.path.join(self.dir, "SHA256SUMS.txt")
        body = open(path).read()
        sig_name = f"Fress_{VERSION}_x64.dmg.sig"
        entry = f"{_sha256(open(os.path.join(self.dir, sig_name), 'rb').read())}  {sig_name}"
        open(path, "w").write(body + entry + "\n")
        failures = self._failures()
        self.assertTrue(any("unsigned asset classes carry sidecars" in f for f in failures), failures)

    def test_checksum_value_edited_fails(self):
        # Brief case 4 ("incorrect entry"): the asset is intact, but one
        # SHA256SUMS.txt value was edited (stale manifest from before an
        # upload-replace). Both directions must catch it: the listed hash
        # no longer matches the only bytes on the release.
        path = os.path.join(self.dir, "SHA256SUMS.txt")
        body = open(path).read()
        target = f"Fress_{VERSION}_x64_en-US.msi"
        lines = body.splitlines()
        for i, line in enumerate(lines):
            if line.endswith("  " + target):
                digest = line.split(" ", 1)[0]
                lines[i] = line.replace(digest, "0" * 64, 1)
                break
        open(path, "w").write("\n".join(lines) + "\n")
        failures = self._failures()
        self.assertTrue(any(target in f and "SHA256SUMS.txt says" in f for f in failures), failures)

    def test_attacker_cannot_launder_tampered_sidecar_via_manifest(self):
        # Brief case 7 (full form): the attacker replaces an artifact with
        # malware, also rewrites the sidecar signature bytes AND updates
        # latest.json's embedded signature to match the new sidecar, and
        # fixes SHA256SUMS.txt for all three files. Every manifest is
        # self-consistent now - the ONLY thing standing is the
        # cryptographic check, because the attacker cannot sign with the
        # production key. The audit must still fail on the signature.
        exe = f"Fress_{VERSION}_x64-setup.exe"
        sig_name = exe + ".sig"
        # 1. malware instead of the installer
        malware = b"MZ evila " + b"X" * 256
        open(os.path.join(self.dir, exe), "wb").write(malware)
        # 2. re-sign with an ATTACKER key (not the test/production key)
        attacker_scalar = _scalar(b"the attacker's own key")
        forged_sig = _sign(malware, scalar=attacker_scalar)
        open(os.path.join(self.dir, sig_name), "w").write(forged_sig)
        # 3. manifest embedded signature = the new sidecar bytes
        lj = json.load(open(os.path.join(self.dir, "latest.json")))
        lj["platforms"]["windows-x86_64"]["signature"] = forged_sig
        json.dump(lj, open(os.path.join(self.dir, "latest.json"), "w"))
        # 4. checksums refreshed over the tampered set (both files changed)
        sums = os.path.join(self.dir, "SHA256SUMS.txt")
        lines = open(sums).read().splitlines()
        fixed = []
        for line in lines:
            name = line.split("  ", 1)[-1]
            if name in (exe, sig_name):
                line = _sha256(open(os.path.join(self.dir, name), "rb").read()) + "  " + name
            fixed.append(line)
        open(sums, "w").write("\n".join(fixed) + "\n")

        failures = self._failures()
        self.assertTrue(
            any(sig_name in f and "does NOT verify" in f and "production key" in f for f in failures),
            failures,
        )

    def test_cli_exit_status_nonzero_on_corruption(self):
        # Brief: "Test failure exit status, not merely an error log." Drives
        # the REAL CLI entry point (main(): selftest + production key load
        # + audit) against a corrupted fixture dir and proves the process
        # exits non-zero with the actionable annotation - the exact signal
        # release.yml's step failure (and therefore the blocked publish)
        # is built on.
        target = f"Fress_{VERSION}_amd64.deb"
        path = os.path.join(self.dir, target)
        blob = bytearray(open(path, "rb").read())
        blob[3] ^= 0xFF
        open(path, "wb").write(bytes(blob))
        script = os.path.join(_HERE, "verify-release-artifacts.py")
        proc = subprocess.run(
            [sys.executable, script, self.dir, TAG, VERSION, REPO],
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertNotEqual(proc.returncode, 0, "corrupted set must exit non-zero")
        combined = proc.stdout + proc.stderr
        self.assertIn("::error::final artifact audit FAILED", combined)
        self.assertIn(target, combined, "the failing asset must be named")
        # And the success-adjacent marker must be absent.
        self.assertNotIn("FINAL ARTIFACT AUDIT PASSED", combined)

    def test_orphan_sidecar_fails(self):
        with open(os.path.join(self.dir, "Ghost_1.0.0.AppImage.sig"), "w") as f:
            f.write(_sign(b"target that does not exist"))
        failures = self._failures()
        self.assertTrue(any("orphan sidecar Ghost_1.0.0.AppImage.sig" in f for f in failures), failures)

    def test_malformed_latest_json_fails_with_actionable_reason(self):
        open(os.path.join(self.dir, "latest.json"), "w").write("{not json at all")
        failures = self._failures()
        self.assertTrue(any("latest.json is not valid, unambiguous JSON" in f for f in failures), failures)

    def test_latest_json_wrong_types_fail_with_actionable_reason(self):
        open(os.path.join(self.dir, "latest.json"), "w").write('{"version": 7, "platforms": []}')
        failures = self._failures()
        self.assertTrue(any("'version' must be a string" in f for f in failures), failures)

    def test_duplicate_platform_key_in_latest_json_fails(self):
        # JSON with the same key twice parses to "last wins" by default;
        # the audit must refuse the ambiguity instead.
        raw = open(os.path.join(self.dir, "latest.json")).read()
        raw = raw.replace('"platforms": {', '"platforms": {\n    "windows-x86_64": {"signature": "x", "url": "u"},', 1)
        open(os.path.join(self.dir, "latest.json"), "w").write(raw)
        failures = self._failures()
        self.assertTrue(any("duplicate JSON key" in f for f in failures), failures)

    def test_platform_key_pointing_at_wrong_os_asset_fails(self):
        path = os.path.join(self.dir, "latest.json")
        lj = json.load(open(path))
        # windows-x86_64 advertised with the macOS bundle (cross-OS
        # misclassification: the updater would hand a darwin bundle to
        # Windows). The sidecar/signature are kept valid on purpose so the
        # classification check is what fires.
        dmg = f"Fress_{VERSION}_x64.dmg"
        lj["platforms"]["windows-x86_64"]["url"] = f"https://github.com/{REPO}/releases/download/{TAG}/{dmg}"
        json.dump(lj, open(path, "w"))
        failures = self._failures()
        self.assertTrue(
            any("does not match the windows updater classes" in f for f in failures),
            failures,
        )

    def test_missing_required_platform_fails(self):
        path = os.path.join(self.dir, "latest.json")
        lj = json.load(open(path))
        del lj["platforms"]["windows-aarch64"]
        json.dump(lj, open(path, "w"))
        failures = self._failures()
        self.assertTrue(any("lacks required platform windows-aarch64" in f for f in failures), failures)


if __name__ == "__main__":
    unittest.main()
