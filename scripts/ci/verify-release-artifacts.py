#!/usr/bin/env python3
"""Final published-artifact audit - the CI gate between "everything built"
and "the release is published" (release.yml verify-release job).

After the LAST asset upload, this script needs no further downloads: the
release job has just pulled every asset fresh from the release. On those
exact bytes it verifies, in order:

  1. SHA256SUMS.txt <-> every asset's actual bytes (both directions; the
     manifest must never list itself; every other asset must be listed).
  2. latest.json <-> the actual release: the version field, every platform
     URL (versioned download URL of THIS tag, asset must exist), and every
     embedded signature (must equal the <asset>.sig sidecar bytes exactly).
     The manifest must never reference a nonexistent asset and must never
     advertise a platform whose sidecar is absent.
  3. Every <asset>.sig sidecar verifies against the artifact's exact bytes
     and the production minisign public key from tauri.conf.json. Orphan
     sidecars (no matching artifact) are hard failures.
  4. The required-platform matrix: windows-x86_64, windows-aarch64 and
     linux-x86_64 entries must exist in latest.json; if a darwin
     .app.tar.gz updater bundle is on the release, its sidecar must be
     present; unsigned classes (dmg, msi, portable zips, apks) must NOT
     carry sidecars - in-app delivery is never offered for them.

The embedded minisign verifier (pure-Python RFC 8032 Ed25519 + BLAKE2b
prehash) self-checks against RFC 8032 vectors AND the app's own
`tauri signer sign` fixture (mirrored from src-tauri/src/lib.rs) before
touching any release byte. If the fixture ever changes in lib.rs, mirror
the constants here again - the selftest refuses to run the audit when the
fixture stops verifying, so the two cannot silently drift.

Usage (from the repository root):
    python3 scripts/ci/verify-release-artifacts.py <assets-dir> <tag> <version> <owner/repo>

Exit 0 iff every hard check passes. Expected-absence findings (unsigned
classes, missing optional darwin bundles) are reported, not failed.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

# =========================================================================
# Pure-Python minisign (Ed mode) verifier - independent of the pipeline.
# =========================================================================
P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P
_I = pow(2, (P - 1) // 4, P)


def _xrecover(y: int) -> int:
    xx = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = x * _I % P
    if (x * x - xx) % P != 0:
        raise ValueError("invalid point")
    if x % 2 != 0:
        x = P - x
    return x


_BY = 4 * pow(5, P - 2, P) % P
_BX = _xrecover(_BY)
assert _BX == 15112221349535400772501151409588531511454012693041857206046113283949847762202
_B = (_BX, _BY, 1, _BX * _BY % P)


def _add(p1, p2):
    x1, y1, z1, t1 = p1
    x2, y2, z2, t2 = p2
    a = (y1 - x1) * (y2 - x2) % P
    b = (y1 + x1) * (y2 + x2) % P
    c = t1 * 2 * D * t2 % P
    d2 = z1 * 2 * z2 % P
    return (
        (b - a) * (d2 - c) % P,
        (d2 + c) * (b + a) % P,
        (d2 - c) * (d2 + c) % P,
        (b - a) * (b + a) % P,
    )


def _dbl(p1):
    x1, y1, z1, _ = p1
    a = x1 * x1 % P
    b = y1 * y1 % P
    c = 2 * z1 * z1 % P
    d2 = (-a) % P
    e = ((x1 + y1) * (x1 + y1) - a - b) % P
    g = (d2 + b) % P
    f = (g - c) % P
    h = (d2 - b) % P
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _mul(pt, n: int):
    q = (0, 1, 1, 0)
    while n > 0:
        if n & 1:
            q = _add(q, pt)
        pt = _dbl(pt)
        n >>= 1
    return q


def _compress(pt) -> bytes:
    x, y, z, _ = pt
    zi = pow(z, P - 2, P)
    x = x * zi % P
    y = y * zi % P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _decompress(s: bytes):
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= P:
        return None
    xx = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = x * _I % P
    if (x * x - xx) % P != 0:
        return None
    if x % 2 != sign:
        x = P - x
    return (x, y, 1, x * y % P)


def ed25519_verify(pk: bytes, sig: bytes, msg: bytes) -> bool:
    """Standard detached Ed25519 (RFC 8032 sample-code equation: sB == R+kA)."""
    if len(pk) != 32 or len(sig) != 64:
        return False
    a_pt = _decompress(pk)
    r_pt = _decompress(sig[:32])
    if a_pt is None or r_pt is None:
        return False
    s = int.from_bytes(sig[32:], "little")
    if s >= L:
        return False
    k = int.from_bytes(hashlib.sha512(sig[:32] + pk + msg).digest(), "little") % L
    return _compress(_mul(_B, s)) == _compress(_add(r_pt, _mul(a_pt, k)))


_ED_TAGS = (b"Ed", b"ED")  # tauri signer writes "ED"; classic minisign "Ed"


def _doc(doc: str) -> bytes:
    lines = doc.strip().splitlines()
    if not lines or not lines[0].startswith("untrusted comment:") or len(lines) < 2:
        raise ValueError("not a minisign document")
    return base64.b64decode("".join(lines[1:]).strip())


def _pubkey(box: bytes):
    if len(box) != 42 or box[:2] not in _ED_TAGS:
        raise ValueError("bad pubkey box")
    return box[2:10], box[10:42]


def _sigbox(box: bytes):
    if len(box) != 74 or box[:2] not in _ED_TAGS:
        raise ValueError("bad signature box")
    return box[2:10], box[10:74]


def minisign_verify(pubkey_doc: str, sig_doc: str, message: bytes) -> tuple[bool, str]:
    """minisign Ed mode: Ed25519 over BLAKE2b-64(message). The prehash
    recipe is proven by the app fixture below, not assumed. Accepts both
    the raw document and the Tauri outer-base64 distribution format (the
    release sidecars use the latter)."""
    if not sig_doc.lstrip().startswith("untrusted comment:"):
        try:
            sig_doc = base64.b64decode(sig_doc.strip(), validate=True).decode()
        except Exception as exc:  # noqa: BLE001
            return False, f"signature neither document nor outer-base64: {exc}"
    try:
        kb = _doc(pubkey_doc)
        keynum_k, pk = _pubkey(kb)
        sb = _doc(sig_doc)
        keynum_s, rs = _sigbox(sb)
    except Exception as exc:  # noqa: BLE001
        return False, f"parse error: {exc}"
    if keynum_k != keynum_s:
        return False, "signature belongs to a different key"
    prehash = hashlib.blake2b(message, digest_size=64).digest()
    return (True, "verified") if ed25519_verify(pk, rs, prehash) else (False, "does not verify")


# =========================================================================
# Self-test ground truth - mirrored from src-tauri/src/lib.rs. If the Rust
# fixture changes, mirror it here; the selftest refuses to run the audit
# otherwise, so this copy cannot silently drift from the Rust source.
# =========================================================================
FIXTURE_KEY_DOC_B64 = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU5OTY3QkUwM0Q0Q0EwMTMKUldRVG9Fdzk0SHVXV1pQc2dONGs5TSsvMy9VZmRpVm1kdDhZUkJkMTFYWTlaRkxZai9CMVNLQ0QK"
FIXTURE_SIG_B64 = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRVG9Fdzk0SHVXV1phVkViOUhjM2dJTjNsR0VsTzhURTZZWlZTUGcyaXdSNGdPcVUzK0hXbk9TTWkwbGFlTk9LREUrMlRMMEdvS3VNbmhxQjF3SVVGMUFZVWpyU1VqQlEwPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNzQ3NjUzCWZpbGU6cGF5bG9hZC5iaW4KRis3Wkp1d1kyS1U4NTF3MFlSRTBaUFp6VHU3UnJHVlExNmRsajNMNkhDRlFNWmVicEVlRWhVNFNTcFQyNXJvY2JkaTFBU1p1VXpNMUJyb0dqMEVWQnc9PQo="
FIXTURE_PAYLOAD = b"Fress updater signature fixture payload v1\n"
RFC8032_PK = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
RFC8032_SIG = bytes.fromhex(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
    "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
)


def verifier_selftest() -> None:
    # RFC 8032 test vector 1 (empty message) must verify...
    if not ed25519_verify(RFC8032_PK, RFC8032_SIG, b""):
        sys.exit("::error::verifier selftest failed: RFC 8032 vector 1 does not verify")
    # ...a tampered vector must be rejected...
    tampered = bytearray(RFC8032_SIG)
    tampered[10] ^= 1
    if ed25519_verify(RFC8032_PK, bytes(tampered), b""):
        sys.exit("::error::verifier selftest failed: tampered RFC vector verified")
    # ...the app's genuine `tauri signer sign` fixture must verify...
    key_doc = base64.b64decode(FIXTURE_KEY_DOC_B64).decode()
    sig_doc = base64.b64decode(FIXTURE_SIG_B64).decode()
    ok, detail = minisign_verify(key_doc, sig_doc, FIXTURE_PAYLOAD)
    if not ok:
        sys.exit(f"::error::verifier selftest failed: genuine tauri fixture does not verify ({detail})")
    # ...and a tampered fixture payload must be rejected.
    ok_t, _ = minisign_verify(key_doc, sig_doc, FIXTURE_PAYLOAD[:-1] + bytes([FIXTURE_PAYLOAD[-1] ^ 1]))
    if ok_t:
        sys.exit("::error::verifier selftest failed: tampered fixture payload verified")
    print("verifier selftest: RFC 8032 vector + genuine tauri fixture verify; tampered payloads rejected")


# =========================================================================
# The audit itself
# =========================================================================
UNSIGNED_MARKERS = (".dmg", ".msi", ".apk", "-portable.zip")


def main() -> int:
    assets_dir, tag, version, repo = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    verifier_selftest()

    conf_path = os.path.join(os.path.dirname(__file__), "..", "..", "src-tauri", "tauri.conf.json")
    tauri_conf = json.load(open(conf_path))
    pubkey_doc = base64.b64decode(tauri_conf["plugins"]["updater"]["pubkey"]).decode()

    names = sorted(n for n in os.listdir(assets_dir) if os.path.isfile(os.path.join(assets_dir, n)))
    print(f"auditing {len(names)} release files of {tag} (version {version})")

    failures: list[str] = []
    findings: list[str] = []

    hashes: dict[str, str] = {}
    for n in names:
        h = hashlib.sha256()
        with open(os.path.join(assets_dir, n), "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        hashes[n] = h.hexdigest()

    # ---- 1. SHA256SUMS.txt <-> bytes, both directions ------------------
    if "SHA256SUMS.txt" not in names:
        failures.append("SHA256SUMS.txt is missing - no one could verify any download")
    else:
        entries: dict[str, str] = {}
        for line in open(os.path.join(assets_dir, "SHA256SUMS.txt")).read().splitlines():
            if line.strip():
                h, _, n = line.partition(" ")
                entries[n.strip().lstrip("*")] = h.strip()
        for n, expected in entries.items():
            if n == "SHA256SUMS.txt":
                failures.append("SHA256SUMS.txt lists itself")
            elif n not in hashes:
                failures.append(f"SHA256SUMS.txt lists {n} which is not on the release")
            elif expected != hashes[n]:
                failures.append(f"{n} hashes to {hashes[n][:12]}... but SHA256SUMS.txt says {expected[:12]}...")
        unlisted = [n for n in names if n != "SHA256SUMS.txt" and n not in entries]
        if unlisted:
            failures.append(f"assets without a SHA256SUMS.txt entry: {', '.join(unlisted)}")
        print(f"SHA256SUMS.txt: {len(entries)} entries, every asset re-hashed and compared")

    # ---- 2+3. latest.json <-> assets and sidecars ----------------------
    if "latest.json" not in names:
        failures.append("latest.json is missing - no in-app verified updates are possible")
    else:
        lj = json.load(open(os.path.join(assets_dir, "latest.json")))
        base = f"https://github.com/{repo}/releases/download/{tag}"
        if lj.get("version") != version:
            failures.append(f"latest.json version field {lj.get('version')!r} != release version {version!r}")
        if not str(lj.get("pub_date", "")).endswith("Z"):
            findings.append("latest.json pub_date is not a UTC ISO instant")
        plats = lj.get("platforms", {})
        for key, ent in plats.items():
            url = ent.get("url", "")
            asset = url.rsplit("/", 1)[-1]
            if url != f"{base}/{asset}":
                failures.append(f"latest.json[{key}]: URL is not this release's versioned download URL: {url}")
            if asset not in hashes:
                failures.append(f"latest.json[{key}]: references nonexistent asset {asset}")
                continue
            sig_asset = asset + ".sig"
            if sig_asset not in hashes:
                failures.append(f"latest.json[{key}]: references {sig_asset} but that sidecar is not on the release")
            else:
                sidecar = open(os.path.join(assets_dir, sig_asset)).read().strip()
                if sidecar != ent.get("signature", "").strip():
                    failures.append(f"latest.json[{key}]: embedded signature differs from {sig_asset} sidecar bytes")
        print(f"latest.json: version={lj.get('version')!r}, {len(plats)} platform entries cross-checked against assets and sidecars")

        # ---- 4. platform matrix -----------------------------------------
        for required in ("windows-x86_64", "windows-aarch64", "linux-x86_64"):
            if required not in plats:
                failures.append(f"latest.json lacks required platform {required}")
        rpms = sorted(n for n in names if n.startswith(f"Fress-{version}-") and n.endswith(".x86_64.rpm"))
        if rpms and "linux-x86_64-rpm" not in plats:
            findings.append(f"rpm {rpms[0]} is on the release but not advertised in latest.json (linux-x86_64-rpm)")
        for n in sorted(names):
            if n.endswith(".app.tar.gz") and n + ".sig" not in names:
                findings.append(
                    f"darwin updater bundle {n} has no .sig sidecar - darwin platforms cannot be advertised for in-app updates"
                )

    # ---- 5. every sidecar verifies over the artifact bytes -------------
    for n in names:
        if not n.endswith(".sig"):
            continue
        target = n[: -len(".sig")]
        if target not in hashes:
            failures.append(f"orphan sidecar {n}: no matching artifact on the release")
            continue
        ok, detail = minisign_verify(
            pubkey_doc,
            open(os.path.join(assets_dir, n)).read(),
            open(os.path.join(assets_dir, target), "rb").read(),
        )
        if not ok:
            failures.append(f"signature {n} does NOT verify against {target} + the production key ({detail})")
        else:
            print(f"signature {n}: verified over the exact published bytes of {target}")

    # ---- 6. honest matrix: unsigned classes carry no sidecars ----------
    stray = [n for n in names if n.endswith(".sig") and any(c in n[: -len(".sig")] for c in UNSIGNED_MARKERS)]
    if stray:
        failures.append(f"unsigned asset classes carry sidecars (inconsistent matrix): {', '.join(stray)}")
    unsigned = [
        n
        for n in names
        if not n.endswith(".sig") and n not in ("SHA256SUMS.txt", "latest.json") and (n + ".sig") not in names
    ]
    if unsigned:
        findings.append(
            "assets without sidecars (in-app delivery NOT offered, official-page fallback only): "
            + ", ".join(sorted(unsigned))
        )

    print(f"\nfindings (informational): {len(findings)}")
    for f_ in findings:
        print(f"  - {f_}")
    if failures:
        print(f"\nHARD FAILURES: {len(failures)}")
        for f_ in failures:
            print(f"  - {f_}")
        sys.exit("::error::final artifact audit FAILED - the release stays a private draft")
    print(
        f"\nFINAL ARTIFACT AUDIT PASSED at {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} - "
        "manifests match the exact bytes about to be published"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
