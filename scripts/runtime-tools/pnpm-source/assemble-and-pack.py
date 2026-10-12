import gzip, hashlib, io, json, os, shutil, tarfile
from pathlib import Path
import sys

source, stage, archive, payload = map(Path, sys.argv[1:])
if not (stage / 'dist/pnpm.cjs').is_file():
    raise SystemExit('Run the controlled bundle builder first')
cli = source / 'pnpm'
shutil.copytree(cli / 'bin', stage / 'bin')
shutil.copytree(cli / 'node-gyp-bin', stage / 'dist/node-gyp-bin')
shutil.copytree(cli / 'node_modules/@pnpm/tabtab/lib/templates', stage / 'dist/templates')
shutil.copyfile(cli / 'pnpmrc', stage / 'dist/pnpmrc')
for name in ['LICENSE', 'README.md']:
    for candidate in [cli / name, source / name]:
        if candidate.is_file():
            shutil.copyfile(candidate, stage / name)
            break
manifest = json.loads((cli / 'package.json').read_text())
for field in ['dependencies', 'optionalDependencies', 'devDependencies', 'scripts', 'pnpm', 'jest', 'publishConfig']:
    manifest.pop(field, None)
manifest['qinglongSecurityPatch'] = {
    'baseVersion': '10.34.6',
    'upstreamCommit': '9287c31cea69206c4eeca7f21cd21df81d0b93e7',
    'platform': 'linux',
    'buildLockSha256': hashlib.sha256((payload / 'pnpm-lock.yaml').read_bytes()).hexdigest(),
    'overridesSha256': hashlib.sha256((payload / 'pnpm-workspace.yaml').read_bytes()).hexdigest(),
    'builderSha256': hashlib.sha256((payload / 'bundle-linux.cjs').read_bytes()).hexdigest(),
    'nativeReflink': 'external; Linux uses Node fs.COPYFILE_FICLONE_FORCE',
}
(stage / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
shutil.copyfile(payload / 'node-gyp-runtime/package.json', stage / 'dist/package.json')
shutil.copyfile(payload / 'node-gyp-runtime/package-lock.json', stage / 'dist/package-lock.json')
if not (stage / 'dist/node_modules/node-gyp/package.json').is_file():
    raise SystemExit('Install the recorded node-gyp-runtime lock into stage/dist first')
files = sorted(p for p in stage.rglob('*') if p.is_file() and not p.is_symlink())
for file in files:
    relative = str(file.relative_to(stage))
    magic = file.read_bytes()[:4]
    if file.suffix in ['.node', '.exe', '.dll', '.so', '.dylib'] or magic in [b'\x7fELF', b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe'] or magic[:2] == b'MZ':
        raise SystemExit('Unexpected binary in Linux payload: ' + relative)
with archive.open('wb') as raw:
    with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as tar:
            for file in files:
                data = file.read_bytes()
                info = tarfile.TarInfo('package/' + str(file.relative_to(stage)))
                info.size, info.mtime, info.uid, info.gid = len(data), 0, 0, 0
                info.uname = info.gname = ''
                info.mode = 0o755 if file.stat().st_mode & 0o111 else 0o644
                tar.addfile(info, io.BytesIO(data))
proof = {
    'fileCount': len(files), 'nativeOrPlatformBinaries': [],
    'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
    'files': [{'path': str(p.relative_to(stage)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files],
    'provenance': manifest['qinglongSecurityPatch'],
}
archive.with_suffix('.evidence.json').write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps({key: proof[key] for key in ['fileCount', 'nativeOrPlatformBinaries', 'archive', 'sha256']}, indent=2))
