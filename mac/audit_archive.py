"""Check the shipped ZIP independently and compare its runtime to local sources."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import posixpath
import stat
import struct
import zipfile


def audit(root: Path, application_tests: int, archive_path: Path | None = None) -> dict:
    archive_path = archive_path or root / "dist" / "Charliflix-Apple-Silicon.zip"
    package = json.loads((root / "package.json").read_text())
    bundle = "Charliflix.app/"
    payload = bundle + "Contents/Resources/app/"
    with zipfile.ZipFile(archive_path) as archive:
        entries = {entry.filename.rstrip("/"): entry for entry in archive.infolist()}
        links = {name: archive.read(entry).decode() for name, entry in entries.items() if stat.S_ISLNK(entry.external_attr >> 16)}

        def resolve(name: str) -> str:
            name = posixpath.normpath(name)
            for _ in range(32):
                parts = name.split("/")
                for end in range(1, len(parts) + 1):
                    prefix = "/".join(parts[:end])
                    if prefix in links:
                        name = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), links[prefix], *parts[end:]))
                        if not name.startswith(bundle):
                            raise ValueError("A framework symlink escapes the app")
                        break
                else:
                    return name
            raise ValueError("A framework symlink contains a cycle")

        for name in links:
            if resolve(name) not in entries:
                raise ValueError(f"Unresolved framework symlink: {name}")
        if archive.testzip() is not None:
            raise ValueError("ZIP CRC verification failed")
        packaged_package = json.loads(archive.read(payload + "package.json"))
        packaged_version = packaged_package["version"]
        bundle_info = plistlib.loads(archive.read(bundle + "Contents/Info.plist"))
        if packaged_version != package["version"] or bundle_info["CFBundleShortVersionString"] != package["version"] or bundle_info["CFBundleVersion"] != package["version"]:
            raise ValueError("Archive version differs from package.json")
        if packaged_package["dependencies"] != package["dependencies"] or packaged_package["name"] != package["name"]:
            raise ValueError("Archive runtime metadata differs from package.json")

        source_hashes = {}
        source_files = [root / "server.cjs", root / "mac" / "main.cjs", root / "mac" / "runtime.cjs", root / "mac" / "preload.cjs", root / "mac" / "updates.cjs", root / "config" / "channels.json"]
        if (root / "LICENSE").is_file():
            source_files.append(root / "LICENSE")
        source_files.extend((root / "lib").glob("*.cjs"))
        source_files.extend(root / "public" / name for name in ("app.js", "styles.css", "index.html", "favicon.svg"))
        source_files.extend(root / "node_modules" / dependency / name for dependency in ("hls.js", "pngjs") for name in ("LICENSE", "package.json"))
        source_files.append(root / "node_modules" / "hls.js" / "dist" / "hls.min.js")
        source_files.extend((root / "node_modules" / "pngjs" / "lib").glob("*.js"))
        expected_payload = {payload + source.relative_to(root).as_posix() for source in source_files} | {payload + "package.json"}
        actual_payload = {name for name, entry in entries.items() if name.startswith(payload) and not entry.is_dir()}
        if actual_payload != expected_payload:
            raise ValueError("Unexpected files in the application payload")
        for source in sorted(source_files):
            relative = source.relative_to(root).as_posix()
            local = source.read_bytes()
            if archive.read(payload + relative) != local:
                raise ValueError(f"Packaged runtime differs from current source: {relative}")
            source_hashes[relative] = hashlib.sha256(local).hexdigest()
        if archive.read("Read Me.txt") != (root / "mac" / "Read Me.txt").read_bytes():
            raise ValueError("Packaged instructions differ from current instructions")

        external_slots = {}
        executable_names = 0
        for name in entries:
            if not name.endswith("/Info.plist") or name in links:
                continue
            info_bytes = archive.read(name)
            info = plistlib.loads(info_bytes)
            executable = info.get("CFBundleExecutable")
            parent = posixpath.dirname(name)
            if not executable:
                continue
            if parent.endswith("/Contents"):
                binary = parent + "/MacOS/" + executable
                executable_names += 1
            elif parent.endswith("/Resources"):
                binary = posixpath.dirname(parent) + "/" + executable
            else:
                continue
            binary = resolve(binary)
            if binary not in entries:
                raise ValueError(f"Bundle executable does not exist: {binary}")
            seal = resolve(posixpath.dirname(binary) + "/_CodeSignature/CodeResources") if not parent.endswith("/Contents") else parent + "/_CodeSignature/CodeResources"
            external_slots[binary] = {1: info_bytes, 3: archive.read(seal)}

        page_checks = special_checks = 0
        cdhashes = {}
        for name, entry in entries.items():
            if entry.is_dir() or name in links:
                continue
            with archive.open(entry) as stream:
                if stream.read(4) != b"\xcf\xfa\xed\xfe":
                    continue
            raw = archive.read(entry)
            header = struct.unpack_from("<IiiIIIII", raw)
            if header[1] != 0x0100000C or stat.S_IMODE(entry.external_attr >> 16) != 0o755:
                raise ValueError(f"Incorrect architecture or executable permissions: {name}")
            command_offset = 32
            signature_offset = None
            for _ in range(header[4]):
                command, size = struct.unpack_from("<II", raw, command_offset)
                if command == 0x1D:
                    signature_offset, signature_size = struct.unpack_from("<II", raw, command_offset + 8)
                command_offset += size
            if signature_offset is None:
                raise ValueError(f"Unsigned Mach-O: {name}")
            signature = raw[signature_offset:signature_offset + signature_size]
            magic, length, count = struct.unpack_from(">III", signature)
            if magic != 0xFADE0CC0 or length > len(signature):
                raise ValueError(f"Malformed signature: {name}")
            blobs = {}
            for index in range(count):
                kind, offset = struct.unpack_from(">II", signature, 12 + index * 8)
                blob_length = struct.unpack_from(">I", signature, offset + 4)[0]
                blobs[kind] = signature[offset:offset + blob_length]
            for kind, directory in blobs.items():
                if kind != 0 and not 0x1000 <= kind <= 0x1005:
                    continue
                magic, _, version, flags, hash_offset, _, specials, pages, limit = struct.unpack_from(">9I", directory)
                size, algorithm_id, _, page_log = struct.unpack_from("4B", directory, 36)
                if version >= 0x20300:
                    limit = struct.unpack_from(">Q", directory, 56)[0] or limit
                algorithm = {1: "sha1", 2: "sha256", 3: "sha256", 4: "sha384"}[algorithm_id]
                if magic != 0xFADE0C02 or not flags & 2 or limit != signature_offset:
                    raise ValueError(f"Invalid ad-hoc CodeDirectory: {name}")
                page_size = (1 << page_log) if page_log else max(limit, 1)
                if pages != (limit + page_size - 1) // page_size:
                    raise ValueError(f"Incomplete code-page coverage: {name}")
                for page in range(pages):
                    actual = hashlib.new(algorithm, raw[page * page_size:min((page + 1) * page_size, limit)]).digest()[:size]
                    if actual != directory[hash_offset + page * size:hash_offset + (page + 1) * size]:
                        raise ValueError(f"Code page hash mismatch: {name}")
                    page_checks += 1
                for slot in range(1, specials + 1):
                    content = external_slots.get(name, {}).get(slot) if slot in (1, 3) else blobs.get(slot)
                    actual = hashlib.new(algorithm, content).digest()[:size] if content is not None else bytes(size)
                    if actual != directory[hash_offset - slot * size:hash_offset - (slot - 1) * size]:
                        raise ValueError(f"Special-slot hash mismatch: {name}")
                    special_checks += 1
                if kind == 0:
                    cdhashes[name] = hashlib.new(algorithm, directory).digest()[:20]

        resource_checks = nested_checks = 0
        for name in entries:
            if not name.endswith("/_CodeSignature/CodeResources") or name in links:
                continue
            contents = posixpath.dirname(posixpath.dirname(name))
            for relative, seal in plistlib.loads(archive.read(name)).get("files2", {}).items():
                if not isinstance(seal, dict):
                    continue
                target = contents + "/" + relative
                if "symlink" in seal:
                    if links.get(target) != seal["symlink"]:
                        raise ValueError(f"Symlink resource seal mismatch: {target}")
                    resource_checks += 1
                elif "hash2" in seal:
                    if hashlib.sha256(archive.read(resolve(target))).digest() != seal["hash2"]:
                        raise ValueError(f"Resource seal mismatch: {target}")
                    resource_checks += 1
                if "cdhash" in seal:
                    binary = resolve(target)
                    if binary not in cdhashes:
                        for info_name in (target + "/Contents/Info.plist", target + "/Resources/Info.plist"):
                            info_name = resolve(info_name)
                            if info_name not in entries:
                                continue
                            info = plistlib.loads(archive.read(info_name))
                            parent = posixpath.dirname(info_name)
                            binary = resolve(parent + "/MacOS/" + info["CFBundleExecutable"] if parent.endswith("/Contents") else posixpath.dirname(parent) + "/" + info["CFBundleExecutable"])
                            break
                    if cdhashes.get(binary) != seal["cdhash"]:
                        raise ValueError(f"Nested-code seal mismatch: {target}")
                    nested_checks += 1

        private_excluded = all(not name.startswith(payload + ".runtime/") and not name.startswith(payload + "desktop/") and not name.lower().endswith((".exe", ".dll", ".log")) for name in entries if name.startswith(payload))
        if not private_excluded or executable_names != 5:
            raise ValueError("Unexpected private runtime data or bundle executable names")
        enabled = len([item for item in json.loads(archive.read(payload + "config/channels.json")) if item["enabled"]])

    return {
        "archive": "dist/" + archive_path.name,
        "version": package["version"],
        "archiveSha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
        "architecture": "arm64", "minimumMacOS": "13.0",
        "automatedApplicationTestsPassed": application_tests,
        "independentArchiveAudit": {
            "passed": True, "arm64ExecutablesWith0755Mode": len(cdhashes),
            "relativeFrameworkSymlinksResolved": len(links), "codePageHashesVerified": page_checks,
            "specialSlotHashesVerified": special_checks, "resourceAndSymlinkSealsVerified": resource_checks,
            "nestedCodeHashesVerified": nested_checks, "mainAndHelperExecutableNamesAgree": True,
            "enabledChannels": enabled, "windowsBinariesAndPrivateRuntimeDataExcluded": private_excluded,
            "packagedRuntimeFilesMatchCurrentSource": len(source_hashes), "runtimeSourceSha256": source_hashes,
        },
        "signing": "ad-hoc personal build", "appleDeveloperIdSigned": False, "notarized": False,
        "macLaunchTested": False, "macPlaybackTested": False, "appleCodesignStrictVerified": False,
        "signerVerifierLimitation": "rcodesign 0.29 verify attempts to parse the expected empty CMS slot of ad-hoc signatures; its failed results are retained in the distribution verification file. Independent hashes passed.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--application-tests", type=int, required=True)
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    evidence = audit(root, args.application_tests, args.archive)
    (root / "mac" / "verification.json").write_text(json.dumps(evidence, indent=2) + "\n")
    archive = args.archive or root / "dist" / "Charliflix-Apple-Silicon.zip"
    verification = archive.with_suffix(".verification.json")
    if verification.is_file():
        distribution_evidence = json.loads(verification.read_text())
        if distribution_evidence.get("archiveSha256") != evidence["archiveSha256"]:
            raise ValueError("Distribution evidence does not match the audited archive")
        distribution_evidence["independentArchiveAudit"] = evidence["independentArchiveAudit"]
        distribution_evidence["automatedApplicationTestsPassed"] = args.application_tests
        verification.write_text(json.dumps(distribution_evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))
