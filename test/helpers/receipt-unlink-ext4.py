"""Measure real unlink outcomes on the isolated Docker acceptance disk."""
import errno
import json
import os
from pathlib import Path
import tempfile

VOLUME = Path('/ql/data/db')
PAYLOAD = b'{"code":23,"signal":null,"time":1790000000123}'


def capacity():
    stats = os.statvfs(VOLUME)
    return {'blocks': stats.f_bavail, 'inodes': stats.f_favail}


def fill_inodes(directory):
    try:
        for index in range(os.statvfs(VOLUME).f_files + 1):
            (directory / str(index)).touch(exist_ok=False)
    except OSError as error:
        if error.errno != errno.ENOSPC:
            raise
    assert capacity()['inodes'] == 0


def fill_blocks(fd):
    block_size = os.statvfs(VOLUME).f_frsize
    for size in (64 * 1024, block_size):
        data = bytes(size)
        try:
            while True:
                os.write(fd, data)
        except OSError as error:
            if error.errno != errno.ENOSPC:
                raise
    os.fsync(fd)
    assert capacity()['blocks'] == 0


def observe(mode):
    with tempfile.TemporaryDirectory(prefix='.qa-unlink-', dir=VOLUME) as folder:
        root = Path(folder)
        linked, opened, closed = (root / name for name in ('linked', 'opened', 'closed'))
        for file in (linked, opened, closed):
            file.write_bytes(PAYLOAD)
        alias = root / 'other-link'
        os.link(linked, alias)
        filler = os.open(root / 'blocks', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_SYNC, 0o600)
        try:
            if mode != 'blocks':
                fill_inodes(root)
            if mode != 'inodes':
                fill_blocks(filler)
            with opened.open('rb') as live:
                rows = []
                for file in (linked, opened, closed):
                    before = capacity()
                    assert mode == 'inodes' or before['blocks'] == 0
                    assert mode == 'blocks' or before['inodes'] == 0
                    links = file.stat().st_nlink
                    try:
                        file.unlink()
                        result = 'success'
                        assert not file.exists()
                    except OSError as error:
                        if error.errno != errno.ENOSPC:
                            raise
                        result = 'ENOSPC'
                        assert file.read_bytes() == PAYLOAD
                    rows.append({'layout': file.name, 'linksBefore': links, 'result': result,
                                 'before': before, 'after': capacity()})
                assert live.read() == PAYLOAD and alias.read_bytes() == PAYLOAD
            return rows
        finally:
            os.close(filler)


if __name__ == '__main__':
    mount = next((line.split(' - ')[1].split()[0] for line in Path('/proc/self/mountinfo').read_text().splitlines()
                  if line.split()[4] == str(VOLUME)), None)
    stats = os.statvfs(VOLUME)
    if (mount != 'ext4' or not (VOLUME / '.qa-isolated-volume').is_file()
            or not 0 < stats.f_blocks * stats.f_frsize <= 32 * 1024 * 1024
            or not 0 < stats.f_files <= 8192):
        raise RuntimeError('Requires the marked bounded ext4 acceptance volume')
    print(json.dumps({mode: observe(mode) for mode in ('blocks', 'inodes', 'both')}))
