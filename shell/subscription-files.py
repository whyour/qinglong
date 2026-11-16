"""Install subscription files without following links under the scripts root."""
import contextlib
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys


def parts(relative):
    names = relative.split('/')
    if any(name in ('', '.', '..') or re.search(r'[\x00-\x1f\x7f]', name) for name in names):
        raise ValueError('invalid relative path: ' + repr(relative))
    return names


@contextlib.contextmanager
def directory(root, names, create=False):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(root, flags)
    try:
        for name in names:
            if create:
                try:
                    os.mkdir(name, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(name, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def install(source, root, relative):
    *parents, name = parts(relative)
    with directory(root, parents, True) as fd:
        try:
            existing = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing and not stat.S_ISREG(existing.st_mode):
            raise ValueError('destination is not a regular file: ' + relative)
        temp = '.ql-copy-' + secrets.token_hex(12)
        with open(source, 'rb') as src:
            out = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=fd)
            try:
                with os.fdopen(out, 'wb') as dst:
                    shutil.copyfileobj(src, dst)
                    os.fchmod(dst.fileno(), os.fstat(src.fileno()).st_mode & 0o777)
                # Replace rather than modifying an inode that may also have external hard links.
                os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
            finally:
                try:
                    os.unlink(temp, dir_fd=fd)
                except FileNotFoundError:
                    pass


def regular_files(base):
    def failed(error):
        raise error
    for parent, dirs, files in os.walk(base, followlinks=False, onerror=failed):
        dirs[:] = [d for d in dirs if d != '.git']
        for name in files:
            source = Path(parent, name)
            if stat.S_ISREG(source.lstat().st_mode):
                relative = str(source.relative_to(base))
                parts(relative)
                yield relative


def filtered(files, pattern, exclude=False):
    if not pattern:
        return files
    data = ''.join(file + '\n' for file in files)
    cmd = ['grep', '-E'] + (['-v'] if exclude else []) + ['-e', pattern]
    result = subprocess.run(cmd, input=os.fsencode(data), stdout=subprocess.PIPE)
    if result.returncode not in (0, 1):
        raise ValueError('invalid subscription filter: ' + pattern)
    return list(filter(None, os.fsdecode(result.stdout).split('\n')))


def repository(repo, scripts, namespace, listing, deps, js, py, include, exclude, dependency, extensions):
    parts(namespace)
    suffixes = tuple('.' + ext for ext in re.split(r'[|\s]+', extensions) if ext)
    candidates = sorted(f for f in regular_files(repo) if f.endswith(suffixes))
    selected = filtered(filtered(candidates, include), exclude, True)
    needed = filtered(candidates, dependency) if dependency else []
    # Evaluate every filter and collect the complete source list before touching any destination.
    files = [(Path(p), Path(p).name) for p in (js, py) if p and Path(p).is_file()]
    files += [(Path(repo, f), f) for f in needed]
    if deps and Path(deps).is_dir() and not Path(deps).is_symlink():
        files += [(Path(deps, f), f) for f in regular_files(deps)]
    files += [(Path(repo, f), f) for f in selected]
    with directory(scripts, parts(namespace), True):
        pass
    for source, file in files:
        install(source, scripts, namespace + '/' + file)
    Path(listing).write_text(''.join(namespace + '/' + f + '\n' for f in selected))


def unlink(root, relative):
    *parents, name = parts(relative)
    try:
        with directory(root, parents) as fd:
            if stat.S_ISREG(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode):
                os.unlink(name, dir_fd=fd)
    except FileNotFoundError:
        pass


def registered(listing, task, namespace, kind):
    def decode(line):
        try:
            return shlex.split(line, comments=False)
        except ValueError:
            return []
    with open(listing) as stream:
        for line in stream:
            args = decode(line)
            index = next((i for i, arg in enumerate(args) if re.fullmatch(r'ID=[1-9][0-9]*', arg)), None)
            if index is None:
                continue
            ident = args[index]
            prefix, args = args[:index], args[index + 1:]
            if len(args) == 4 and args[:3] == ['QL_TRIGGER_SOURCE=system', 'bash', '$QL_DIR/shell/system-cron.sh']:
                args = decode(args[3])
                prefix = []
                while args and re.match(r'^\w+=', args[0]) and not args[0].startswith('ID='):
                    prefix.append(args.pop(0))
                if not args or args.pop(0) != ident:
                    continue
            revision = next((a.split('=')[1] for a in prefix if re.fullmatch(r'QL_CRON_REVISION=[0-9]+', a)), '')
            while args and re.match(r'^\w+=', args[0]):
                args.pop(0)
            if not args or args.pop(0) != task:
                continue
            while args and args[0] in ('-m', '-l'):
                if args.pop(0) == '-m' and args:
                    args.pop(0)
            if args and re.fullmatch(r'(?:.*/)?(?:node|python3?|bash|sh|ts-node(?:-transpile-only)?)', args[0]):
                args.pop(0)
            if not args:
                continue
            file = args[0]
            try:
                parts(file)
            except ValueError:
                continue
            owned = file == namespace if kind == 'raw' else (
                file.startswith(namespace + '/') or (file.startswith(namespace + '_') and '/' not in file))
            if owned:
                print(ident[3:], file, revision, sep='\t')


def prepare(root, relative):
    with directory(root, parts(relative)[:-1], True):
        pass


if __name__ == '__main__':
    try:
        {'registered': registered, 'parent': prepare, 'repo': repository, 'copy': install, 'unlink': unlink}[sys.argv[1]](*sys.argv[2:])
    except (ValueError, OSError) as error:
        sys.exit('subscription: ' + str(error))
