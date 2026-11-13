"""Build the self-contained ARM64 APK; all fetched tools are pinned by SHA-256."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
ANDROID = ROOT / 'android'
CACHE = ANDROID / '.cache'
RUNTIME_VERSION = '24.22.1-0'
RUNTIME_SHA256 = 'd6fd9f610fe5d81fede8f0d400c5a62723247725a19831835f15abf4f0604250'
GRADLE_VERSION = '8.11.1'
GRADLE_SHA256 = 'f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6'

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as src:
        for block in iter(lambda: src.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def fetch(name, url, expected, enabled):
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / name
    if not target.exists():
        if not enabled:
            raise RuntimeError(f'Missing {name}; run with --fetch to download the pinned dependency.')
        temporary = target.with_suffix('.download')
        try:
            with urllib.request.urlopen(url, timeout=90) as src, temporary.open('wb') as dst:
                shutil.copyfileobj(src, dst)
            if digest(temporary) != expected:
                raise RuntimeError(f'Checksum mismatch: {name}')
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    if digest(target) != expected:
        raise RuntimeError(f'Checksum mismatch: {name}')
    return target

def safe_path(value):
    relative = PurePosixPath(value)
    if relative.is_absolute() or '..' in relative.parts or '\\' in value or ':' in value:
        raise RuntimeError('Unsafe archive path.')
    return relative

def extract(archive, destination, accept=lambda name: True):
    with zipfile.ZipFile(archive) as src:
        for entry in src.infolist():
            relative = safe_path(entry.filename)
            if entry.is_dir() or not accept(entry.filename):
                continue
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise RuntimeError('Unexpected archive symlink.')
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with src.open(entry) as inp, target.open('wb') as out:
                shutil.copyfileobj(inp, out)
            if os.name != 'nt' and mode & 0o111:
                target.chmod(0o755)

def prepare(fetch_enabled=False, abi='arm64-v8a'):
    package = json.loads((ROOT / 'package.json').read_text())
    version = package['version']
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise RuntimeError('Expected a stable package version.')
    major, minor, patch = map(int, version.split('.'))
    if minor >= 1000 or patch >= 1000:
        raise RuntimeError('Version exceeds Android version-code scheme.')
    code = major * 1000000 + minor * 1000 + patch
    (ANDROID / 'version.properties').write_text(f'versionName={version}\nversionCode={code}\n')
    name = f'nodejs-mobile-android-{RUNTIME_VERSION}.zip'
    archive = fetch(name, f'https://github.com/fogtape/nodejs-mobile/releases/download/v{RUNTIME_VERSION}/{name}', RUNTIME_SHA256, fetch_enabled)
    # The release archive has bin/<ABI> and include/node at its root.
    extract(archive, ANDROID / 'app/libnode', lambda n: n.startswith(f'bin/{abi}/') or n.startswith('include/'))
    native = ANDROID / 'app/libnode/bin' / abi / 'libnode.so'
    if not native.is_file():
        raise RuntimeError('The pinned runtime archive layout changed.')
    assets = ANDROID / 'app/src/main/assets'
    payload = assets / 'player'
    # Rebuild only our generated, ignored payload directory.
    if payload.exists():
        if payload.resolve().parent != assets.resolve():
            raise RuntimeError('Unexpected payload path.')
        shutil.rmtree(payload)
    files = [ROOT / 'server.cjs', ROOT / 'package.json', ANDROID / 'android-entry.cjs']
    for directory, pattern in [('lib', '*.cjs'), ('config', '*.json'), ('public', '*')]:
        files.extend(p for p in (ROOT / directory).glob(pattern) if p.is_file())
    files.extend([ROOT / 'node_modules/hls.js/dist/hls.min.js', ROOT / 'node_modules/hls.js/LICENSE', ROOT / 'node_modules/hls.js/package.json'])
    files.extend([ROOT / 'node_modules/pngjs/package.json', ROOT / 'node_modules/pngjs/LICENSE'])
    files.extend(p for p in (ROOT / 'node_modules/pngjs/lib').glob('*.js') if p.is_file() and not p.is_symlink())
    manifest = []
    hashes = {}
    for source in sorted(files):
        relative = Path('android-entry.cjs') if source == ANDROID / 'android-entry.cjs' else source.relative_to(ROOT)
        destination = payload / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        name = relative.as_posix()
        manifest.append(name)
        hashes[name] = digest(source)
    if not (payload / 'node_modules/hls.js/dist/hls.min.js').is_file() or not (payload / 'node_modules/pngjs/lib/png.js').is_file():
        raise RuntimeError('Run npm ci before packaging.')
    assets.mkdir(parents=True, exist_ok=True)
    (assets / 'player-files.json').write_text(json.dumps(manifest, separators=(',', ':')))
    shutil.copytree(ANDROID / 'licenses', assets / 'licenses', dirs_exist_ok=True)
    (CACHE / 'payload-hashes.json').write_text(json.dumps(hashes, indent=2) + '\n')
    gradle_archive = fetch(f'gradle-{GRADLE_VERSION}-bin.zip', f'https://services.gradle.org/distributions/gradle-{GRADLE_VERSION}-bin.zip', GRADLE_SHA256, fetch_enabled)
    gradle = CACHE / f'gradle-{GRADLE_VERSION}' / 'bin' / ('gradle.bat' if os.name == 'nt' else 'gradle')
    if not gradle.exists():
        extract(gradle_archive, CACHE)
    return version, code, gradle

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--debug', action='store_true', help='Development only; never publish this certificate.')
    parser.add_argument('--abi', choices=['arm64-v8a', 'x86_64'], default='arm64-v8a')
    args = parser.parse_args()
    version, code, gradle = prepare(args.fetch, args.abi)
    if args.prepare_only:
        print(f'Prepared Charliflix {version} ({code}) for {args.abi}.')
        return
    if not args.debug:
        for name in ['CHARLIFLIX_ANDROID_KEYSTORE', 'CHARLIFLIX_ANDROID_KEYSTORE_PASSWORD', 'CHARLIFLIX_ANDROID_KEY_PASSWORD', 'CHARLIFLIX_ANDROID_KEY_ALIAS']:
            if not os.environ.get(name):
                raise RuntimeError(f'{name} must be supplied for a release build.')
    variant = 'debug' if args.debug else 'release'
    subprocess.run([str(gradle), '--no-daemon', f'-PcharliflixAbi={args.abi}', 'lint' + variant.capitalize(), 'assemble' + variant.capitalize()], cwd=ANDROID, check=True)
    apk = ANDROID / f'app/build/outputs/apk/{variant}/app-{variant}.apk'
    if not apk.is_file():
        raise RuntimeError('Expected signed APK was not created.')
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    platform = 'Android-arm64' if args.abi == 'arm64-v8a' else 'Android-x86_64-test'
    name = f'Charliflix-v{version}-{platform}' + ('-debug' if args.debug else '')
    output = dist / f'{name}.apk'
    shutil.copyfile(apk, output)
    evidence = {
        'version': version, 'versionCode': code, 'package': 'com.charliflix.player' + ('.debug' if args.debug else ''),
        'abi': args.abi, 'minAndroidApi': 26, 'targetAndroidApi': 35,
        'nodeRuntime': RUNTIME_VERSION, 'nodeRuntimeSource': 'https://github.com/fogtape/nodejs-mobile',
        'nodeRuntimeArchiveSha256': RUNTIME_SHA256,
        'sha256': digest(output), 'size': output.stat().st_size,
        'buildVariant': variant, 'applicationFiles': json.loads((CACHE / 'payload-hashes.json').read_text()),
        'installedOrLaunched': False,
    }
    (dist / f'{name}.verification.json').write_text(json.dumps(evidence, indent=2) + '\n')
    (dist / f'{name}.apk.sha256').write_text(f'{digest(output)}  {output.name}\n')
    print(f'Built {output.name}; sha256 {digest(output)}')

if __name__ == '__main__':
    main()
