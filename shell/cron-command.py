"""Wait for launch authorization, then preserve a command's exit across worker restarts."""
import errno
import os
import sys
import threading
import time


def relay(source, destination, on_error=None):
    with source:
        for chunk in iter(lambda: os.read(source.fileno(), 65536), b''):
            if destination is None:
                continue
            remaining = memoryview(chunk)
            try:
                while remaining:
                    remaining = remaining[os.write(destination, remaining):]
            except OSError as error:
                # The worker stopped reading. Continue draining so the user's
                # command and its log wrapper can still report their real exit.
                destination = None
                if on_error is not None:
                    on_error(error)


def report_log_error(error):
    # A missing HTTP worker must not turn an output failure into a task failure.
    try:
        os.write(2, ('[scheduler] Could not write command log: ' + str(error) + '\n').encode('utf-8'))
    except OSError:
        pass


def relay_log(source, log_path):
    destination = None
    try:
        try:
            destination = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o666)
        except OSError as error:
            report_log_error(error)
        # Do not forward these bytes to the worker: that would duplicate the log
        # and reintroduce a dependency on the worker continuing to read stdout.
        relay(source, destination, report_log_error)
    finally:
        if destination is not None:
            try:
                os.close(destination)
            except OSError as error:
                report_log_error(error)


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def start_log_relay(source, log_path):
    # Keep draining after the supervisor or its task tree is terminated. The
    # relay owns no execution permission and exits at pipe EOF. Double-fork
    # before launching Bash so it is outside the task's cancellation tree.
    ready, done = os.pipe()
    try:
        intermediate = os.fork()
    except BaseException:
        os.close(ready)
        os.close(done)
        raise
    if intermediate == 0:
        try:
            os.close(ready)
            os.setsid()
            if os.fork():
                os._exit(0)
            # Never retain the authorization/telemetry pipes, stdout, or the
            # write end of our own input. EOF must mean all writers have gone.
            keep = {source.fileno(), done, 2}
            if sys.platform == 'linux':
                for entry in os.listdir('/proc/self/fd'):
                    fd = int(entry)
                    if fd not in keep:
                        try:
                            os.close(fd)
                        except OSError as error:
                            if error.errno != errno.EBADF:
                                raise
            else:
                import resource
                previous = 0
                for fd in sorted(keep):
                    os.closerange(previous, fd)
                    previous = fd + 1
                maximum = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
                if maximum == resource.RLIM_INFINITY:
                    maximum = os.sysconf('SC_OPEN_MAX')
                os.closerange(previous, maximum)
            os.write(done, b'R')
            relay_log(source, log_path)
            # EPIPE is expected if the supervisor was killed while we drained.
            try:
                os.write(done, b'D')
            except BrokenPipeError:
                pass
        except BaseException as error:
            report_log_error(error)
        finally:
            os._exit(0)
    os.close(done)
    source.close()
    os.waitpid(intermediate, 0)
    if os.read(ready, 1) != b'R':
        os.close(ready)
        raise OSError('Could not start command log relay')

    def join():
        try:
            if os.read(ready, 1) != b'D':
                raise OSError('Command log relay ended before draining output')
        finally:
            os.close(ready)

    return join


def spawn_command(command, merged, log_path=None):
    if not log_path:
        return spawn_command_pipes(command, merged)
    read_fd, write_fd = os.pipe()
    source = os.fdopen(read_fd, 'rb')
    join = None
    try:
        # Ready handshake precedes command side effects, including fast writers.
        join = start_log_relay(source, log_path)
        output, error, wait_command = spawn_command_pipes(command, True, write_fd)
    except BaseException:
        os.close(write_fd)
        source.close()
        if join:
            join()
        raise
    os.close(write_fd)

    def wait():
        status = wait_command()
        # A background writer is still part of this run. Keep the supervisor's
        # birth identity, global permit and cancellation target until EOF; only
        # then may main publish a terminal receipt.
        join()
        return status

    return output, error, wait


def spawn_command_pipes(command, merged, destination=None):
    libc = None
    if sys.platform == 'linux':
        import ctypes
        # Both launch paths must adopt orphaned grandchildren. Output EOF is
        # insufficient: a background command can redirect or close its output.
        # The log relay detached before this flag is enabled.
        libc = ctypes.CDLL(None, use_errno=True)
        previous_reaper = ctypes.c_int()
        if libc.prctl(37, ctypes.byref(previous_reaper), 0, 0, 0) != 0 or libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Could not supervise command descendants')
    # Keep native Linux launch without importing subprocess/locale/selectors.
    # File writes belong to the relay: ENOSPC/EFBIG must not reach the script.
    if (sys.platform != 'linux' or not hasattr(os, 'posix_spawn')
            or not hasattr(os, 'waitstatus_to_exitcode')):
        import subprocess
        try:
            child = subprocess.Popen(['/bin/bash', '-c', command], stdin=subprocess.DEVNULL,
                                     stdout=destination if destination is not None else subprocess.PIPE,
                                     stderr=destination if destination is not None else (subprocess.STDOUT if merged else subprocess.PIPE))
        except BaseException:
            if libc is not None:
                libc.prctl(36, previous_reaper.value, 0, 0, 0)
            raise

        def wait_fallback():
            status = child.wait()
            if libc is not None:
                while True:
                    try:
                        os.waitpid(-1, 0)
                    except ChildProcessError:
                        break
            return status

        return child.stdout, child.stderr, wait_fallback

    import signal
    descriptors = []
    try:
        if destination is not None:
            output = error = None
            output_write = error_write = destination
        else:
            output, output_write = os.pipe()
            descriptors.extend((output, output_write))
            if merged:
                error, error_write = None, output_write
            else:
                error, error_write = os.pipe()
                descriptors.extend((error, error_write))
        actions = [(os.POSIX_SPAWN_OPEN, 0, os.devnull, os.O_RDONLY, 0),
                   (os.POSIX_SPAWN_DUP2, output_write, 1),
                   (os.POSIX_SPAWN_DUP2, error_write, 2)]
        # Include the start telemetry pipe and any descriptors inherited from the
        # caller. The readdir descriptor is already closed; skip that stale entry.
        for entry in os.listdir('/proc/self/fd'):
            fd = int(entry)
            if fd < 3:
                continue
            try:
                os.fstat(fd)
            except OSError as exc:
                if exc.errno == errno.EBADF:
                    continue
                raise
            actions.append((os.POSIX_SPAWN_CLOSE, fd))
        defaults = tuple(getattr(signal, name) for name in ('SIGPIPE', 'SIGXFZ', 'SIGXFSZ')
                         if hasattr(signal, name))
        pid = os.posix_spawn('/bin/bash', ['/bin/bash', '-c', command], os.environ,
                             file_actions=actions, setsigdef=defaults)
    except BaseException:
        libc.prctl(36, previous_reaper.value, 0, 0, 0)
        for fd in descriptors:
            os.close(fd)
        raise
    if destination is None:
        os.close(output_write)
        if error_write != output_write:
            os.close(error_write)

    def wait():
        status = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
        while True:
            try:
                os.waitpid(-1, 0)
            except ChildProcessError:
                break
        return status

    return os.fdopen(output, 'rb') if output is not None else None, os.fdopen(error, 'rb') if error is not None else None, wait


def main():
    command, owner, marker, node, reporter = sys.argv[1:6]
    if sys.stdin.buffer.read() != b'run\n':
        return 125
    options = sys.argv[6:]
    report_start = options[:1] == ['report-start']
    if report_start:
        options = options[1:]
    log_path = options[1] if len(options) == 2 and options[0] == 'log-output' else None
    output, error, wait = spawn_command(command, bool(log_path), log_path)
    if report_start:
        try:
            with os.fdopen(3, 'wb', buffering=0) as timing:
                timing.write(str(time.time_ns() // 1000000).encode('ascii'))
        except OSError:
            pass
    streams = (([] if output is None else [threading.Thread(target=relay_log, args=(output, log_path))])
               if log_path else [threading.Thread(target=relay, args=(output, 1)),
                                 threading.Thread(target=relay, args=(error, 2))])
    for stream in streams:
        stream.start()
    status = wait()
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
        import subprocess
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
