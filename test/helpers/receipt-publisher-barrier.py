"""Interrupt the real Python supervisor at the requested publication boundary."""
import os
import pathlib
import runpy
import signal
import sys
import tempfile
import time

stage, finish, script, marker, owner = sys.argv[1:]
time.time_ns = lambda: int(finish) * 1_000_000


def checkpoint(point):
    if point == stage:
        ready = pathlib.Path(os.environ['QL_DATA_DIR']) / 'publisher-ready'
        pending = ready.with_suffix('.tmp')
        pending.write_text(point)
        pending.replace(ready)
        signal.pause()


open_temp = tempfile.NamedTemporaryFile
writes = 0


class TempFile:
    def __init__(self, **kwargs):
        global writes
        self.first = writes == 0
        writes += 1
        checkpoint('before-write' if self.first else 'before-mirror')
        self.file = open_temp(**kwargs)

    def __enter__(self):
        self.file.__enter__()
        if not self.first and stage == 'partial':
            self.file.write('{"code":')
            self.file.flush()
            checkpoint('partial')
        return self.file

    def __exit__(self, *args):
        self.file.__exit__(*args)
        checkpoint('after-write' if self.first else 'after-mirror')


link = os.link


def publish(source, dest):
    checkpoint('before-link')
    link(source, dest)
    checkpoint('after-link')


tempfile.NamedTemporaryFile = TempFile
os.link = publish
sys.argv = [script, 'exit 23', owner, marker, '', '']
main = runpy.run_path(script)['main']
status = main()
checkpoint('published')
sys.exit(status)
