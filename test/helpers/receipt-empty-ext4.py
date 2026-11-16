"""Reserve or release the final receipt inode on the isolated acceptance disk."""
import json
import os
from pathlib import Path
import runpy
import shutil
import sys

helpers = runpy.run_path(str(Path(__file__).with_name('receipt-unlink-ext4.py')))
volume = helpers['VOLUME']
stats = os.statvfs(volume)
mount = next((line for line in Path('/proc/self/mountinfo').read_text().splitlines()
              if line.split()[4] == str(volume)), '')
if (' - ext4 ' not in mount or not (volume / '.qa-isolated-volume').is_file()
        or not 0 < stats.f_blocks * stats.f_frsize <= 32 * 1024 * 1024
        or not 0 < stats.f_files <= 8192):
    raise RuntimeError('Requires the marked bounded ext4 acceptance volume')

def sync_dir(directory):
    fd = os.open(directory, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

folder = volume / '.qa-empty-exit-fill'
operation = sys.argv[1]
if operation == 'fill':
    folder.mkdir()
    (folder / 'one-inode').touch(exist_ok=False)
    fd = os.open(folder / 'blocks', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_SYNC, 0o600)
    try:
        helpers['fill_inodes'](folder)
        helpers['fill_blocks'](fd)
    finally:
        os.close(fd)
    sync_dir(folder)
    sync_dir(volume)
elif operation == 'lend':
    (folder / 'one-inode').unlink()
    sync_dir(folder)
elif operation == 'release':
    shutil.rmtree(folder)
    sync_dir(volume)
elif operation != 'inspect':
    raise ValueError(operation)

state = helpers['capacity']()
if operation in ('fill', 'lend'):
    assert state == {'blocks': 0, 'inodes': int(operation == 'lend')}, state
elif operation == 'release':
    assert min(state.values()) > 0, state
print(json.dumps(dict(**state, boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                      mount=mount)))
