"""Verify the final ARM64 APK, embedded source hashes, certificate and alignment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent

SYSTEM_LIBRARIES = frozenset({'libc.so', 'libm.so', 'libdl.so', 'liblog.so'})
NATIVE_DEPENDENCIES = {
    'libnode.so': SYSTEM_LIBRARIES | {'libc++_shared.so'},
    'libcharliflix.so': SYSTEM_LIBRARIES | {'libnode.so', 'libc++_shared.so'},
    'libc++_shared.so': frozenset({'libc.so', 'libm.so', 'libdl.so'}),
}


def audit_elf(data, library):
    """Read bounded ELF64 headers/dynamic data without executing a library."""
    if library not in NATIVE_DEPENDENCIES or not 64 <= len(data) <= 160 * 1024 * 1024:
        raise RuntimeError('Invalid native library or size.')

    def unpack(layout, offset):
        size = struct.calcsize(layout)
        if offset < 0 or offset > len(data) - size:
            raise RuntimeError('Native ELF header exceeded its file bounds.')
        return struct.unpack_from(layout, data, offset)

    if data[:7] != b'\x7fELF\x02\x01\x01':
        raise RuntimeError('Native libraries must be little-endian ELF64.')
    if unpack('<HHI', 16) != (3, 183, 1):
        raise RuntimeError('Native libraries must be ARM64 shared objects.')
    phoff = unpack('<Q', 32)[0]
    ehsize, phsize, phcount = unpack('<HHH', 52)
    if ehsize != 64 or phsize != 56 or not 1 <= phcount <= 128 or phoff < 64 or phoff + phsize * phcount > len(data):
        raise RuntimeError('Invalid native ELF program-header table.')
    loads = []
    dynamic = None
    for index in range(phcount):
        kind, flags, offset, address, physical, file_size, memory_size, alignment = unpack('<IIQQQQQQ', phoff + phsize * index)
        if offset + file_size > len(data) or memory_size < file_size:
            raise RuntimeError('Native ELF segment exceeded its file bounds.')
        if kind == 1:
            if alignment < 16384 or alignment & (alignment - 1) or offset % alignment != address % alignment:
                raise RuntimeError('Native ELF load segments must support 16 KiB pages.')
            loads.append((offset, address, file_size))
        elif kind == 2:
            if dynamic is not None or not 16 <= file_size <= 1024 * 1024 or file_size % 16:
                raise RuntimeError('Invalid native ELF dynamic segment.')
            dynamic = (offset, file_size)
    if not loads or dynamic is None:
        raise RuntimeError('Native ELF load or dynamic segment is missing.')
    needed = []
    string_address = None
    string_size = None
    terminated = False
    for offset in range(dynamic[0], dynamic[0] + dynamic[1], 16):
        tag, value = unpack('<qQ', offset)
        if tag == 0:
            terminated = True
            break
        if tag == 1:
            if len(needed) >= 16:
                raise RuntimeError('Too many native ELF dependencies.')
            needed.append(value)
        elif tag == 5:
            if string_address is not None:
                raise RuntimeError('Ambiguous native ELF string table.')
            string_address = value
        elif tag == 10:
            if string_size is not None:
                raise RuntimeError('Ambiguous native ELF string table size.')
            string_size = value
    if not terminated or string_address is None or string_size is None or not 1 <= string_size <= 8 * 1024 * 1024:
        raise RuntimeError('Invalid native ELF dynamic string metadata.')
    positions = [offset + string_address - address for offset, address, size in loads
                 if address <= string_address and string_address + string_size <= address + size]
    if len(positions) != 1:
        raise RuntimeError('Native ELF string table is outside a unique file-backed load segment.')
    strings = data[positions[0]:positions[0] + string_size]
    dependencies = []
    for offset in needed:
        if offset >= len(strings):
            raise RuntimeError('Native ELF dependency string is out of bounds.')
        end = strings.find(b'\0', offset, min(len(strings), offset + 129))
        if end < 0:
            raise RuntimeError('Native ELF dependency string is invalid.')
        try:
            name = strings[offset:end].decode('ascii')
        except UnicodeDecodeError as error:
            raise RuntimeError('Native ELF dependency name is invalid.') from error
        if name not in NATIVE_DEPENDENCIES[library] or name in dependencies:
            raise RuntimeError('Native ELF contains an unexpected or duplicate dependency.')
        dependencies.append(name)
    if not dependencies or (library == 'libcharliflix.so' and 'libnode.so' not in dependencies):
        raise RuntimeError('Native ELF dependencies are incomplete.')
    return {'machine': 'AArch64', 'class': 'ELF64', 'loadAlignment16KiB': True,
            'dependencies': sorted(dependencies)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--smoke-passed', action='store_true')
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    name = f'Charliflix-v{version}-Android-arm64'
    apk = ROOT / 'dist' / f'{name}.apk'
    evidence_file = ROOT / 'dist' / f'{name}.verification.json'
    evidence = json.loads(evidence_file.read_text())
    sdk = Path(os.environ.get('ANDROID_HOME') or os.environ['ANDROID_SDK_ROOT']) / 'build-tools/35.0.0'
    signature = subprocess.run([str(sdk / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)], check=True, capture_output=True, text=True).stdout
    certificate = re.search(r'Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]{64})', signature)
    if not certificate or len(re.findall(r'Signer #[1-9][0-9]* certificate SHA-256 digest:', signature)) != 1:
        raise RuntimeError('The APK signing certificate could not be verified.')
    expected_certificate = (ROOT / 'android/release-certificate.sha256').read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{64}', expected_certificate) or certificate[1].lower() != expected_certificate:
        raise RuntimeError('The APK signing certificate does not match the retained Charliflix release signer.')
    badging = subprocess.run([str(sdk / 'aapt'), 'dump', 'badging', str(apk)], check=True, capture_output=True, text=True).stdout
    if f"package: name='com.charliflix.player' versionCode='{evidence['versionCode']}' versionName='{version}'" not in badging or 'application-debuggable' in badging:
        raise RuntimeError('The published APK has incorrect package, version or debug metadata.')
    subprocess.run([str(sdk / 'zipalign'), '-c', '-P', '16', '4', str(apk)], check=True)
    with zipfile.ZipFile(apk) as archive:
        native = {name for name in archive.namelist() if name.startswith('lib/')}
        expected = {f'lib/arm64-v8a/{name}' for name in ['libnode.so', 'libcharliflix.so', 'libc++_shared.so']}
        if native != expected:
            raise RuntimeError('Unexpected native library payload.')
        native_audits = {}
        for filename in sorted(native):
            if archive.getinfo(filename).file_size > 160 * 1024 * 1024:
                raise RuntimeError('Native library exceeded its size limit.')
            library = filename.rsplit('/', 1)[1]
            native_audits[library] = audit_elf(archive.read(filename), library)
        manifest = json.loads(archive.read('assets/player-files.json'))
        if set(manifest) != set(evidence['applicationFiles']):
            raise RuntimeError('APK player manifest does not match the verified source list.')
        for file, expected_hash in evidence['applicationFiles'].items():
            if hashlib.sha256(archive.read(f'assets/player/{file}')).hexdigest() != expected_hash:
                raise RuntimeError(f'Embedded source hash mismatch: {file}')
        archive.getinfo('assets/licenses/node-LICENSE.txt')
    evidence['apkAudit'] = {'passed': True, 'signed': True, 'debuggable': False,
                            'certificateSha256': certificate[1].lower(), 'zipAlignment16KiB': True,
                            'retainedCertificateMatches': True, 'nativeElf': native_audits,
                            'embeddedSourceHashes': True, 'arm64Only': True}
    if args.smoke_passed:
        evidence['android13EmulatorSmokeTest'] = {
            'passed': True, 'abi': 'x86_64', 'nativeNodeStartup': True,
            'localHttpAssets': True, 'webViewDocument': True,
            'navigationPolicy': True, 'activityRecreation': True,
            'storedThemeHistoryRecreation': True, 'pictureInPictureLifecycle': True,
            'longTextLandscapeAndPortrait': True,
            'realStreamPlayback': False, 'retroidNovaDeviceTest': False,
        }
    evidence_file.write_text(json.dumps(evidence, indent=2) + '\n')
    checksum = hashlib.sha256(apk.read_bytes()).hexdigest()
    (ROOT / 'dist' / f'{name}.apk.sha256').write_text(f'{checksum}  {apk.name}\n')
    print('APK signature, alignment, architecture, metadata and embedded files verified.')

if __name__ == '__main__':
    main()
