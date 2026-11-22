import { readFileSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';

// Legacy runs can outlive a scheduler restart without an active trigger receipt.
export function hasLiveCronProcess(status?: number, pid?: number | null) {
  if (status !== 0 || !pid || pid < 0) return false; // CrontabStatus.running
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function readBsdProcessField(pid: number, field: 'lstart' | 'ppid') {
  const result = spawnSync('ps', ['-p', String(pid), '-o', field + '='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  // ENOENT from spawning ps refers to the executable, not the target PID.
  if (result.error)
    throw new Error('Cannot run ps: ' + result.error.message, {
      cause: result.error,
    });
  const value = result.stdout.trim();
  if (result.status === 0 && value) return value;
  // BSD ps exits 1 without output when the selected PID has already exited.
  if (result.status === 1 && !value && !result.stderr.trim())
    throw Object.assign(new Error('Process has exited'), { code: 'ESRCH' });
  throw new Error(
    `Cannot read ${field} for PID ${pid}: ${
      result.stderr.trim() || result.signal || 'ps status ' + result.status
    }`,
  );
}

export function systemOwner(pid: number) {
  if (process.platform !== 'linux') {
    // BSD crontab installations have no procfs. ps exposes the process birth time.
    process.kill(pid, 0);
    const birth = readBsdProcessField(pid, 'lstart');
    return `crond:${pid}:${birth}`;
  }
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (['Z', 'X', 'x'].includes(fields[0]))
    throw Object.assign(new Error('Process has exited'), { code: 'ESRCH' });
  const startTicks = fields[19];
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  return `crond:${pid}:${startTicks}:${boot}`;
}

let linuxClockTicks: number | undefined;

// A start packet may arrive after its PID was recycled, before the replacement reports.
export function legacyProcessOwner(
  pid: number,
  started: number,
): string | undefined {
  try {
    const identity = systemOwner(pid);
    const birth = identity.slice(`crond:${pid}:`.length);
    let bornAt: number;
    if (process.platform === 'linux') {
      linuxClockTicks ??= Number(
        execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }),
      );
      const boot = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
      if (!boot || !(linuxClockTicks > 0))
        throw new Error('Cannot read process birth time');
      bornAt = Number(boot[1]) + Number(birth.split(':')[0]) / linuxClockTicks;
    } else {
      bornAt = Date.parse(birth + ' UTC') / 1000;
    }
    // Both the callback and Linux boot time have one-second precision.
    return Math.floor(bornAt) <= started + 1 ? identity : undefined;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code!))
      return undefined;
    throw error;
  }
}

// PID 1 survives worker restarts, but changes when a container or Linux host restarts.
export function pidNamespaceOwner() {
  return process.platform === 'linux' ? systemOwner(1) : null;
}

// psTree enumerates asynchronously. Reject a PID already reparented or recycled
// between enumeration and the birth-token snapshot.
export function isProcessDescendant(pid: number, root: number) {
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    if (pid === root) return true;
    seen.add(pid);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } else {
      pid = Number(readBsdProcessField(pid, 'ppid'));
    }
  }
  return false;
}

// For an individual legacy instance the task ID alone also matches its siblings.
export function verifyCronProcess(
  pid: number,
  cronId: number,
  identity?: string | null,
  started?: number,
  instance?: { logPath?: string },
) {
  const conflict = () =>
    Object.assign(new Error('Task process identity could not be verified'), {
      status: 409,
    });
  if (!Number.isInteger(pid) || pid <= 1) throw conflict();
  if (identity) {
    // A birth token for this PID proves the original process is gone if the
    // kernel now reports a different birth. Access errors remain retryable.
    if (!identity.startsWith(`crond:${pid}:`)) throw conflict();
    let current: string;
    try {
      current = systemOwner(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw Object.assign(new Error('Command already exited'), {
          code: 'ESRCH',
        });
      throw error;
    }
    if (current !== identity)
      throw Object.assign(new Error('Command PID was reused'), {
        code: 'PID_REUSED',
        status: 409,
      });
    return current;
  }
  try {
    if (process.platform === 'linux') {
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (
        instance &&
        (!instance.logPath ||
          instance.logPath === '/dev/null' ||
          !env.includes('real_log_path=' + instance.logPath))
      )
        throw conflict();
      if (env.includes('ID=' + cronId) && started) {
        const boot = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
        const birth = systemOwner(pid);
        const ticks = Number(birth.split(':')[2]);
        const hz = Number(
          execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }),
        );
        if (
          boot &&
          hz > 0 &&
          Math.floor(Number(boot[1]) + ticks / hz) <= started + 1
        )
          return birth;
      }
    }
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code!)) {
      // Distinguish a completed child whose receipt is still being written
      // from a live PID with an unverifiable identity.
      try {
        systemOwner(pid);
      } catch (probe) {
        if (
          ['ENOENT', 'ESRCH'].includes((probe as NodeJS.ErrnoException).code!)
        )
          throw Object.assign(new Error('Command already exited'), {
            code: 'ESRCH',
          });
      }
    }
  }
  throw conflict();
}

// After a stop worker exits, descendants may already have been adopted by PID 1.
// A saved birth identity still identifies them; walking the dead root no longer can.
export async function finishStoppedTree(
  identities: string[],
  signalledAt?: number | null,
) {
  const surviving = () =>
    identities.flatMap((identity) => {
      const pid = Number(identity.split(':')[1]);
      if (!Number.isSafeInteger(pid) || pid <= 1)
        throw new Error('Invalid saved process identity');
      try {
        return systemOwner(pid) === identity ? [pid] : [];
      } catch (error) {
        if (
          ['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code!)
        )
          return [];
        throw error;
      }
    });
  const remainingGrace = Math.min(
    1000,
    Math.max(0, (signalledAt ?? Date.now()) + 1000 - Date.now()),
  );
  const graceDeadline = Date.now() + remainingGrace;
  while (surviving().length) {
    const remaining = graceDeadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(20, remaining)),
    );
  }
  if (!surviving().length) return;
  // Revalidate each PID immediately before signalling, including after the grace period.
  for (const identity of identities) {
    const pid = Number(identity.split(':')[1]);
    try {
      if (systemOwner(pid) === identity) process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (!['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code!))
        throw error;
    }
  }
  const deadline = Date.now() + 1000;
  while (surviving().length) {
    if (Date.now() >= deadline)
      throw new Error('Stopped process tree did not exit');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
