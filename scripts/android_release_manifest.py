#!/usr/bin/env python3
"""Read package/version from AGP release build output, not source Gradle files."""

from __future__ import annotations

import argparse
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ANDROID_NS = "http://schemas.android.com/apk/res/android"
EXPECTED_PACKAGE = "kr.verthill.caddy"
EXPECTED_VERSION_CODE = 6
EXPECTED_VERSION_NAME = "1.0.5"

# App-module AGP families only. Nested task folders change across AGP versions.
MANIFEST_FAMILIES = (
    ("packaged_manifests", 0),
    ("packaged_manifest", 0),
    ("bundle_manifest", 1),
    ("bundle_manifests", 1),
    ("merged_manifests", 2),
    ("merged_manifest", 2),
)


class ManifestError(RuntimeError):
    pass


def parse_manifest_identity(xml_text: str) -> dict[str, object]:
    root = ET.fromstring(xml_text)
    tag = root.tag.rsplit("}", 1)[-1]
    if tag != "manifest":
        raise ManifestError("root element is not manifest")

    package = root.get("package") or root.get(f"{{{ANDROID_NS}}}package")
    version_code = root.get(f"{{{ANDROID_NS}}}versionCode") or root.get("versionCode")
    version_name = root.get(f"{{{ANDROID_NS}}}versionName") or root.get("versionName")
    if not package or version_code is None or version_name is None:
        raise ManifestError("release manifest missing package/versionCode/versionName")
    try:
        code = int(version_code)
    except ValueError as exc:
        raise ManifestError("release manifest versionCode is not an integer") from exc
    return {
        "package": package,
        "versionCode": code,
        "versionName": str(version_name),
    }


def _is_release_variant(path: Path) -> bool:
    lowered = [part.lower() for part in path.parts]
    if "release" not in lowered:
        return False
    blocked = {
        "debug",
        "androidtest",
        "android_test",
        "unittests",
        "unit_test",
        "exploded-aar",
        "exploded_aar",
        "incremental",
        "src",
    }
    return not any(part in blocked for part in lowered)


def discover_agp_release_manifests(intermediates: Path) -> list[tuple[int, Path]]:
    found: list[tuple[int, Path]] = []
    if not intermediates.is_dir():
        return found
    for family, rank in MANIFEST_FAMILIES:
        root = intermediates / family
        if not root.is_dir():
            continue
        for manifest in root.rglob("AndroidManifest.xml"):
            if not _is_release_variant(manifest.relative_to(root)):
                continue
            found.append((rank, manifest))
    found.sort(key=lambda item: (item[0], str(item[1])))
    return found


def select_agp_release_manifest(intermediates: Path) -> tuple[Path, dict[str, object]]:
    discovered = discover_agp_release_manifests(intermediates)
    parsed: list[tuple[int, Path, dict[str, object]]] = []
    errors: list[str] = []
    for rank, path in discovered:
        try:
            identity = parse_manifest_identity(path.read_text(encoding="utf-8"))
        except (ManifestError, ET.ParseError, OSError) as exc:
            errors.append(f"{path}: {exc}")
            continue
        parsed.append((rank, path, identity))
    if not parsed:
        detail = f" ({'; '.join(errors)})" if errors else ""
        raise ManifestError(
            "no parseable AGP release merged/packaged manifest found" + detail
        )

    best_rank = parsed[0][0]
    top = [item for item in parsed if item[0] == best_rank]
    identities = {(item[2]["package"], item[2]["versionCode"], item[2]["versionName"]) for item in top}
    if len(identities) != 1:
        raise ManifestError("AGP release manifests disagree on package/version")
    _rank, path, identity = top[0]
    return path, identity


def find_bundletool() -> list[str] | None:
    from shutil import which

    exe = which("bundletool")
    if exe:
        return [exe]
    cache = Path.home() / ".gradle" / "caches" / "modules-2" / "files-2.1" / "com.android.tools.build" / "bundletool"
    jars = sorted(cache.rglob("bundletool-*.jar")) if cache.is_dir() else []
    if jars:
        return ["java", "-jar", str(jars[-1])]
    return None


def dump_aab_manifest(aab: Path) -> str:
    cmd = find_bundletool()
    if cmd is None:
        raise ManifestError("bundletool is not available to dump the AAB manifest")
    try:
        return subprocess.check_output(
            [*cmd, "dump", "manifest", "--bundle", str(aab)],
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ManifestError("bundletool dump manifest failed") from exc


def resolve_release_identity(
    intermediates: Path,
    aab: Path | None = None,
) -> tuple[str, Path | None, dict[str, object]]:
    try:
        path, identity = select_agp_release_manifest(intermediates)
        return "agp", path, identity
    except ManifestError as agp_error:
        if aab is None or not aab.is_file():
            raise ManifestError(
                f"{agp_error}; AAB bundletool fallback is unavailable"
            ) from agp_error
        identity = parse_manifest_identity(dump_aab_manifest(aab))
        return "bundletool", aab, identity


def verify_expected(
    identity: dict[str, object],
    package: str,
    version_code: int,
    version_name: str,
) -> None:
    if identity["package"] != package:
        raise ManifestError("release manifest package mismatch")
    if identity["versionCode"] != version_code:
        raise ManifestError("release manifest versionCode mismatch")
    if identity["versionName"] != version_name:
        raise ManifestError("release manifest versionName mismatch")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--intermediates", required=True)
    parser.add_argument("--aab")
    parser.add_argument("--expected-package", default=EXPECTED_PACKAGE)
    parser.add_argument("--expected-version-code", type=int, default=EXPECTED_VERSION_CODE)
    parser.add_argument("--expected-version-name", default=EXPECTED_VERSION_NAME)
    args = parser.parse_args(argv)

    intermediates = Path(args.intermediates)
    aab = Path(args.aab) if args.aab else None
    source, path, identity = resolve_release_identity(intermediates, aab)
    verify_expected(
        identity,
        args.expected_package,
        args.expected_version_code,
        args.expected_version_name,
    )
    location = path if path is not None else aab
    print(
        "Release manifest verification: PASS "
        f"source={source} path={location} "
        f"package={identity['package']} "
        f"versionCode={identity['versionCode']} "
        f"versionName={identity['versionName']}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ManifestError as exc:
        print(f"Release manifest verification: FAIL {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
