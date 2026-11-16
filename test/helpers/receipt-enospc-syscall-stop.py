"""Hold a Linux test supervisor at syscall exit, before it can handle ENOSPC."""
import ctypes
import errno
import json
import os
from pathlib import Path
import platform
import signal
import sys

PTRACE_PEEKDATA = 2
PTRACE_SYSCALL = 24
PTRACE_SEIZE = 0x4206
PTRACE_INTERRUPT = 0x4207
PTRACE_GET_SYSCALL_INFO = 0x420e

pid = int(sys.argv[1])
receipt = sys.argv[2]
control = Path(sys.argv[3])
if control.parent != Path('/tmp/journal-qa') or not receipt.isascii() or not receipt.replace('-', '').isalnum():
    raise ValueError('Requires isolated fixture control path and execution ID')
if b'cron-command.py' not in Path(f'/proc/{pid}/cmdline').read_bytes():
    raise ValueError('Expected the real cron supervisor')
openat = {'aarch64': 56, 'x86_64': 257}[platform.machine()]
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
libc.ptrace.restype = ctypes.c_long

def ptrace(op, addr=0, data=0):
    ctypes.set_errno(0)
    rc = libc.ptrace(op, pid, addr, data)
    if rc == -1 and ctypes.get_errno():
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return rc

def path_at(addr):
    data = bytearray()
    word = ctypes.sizeof(ctypes.c_long)
    for offset in range(0, 4096, word):
        data.extend(ptrace(PTRACE_PEEKDATA, addr + offset).to_bytes(word, sys.byteorder, signed=True))
        if 0 in data:
            return os.fsdecode(bytes(data[:data.index(0)]))
    raise RuntimeError('Unterminated pathname')

def publish(suffix, value):
    with Path(str(control) + suffix).open('x') as out:
        json.dump(value, out)
        out.flush()
        os.fsync(out.fileno())

# TRACESYSGOOD identifies syscall stops. EXITKILL prevents an accidental tracer
# exit from releasing the supervisor into its retry path before the VM cut.
ptrace(PTRACE_SEIZE, 0, 1 | (1 << 20))
ptrace(PTRACE_INTERRUPT)
assert os.WIFSTOPPED(os.waitpid(pid, 0)[1])
publish('.ready', {'supervisor': pid, 'tracer': os.getpid()})
deliver = 0
target = None
while True:
    ptrace(PTRACE_SYSCALL, 0, deliver)
    _, status = os.waitpid(pid, 0)
    if not os.WIFSTOPPED(status):
        raise RuntimeError(f'Supervisor exited early, wait status {status}')
    deliver = os.WSTOPSIG(status)
    if deliver != signal.SIGTRAP | 0x80:
        continue
    deliver = 0
    # linux/ptrace.h: op at byte 0, entry.nr / exit.rval at 24,
    # entry.args at 32. Request the kernel-reported stop type, independent of
    # whether attachment happened inside a previous syscall.
    info = ctypes.create_string_buffer(88)
    ptrace(PTRACE_GET_SYSCALL_INFO, len(info), ctypes.addressof(info))
    raw = info.raw
    number = int.from_bytes(raw[24:32], sys.byteorder, signed=True)
    if raw[0] == 1:
        target = None
        if number == openat:
            flags = int.from_bytes(raw[48:56], sys.byteorder)
            if flags & os.O_EXCL and flags & os.O_CREAT:
                name = path_at(int.from_bytes(raw[40:48], sys.byteorder))
                if name.startswith('/ql/data/db/cron-exits/.pending.' + receipt + '.full-'):
                    target = name
    elif raw[0] == 2 and target:
        if number != -errno.ENOSPC:
            raise RuntimeError(f'First marker creation returned {number}')
        children = Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
        assert not children, children
        publish('.stopped', dict(supervisor=pid, tracer=os.getpid(), receipt=receipt, path=target,
                                 syscall='openat', result=number, children=children, stop='syscall-exit'))
        while True:
            signal.pause()
