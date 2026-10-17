"""Assemble and ad-hoc sign the ARM64 app on a POSIX build filesystem."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import tarfile
import tempfile
import zipfile
import urllib.request

ELECTRON_VERSION = "44.7.2"
ELECTRON_SHA256 = "07d73d3d6dd0b8679c2f1849e30df179ea50c1d6b17630fcc398ae05221f0bd2"
SIGNER_SHA256 = "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002"
APP_ID = "local.channelroom.desktop"
DOWNLOADS = (
    (f"electron-v{ELECTRON_VERSION}-darwin-arm64.zip", f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}/electron-v{ELECTRON_VERSION}-darwin-arm64.zip", ELECTRON_SHA256),
    ("apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz", "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz", SIGNER_SHA256),
)


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def assert_hash(path: Path, expected: str) -> None:
    if digest(path) != expected:
        raise ValueError(f"Archive checksum mismatch: {path.name}")


def fetch_dependencies(root: Path) -> None:
    cache = root / "mac" / ".cache"
    cache.mkdir(parents=True, exist_ok=True)
    for name, url, expected in DOWNLOADS:
        destination = cache / name
        if not destination.exists():
            temporary = destination.with_suffix(destination.suffix + ".download")
            try:
                with urllib.request.urlopen(url, timeout=60) as source, temporary.open("wb") as output:
                    shutil.copyfileobj(source, output)
                assert_hash(temporary, expected)
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
        assert_hash(destination, expected)


def safe_member(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError(f"Unsafe archive member: {name}")
    return path


def unpack_electron(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            relative = safe_member(entry.filename)
            target = destination.joinpath(*relative.parts)
            mode = entry.external_attr >> 16
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(stat.S_IMODE(mode) or 0o755)
            elif stat.S_ISLNK(mode):
                link = source.read(entry).decode("utf-8")
                if os.path.isabs(link) or not (target.parent / link).resolve().is_relative_to(destination.resolve()):
                    raise ValueError(f"Unsafe framework link: {entry.filename}")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(link)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(entry) as incoming, target.open("wb") as output:
                    shutil.copyfileobj(incoming, output)
                target.chmod(stat.S_IMODE(mode) or 0o644)


def macho_signature(path: Path, external_slots: dict[int, bytes] | None = None) -> dict | None:
    with path.open("rb") as source:
        header = source.read(32)
        if header[:4] != b"\xcf\xfa\xed\xfe":
            return None
        _, cpu, _, _, commands, _, _, _ = struct.unpack("<IiiIIIII", header)
        if cpu != 0x0100000C:
            raise ValueError(f"Unexpected non-ARM64 Mach-O: {path.name}")
        signature = None
        for _ in range(commands):
            position = source.tell()
            command, size = struct.unpack("<II", source.read(8))
            if size < 8:
                raise ValueError("Malformed Mach-O command")
            if command == 0x1D:
                offset, length = struct.unpack("<II", source.read(8))
                signature = (offset, length)
            source.seek(position + size)
        if signature is None:
            raise ValueError(f"Unsigned ARM64 executable: {path.name}")
        source.seek(signature[0])
        blob = source.read(signature[1])
    magic, length, count = struct.unpack_from(">III", blob)
    if magic != 0xFADE0CC0 or length > len(blob):
        raise ValueError("Invalid signature container")
    flags, entitlements, blobs = None, {}, {}
    for index in range(count):
        kind, offset = struct.unpack_from(">II", blob, 12 + index * 8)
        _, size = struct.unpack_from(">II", blob, offset)
        if offset + size > length:
            raise ValueError("Signature blob exceeds its container")
        blobs[kind] = blob[offset:offset + size]
        if kind == 0:
            flags = struct.unpack_from(">I", blob, offset + 12)[0]
        elif kind == 5:
            entitlements = plistlib.loads(blob[offset + 8:offset + size].rstrip(b"\0"))
    if flags is None or not flags & 2:
        raise ValueError(f"Expected an ad-hoc signature: {path.name}")
    page_checks = special_checks = directory_checks = 0
    for kind, directory in blobs.items():
        if kind != 0 and not 0x1000 <= kind <= 0x1005:
            continue
        directory_magic, _, version, directory_flags, hash_offset, _, specials, pages, limit = struct.unpack_from(">9I", directory)
        hash_size, hash_type, _, page_log = struct.unpack_from("4B", directory, 36)
        if directory_magic != 0xFADE0C02 or not directory_flags & 2:
            raise ValueError("Malformed ad-hoc code directory")
        if version >= 0x20300:
            limit64 = struct.unpack_from(">Q", directory, 56)[0]
            if limit64:
                limit = limit64
        if limit != signature[0] or page_log > 30:
            raise ValueError("The code directory does not cover the complete Mach-O payload")
        algorithms = {1: ("sha1", 20), 2: ("sha256", 32), 3: ("sha256", 20), 4: ("sha384", 48)}
        if hash_type not in algorithms or hash_size != algorithms[hash_type][1]:
            raise ValueError("Unsupported code directory hash format")
        algorithm = algorithms[hash_type][0]
        page_size = (1 << page_log) if page_log else max(limit, 1)
        expected_pages = (limit + page_size - 1) // page_size
        if pages != expected_pages or hash_offset < specials * hash_size or hash_offset + pages * hash_size > len(directory):
            raise ValueError("Invalid code directory page table")
        with path.open("rb") as code:
            for page in range(pages):
                payload = code.read(min(page_size, limit - page * page_size))
                actual = hashlib.new(algorithm, payload).digest()[:hash_size]
                expected = directory[hash_offset + page * hash_size:hash_offset + (page + 1) * hash_size]
                if actual != expected:
                    raise ValueError(f"Code page hash mismatch: {path.name}, page {page}")
                page_checks += 1
        for slot in range(1, specials + 1):
            expected = directory[hash_offset - slot * hash_size:hash_offset - (slot - 1) * hash_size]
            payload = (external_slots or {}).get(slot) if slot in (1, 3) else blobs.get(slot)
            actual = hashlib.new(algorithm, payload).digest()[:hash_size] if payload is not None else bytes(hash_size)
            if actual != expected:
                raise ValueError(f"Special slot hash mismatch: {path.name}, slot {slot}")
            special_checks += 1
        directory_checks += 1
    return {"architecture": "arm64", "adHoc": True, "flags": flags, "entitlements": entitlements, "codeDirectoriesVerified": directory_checks, "codePageHashesVerified": page_checks, "specialSlotHashesVerified": special_checks}


def bundle_external_slots(bundle: Path) -> dict[Path, dict[int, bytes]]:
    result = {}
    for info_path in bundle.rglob("Info.plist"):
        if info_path.is_symlink():
            continue
        info = plistlib.loads(info_path.read_bytes())
        executable = info.get("CFBundleExecutable")
        if not executable:
            continue
        body = info_path.parent
        if body.name == "Contents":
            binary = body / "MacOS" / executable
            seal = body / "_CodeSignature" / "CodeResources"
        elif body.name == "Resources":
            binary = body.parent / executable
            seal = body.parent / "_CodeSignature" / "CodeResources"
        else:
            continue
        if binary.is_file():
            result[binary.resolve()] = {1: info_path.read_bytes(), 3: seal.read_bytes()}
    return result


def verify_resource_seals(bundle: Path) -> int:
    verified = 0
    for seal in bundle.rglob("CodeResources"):
        if seal.parent.name != "_CodeSignature" or seal.is_symlink():
            continue
        contents = seal.parent.parent
        manifest = plistlib.loads(seal.read_bytes())
        for relative, entry in manifest.get("files2", {}).items():
            target = contents / relative
            if not isinstance(entry, dict):
                continue
            if "symlink" in entry:
                if not target.is_symlink() or os.readlink(target) != entry["symlink"]:
                    raise ValueError(f"Framework link seal mismatch: {relative}")
                verified += 1
            elif "hash2" in entry:
                if not target.is_file() or hashlib.sha256(target.read_bytes()).digest() != entry["hash2"]:
                    raise ValueError(f"Resource seal mismatch: {relative}")
                verified += 1
    return verified


def write_zip(bundle: Path, readme: Path, output: Path) -> int:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".zip.tmp")
    links = 0
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for folder, directories, files in os.walk(bundle, followlinks=False):
                for name in sorted(directories + files):
                    path = Path(folder) / name
                    relative = path.relative_to(bundle.parent).as_posix()
                    mode = path.lstat().st_mode
                    if stat.S_ISLNK(mode):
                        entry = zipfile.ZipInfo(relative)
                        entry.create_system = 3
                        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                        archive.writestr(entry, os.readlink(path).encode("utf-8"))
                        links += 1
                    elif path.is_dir():
                        entry = zipfile.ZipInfo(relative + "/")
                        entry.create_system = 3
                        entry.external_attr = ((stat.S_IFDIR | 0o755) << 16) | 0x10
                        archive.writestr(entry, b"")
                    else:
                        archive.write(path, relative)
            archive.write(readme, "Read Me.txt")
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                raise ValueError("Packaged ZIP failed its CRC check")
            executable = archive.getinfo("Charliflix.app/Contents/MacOS/Charliflix")
            if not (executable.external_attr >> 16) & 0o111:
                raise ValueError("Mac executable permissions were not preserved")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return links


def build(root: Path, output: Path) -> None:
    package = json.loads((root / "package.json").read_text())
    version = package["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Release version must be a stable semantic version")
    cache = root / "mac" / ".cache"
    electron_archive = cache / f"electron-v{ELECTRON_VERSION}-darwin-arm64.zip"
    signer_archive = cache / "apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz"
    assert_hash(electron_archive, ELECTRON_SHA256)
    assert_hash(signer_archive, SIGNER_SHA256)
    with tempfile.TemporaryDirectory(prefix="channel-room-mac-") as work_text:
        work = Path(work_text)
        unpack_electron(electron_archive, work)
        bundle = work / "Charliflix.app"
        (work / "Electron.app").rename(bundle)
        contents = bundle / "Contents"
        (contents / "MacOS" / "Electron").rename(contents / "MacOS" / "Charliflix")
        plist_path = contents / "Info.plist"
        info = plistlib.loads(plist_path.read_bytes())
        info.update({"CFBundleName": "Charliflix", "CFBundleDisplayName": "Charliflix", "CFBundleExecutable": "Charliflix", "CFBundleIdentifier": APP_ID, "CFBundleIconFile": "channel-room.icns", "CFBundleShortVersionString": version, "CFBundleVersion": version})
        plist_path.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_XML, sort_keys=False))
        resources = contents / "Resources"
        shutil.copy2(root / "mac" / "assets" / "channel-room.icns", resources / "channel-room.icns")
        for name in ("LICENSE", "LICENSES.chromium.html"):
            if (work / name).is_file():
                shutil.copy2(work / name, resources / ("Electron-" + name))
        payload = resources / "app"
        payload.mkdir()
        for name in ("server.cjs",):
            shutil.copy2(root / name, payload / name)
        if (root / "LICENSE").is_file():
            shutil.copy2(root / "LICENSE", payload / "LICENSE")
        (payload / "config").mkdir()
        shutil.copy2(root / "config" / "channels.json", payload / "config" / "channels.json")
        (payload / "lib").mkdir()
        for source in (root / "lib").glob("*.cjs"):
            shutil.copy2(source, payload / "lib" / source.name)
        (payload / "public").mkdir()
        for name in ("app.js", "styles.css", "index.html", "favicon.svg"):
            shutil.copy2(root / "public" / name, payload / "public" / name)
        (payload / "mac").mkdir()
        for name in ("main.cjs", "runtime.cjs"):
            shutil.copy2(root / "mac" / name, payload / "mac" / name)
        dependencies = payload / "node_modules"
        png = dependencies / "pngjs"
        (png / "lib").mkdir(parents=True)
        for name in ("LICENSE", "package.json"):
            shutil.copy2(root / "node_modules" / "pngjs" / name, png / name)
        for source in (root / "node_modules" / "pngjs" / "lib").glob("*.js"):
            shutil.copy2(source, png / "lib" / source.name)
        hls = dependencies / "hls.js"
        (hls / "dist").mkdir(parents=True)
        for name in ("LICENSE", "package.json"):
            shutil.copy2(root / "node_modules" / "hls.js" / name, hls / name)
        shutil.copy2(root / "node_modules" / "hls.js" / "dist" / "hls.min.js", hls / "dist" / "hls.min.js")
        (payload / "package.json").write_text(json.dumps({"name": package["name"], "productName": "Charliflix", "version": version, "main": "mac/main.cjs", "private": True, "repository": package.get("repository"), "dependencies": package["dependencies"]}, indent=2) + "\n")
        # No credentials or local profiles enter the payload: only explicit runtime files.
        for folder, directories, files in os.walk(payload):
            Path(folder).chmod(0o755)
            for name in files:
                (Path(folder) / name).chmod(0o644)
        tools = work / "signer"
        with tarfile.open(signer_archive) as archive:
            archive.extractall(tools, filter="data")
        signer = next(tools.rglob("rcodesign"))
        entitlements = work / "entitlements.plist"
        entitlements.write_bytes(plistlib.dumps({"com.apple.security.cs.allow-jit": True, "com.apple.security.cs.disable-library-validation": True}))
        command = [str(signer), "sign", "-C", "/dev/null", "--timestamp-url", "none", "--code-signature-flags", "runtime", "--entitlements-xml-file", str(entitlements)]
        helper_paths = []
        for original_helper in sorted((contents / "Frameworks").glob("*.app")):
            old_name = original_helper.stem
            new_name = old_name.replace("Electron", "Charliflix", 1)
            helper = original_helper.with_name(new_name + ".app")
            original_helper.rename(helper)
            (helper / "Contents" / "MacOS" / old_name).rename(helper / "Contents" / "MacOS" / new_name)
            helper_paths.append(helper)
        for helper in helper_paths:
            helper_plist = helper / "Contents" / "Info.plist"
            helper_info = plistlib.loads(helper_plist.read_bytes())
            suffix = helper_info["CFBundleIdentifier"].removeprefix("com.github.Electron")
            helper_info["CFBundleIdentifier"] = APP_ID + suffix
            helper_info["CFBundleName"] = helper.stem
            helper_info["CFBundleExecutable"] = helper.stem
            helper_info["CFBundleShortVersionString"] = version
            helper_info["CFBundleVersion"] = version
            helper_plist.write_bytes(plistlib.dumps(helper_info, fmt=plistlib.FMT_XML, sort_keys=False))
            relative = helper.relative_to(bundle).as_posix()
            command += ["--code-signature-flags", relative + ":runtime", "--entitlements-xml-file", relative + ":" + str(entitlements)]
        command.append(str(bundle))
        log_path = root / "mac" / ".cache" / "signing.log"
        with log_path.open("w") as log:
            subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT)
        signatures = []
        external_slots = bundle_external_slots(bundle)
        tool_verification = []
        for path in sorted(bundle.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            signed = macho_signature(path, external_slots.get(path.resolve()))
            if signed:
                verification = subprocess.run([str(signer), "verify", "-C", "/dev/null", str(path)], capture_output=True, text=True)
                if verification.returncode != 0:
                    messages = verification.stdout + verification.stderr
                    known_cms_failure = {
                        "CMS error: missing further values (at position 0)",
                        "(the verify command is known to be buggy and gives misleading results; we highly recommend using Apple's tooling until this message is removed)",
                        "Error: problems reported during verification",
                    }
                    if {line.strip() for line in messages.splitlines() if line.strip()} != known_cms_failure:
                        raise ValueError(f"Signing-tool verification failed: {path.relative_to(bundle)}: {messages}")
                    tool_verification.append({"path": path.relative_to(bundle).as_posix(), "exitCode": verification.returncode, "limitation": "rcodesign 0.29 verifier attempts to parse the expected empty CMS slot in ad-hoc signatures; independent code-page and special-slot hashes passed instead."})
                signatures.append({"path": path.relative_to(bundle).as_posix(), **signed})
        main_signature = next(s for s in signatures if s["path"] == "Contents/MacOS/Charliflix")
        if not main_signature["entitlements"].get("com.apple.security.cs.allow-jit"):
            raise ValueError("The main executable is missing its JavaScript JIT entitlement")
        for helper in helper_paths:
            signature_path = (helper / "Contents" / "MacOS" / helper.stem).relative_to(bundle).as_posix()
            helper_signature = next(s for s in signatures if s["path"] == signature_path)
            if not helper_signature["entitlements"].get("com.apple.security.cs.allow-jit"):
                raise ValueError("A browser helper is missing its JavaScript JIT entitlement")
        # Demonstrate that the independent validator rejects a payload mutation.
        probe = work / "tamper-probe"
        original_main = contents / "MacOS" / "Charliflix"
        shutil.copy2(original_main, probe)
        with probe.open("r+b") as code:
            code.seek(4096)
            original = code.read(1)
            code.seek(4096)
            code.write(bytes([original[0] ^ 1]))
        try:
            macho_signature(probe, external_slots[original_main.resolve()])
            raise ValueError("The signature validator did not detect a payload mutation")
        except ValueError as error:
            if "Code page hash mismatch" not in str(error):
                raise
        seals = verify_resource_seals(bundle)
        links = write_zip(bundle, root / "mac" / "Read Me.txt", output)
        evidence = {"application": "Charliflix", "architecture": "arm64", "minimumMacOS": info.get("LSMinimumSystemVersion"), "electron": ELECTRON_VERSION, "electronSha256": ELECTRON_SHA256, "signing": "ad-hoc", "notarized": False, "macLaunchTested": False, "macPlaybackTested": False, "macCodesignStrictTested": False, "machoSignatureChecks": len(signatures), "codePageHashesVerified": sum(s["codePageHashesVerified"] for s in signatures), "specialSlotHashesVerified": sum(s["specialSlotHashesVerified"] for s in signatures), "payloadMutationRejected": True, "resourceSealChecks": seals, "zipSymlinks": links, "zipCrcPassed": True, "executableModePreserved": True, "enabledChannels": len([c for c in json.loads((payload / "config" / "channels.json").read_text()) if c["enabled"]]), "signatures": signatures, "signerVerifierLimitations": tool_verification, "archive": output.name, "archiveBytes": output.stat().st_size, "archiveSha256": digest(output)}
        evidence["version"] = version
        output.with_suffix(".verification.json").write_text(json.dumps(evidence, indent=2) + "\n")
        output.with_suffix(".zip.sha256").write_text(evidence["archiveSha256"] + "  " + output.name + "\n")
        print(json.dumps({k: v for k, v in evidence.items() if k != "signatures"}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--fetch", action="store_true", help="Download missing, checksum-pinned build tools")
    options = parser.parse_args()
    project_root = Path(__file__).resolve().parent.parent
    if options.fetch:
        fetch_dependencies(project_root)
    build(project_root, options.output or project_root / "dist" / "Charliflix-Apple-Silicon.zip")
