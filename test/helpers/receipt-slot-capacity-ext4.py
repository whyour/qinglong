"""Drive the real block/inode limits for the private-slot power-cut regression.

The controller supplies a private receipt already verified by two collectors.
Stage the writer's only copy before filling the disk, install it by rename at
zero capacity, then release only this fixture's allocations after reboot.
"""
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys

if not __debug__:
    raise RuntimeError('The dedicated-volume checks require Python assertions')

volume = Path('/ql/data/db')
spool = volume / 'cron-exits'
filler = volume / '.qa-slot-capacity'


def capacity():
    stat = os.statvfs(volume)
    return dict(blocks=stat.f_bavail, freeBlocks=stat.f_bfree, inodes=stat.f_favail)


def sync(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def fill(slot, mode, body):
    filler.mkdir(mode=0o700)
    # Otherwise freeing the old inode or its empty parent directory could give
    # ext4 enough space to pass the next stage without exercising ENOSPC.
    os.link(slot, slot.parent / '.qa-old-pin')
    staged = slot.parent / '.qa-staged'
    with staged.open('xb') as dest:
        dest.write(body.encode())
        dest.flush()
        os.fsync(dest.fileno())
    sync(slot.parent)
    errors = {}
    with (filler / 'blocks').open('xb', buffering=0) as dest:
        if mode == 'both':
            i = 0
            try:
                while True:
                    (filler / str(i)).touch(exist_ok=False)
                    i += 1
            except OSError as exc:
                if exc.errno != errno.ENOSPC or capacity()['inodes'] != 0:
                    raise
                errors['create'] = exc.errno
        for size in (65536, os.statvfs(volume).f_frsize):
            buf = bytes(size)
            try:
                while True:
                    dest.write(buf)
                    os.fsync(dest.fileno())
            except OSError as exc:
                if exc.errno != errno.ENOSPC:
                    raise
                errors['write'] = exc.errno
    sync(filler)
    sync(volume)
    result = capacity()
    assert result['blocks'] == 0, result
    assert mode != 'both' or result['inodes'] == 0
    return dict(capacity=result, errno=errors, stagedInode=staged.stat().st_ino)


def main():
    op, execution, mode = sys.argv[1:4]
    assert re.fullmatch(r'[a-z0-9-]{1,120}', execution) and mode in ('blocks', 'both')
    mounts = [line.split() for line in Path('/proc/mounts').read_text().splitlines()]
    assert any(row[1:3] == [str(volume), 'ext4'] for row in mounts)
    stat = os.statvfs(volume)
    assert (volume / '.qa-isolated-volume').is_file()
    assert 0 < stat.f_blocks * stat.f_frsize <= 32 * 1024 * 1024 and 0 < stat.f_files <= 8192
    claim = spool / ('.claim.' + execution + '.qaTest')
    slot = claim / 'receipt'
    if op == 'fill':
        return fill(slot, mode, sys.argv[4])
    if op == 'replace':
        before = capacity()
        assert before['blocks'] == 0 and (mode == 'blocks' or before['inodes'] == 0)
        os.replace(claim / '.qa-staged', slot)
        sync(claim)
        assert slot.stat().st_nlink == 1
        return dict(directory=claim.stat().st_ino, inode=slot.stat().st_ino,
                    sha256=hashlib.sha256(slot.read_bytes()).hexdigest(), capacity=capacity())
    if op == 'release':
        before = capacity()
        assert (filler / 'blocks').is_file()
        shutil.rmtree(filler)
        (claim / '.qa-old-pin').unlink()
        sync(claim)
        sync(volume)
        return dict(before=before, after=capacity())
    if op == 'capacity':
        return capacity()
    raise ValueError(op)


if __name__ == '__main__':
    print(json.dumps(main()))
