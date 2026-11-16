"""Wait for launch authorization, then preserve a command's exit across worker restarts."""
import errno
import os
import subprocess
import sys
import threading
import time


def relay(source, destination):
    with source:
        for chunk in iter(lambda: os.read(source.fileno(), 65536), b''):
            if destination is None:
                continue
            remaining = memoryview(chunk)
            try:
                while remaining:
                    remaining = remaining[os.write(destination, remaining):]
            except OSError:
                # The worker stopped reading. Continue draining so the user's
                # command and its log wrapper can still report their real exit.
                destination = None


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    command, owner, marker, node, reporter = sys.argv[1:6]
    if sys.stdin.buffer.read() != b'run\n':
        return 125
    child = subprocess.Popen(['/bin/bash', '-c', command], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if sys.argv[6:] == ['report-start']:
        try:
            with os.fdopen(3, 'wb', buffering=0) as timing:
                timing.write(str(time.time_ns() // 1000000).encode('ascii'))
        except OSError:
            pass
    streams = [threading.Thread(target=relay, args=(child.stdout, 1)),
               threading.Thread(target=relay, args=(child.stderr, 2))]
    for stream in streams:
        stream.start()
    status = child.wait()
    finished = time.time_ns() // 1000000

    import hashlib
    import json
    import signal

    signame = None
    if status < 0:
        try:
            signame = signal.Signals(-status).name
        except ValueError:
            signame = 'SIG' + str(-status)
    code = status if status >= 0 else None
    fields = [os.environ.get('QL_TRIGGER_ID'), code, signame, finished]
    checksum = hashlib.sha256(json.dumps(fields, separators=(',', ':')).encode('ascii')).hexdigest()
    receipt = json.dumps({'code': code, 'signal': signame, 'time': finished,
                          'version': 1, 'checksum': checksum}, separators=(',', ':'))
    needs_report = False
    if marker:
        try:
            os.makedirs(os.path.dirname(marker), mode=0o700, exist_ok=True)
            import tempfile
            prefix = '.pending.' + os.path.basename(marker) + '.'
            directory = os.path.dirname(marker)
            stamp = prefix + 'full-' + str(signame or code) + '-' + str(finished) + '-' + checksum + '-'
            # An empty file publishes the verified result in one directory
            # operation, before any JSON body can be interrupted or run short.
            with tempfile.NamedTemporaryFile(dir=directory, prefix=stamp, delete=False):
                pass
            # Sync the new entry and the entry for cron-exits itself before
            # treating the marker as published or suppressing a full-volume error.
            sync_directory(directory)
            sync_directory(os.path.dirname(directory))
            try:
                if os.statvfs(directory).f_bavail:
                    with tempfile.NamedTemporaryFile(dir=directory, prefix=stamp, mode='w', delete=False) as out:
                        out.write(receipt)
                        out.flush()
                        os.fsync(out.fileno())
                    try:
                        os.link(out.name, marker)
                    except FileExistsError:
                        import secrets
                        while True:
                            try:
                                os.link(out.name, os.path.join(directory, prefix + secrets.token_hex(16)))
                                break
                            except FileExistsError:
                                continue
                            except FileNotFoundError:
                                break
                    except FileNotFoundError:
                        pass
                    sync_directory(directory)
            except OSError as error:
                if error.errno not in (errno.ENOSPC, errno.EDQUOT):
                    raise
        except OSError as error:
            needs_report = True
            print('[scheduler] Could not save command exit:', error, file=sys.stderr)
    if needs_report or os.getppid() != int(owner):
        env = os.environ.copy()
        env.pop('NODE_OPTIONS', None)
        # Even with a live parent its child-close callback has no exit timestamp.
        # Keep the observed tuple while both the journal and SQLite are full.
        while subprocess.run([node, reporter, receipt], env=env, check=False).returncode == 75 and needs_report:
            time.sleep(2)
    for stream in streams:
        stream.join()
    if status < 0:
        if -status not in (signal.SIGKILL, signal.SIGSTOP):
            signal.signal(-status, signal.SIG_DFL)
        os.kill(os.getpid(), -status)
    return status


if __name__ == '__main__':
    sys.exit(main())
