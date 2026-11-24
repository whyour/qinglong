import { join } from 'path';
import { existsSync } from 'fs';
import { receiptPath } from '../settlement/exitReceipt.cjs';
import { spawn } from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { Readable } from 'stream';

// A managed command waits on its parent's pipe. EOF before authorization exits
// without interpreting the command, even when the worker is killed by SIGKILL.
export function spawnCronCommand(
  command: string,
  triggerId?: string,
  onCommandStart?: (at: number) => void,
  outputPath?: string,
) {
  if (!triggerId) return spawn(command, { shell: '/bin/bash' });
  const sourceScript = join(__dirname, '../../../shell/cron-command.py');
  const supervisor = existsSync(sourceScript)
    ? sourceScript
    : join(process.env.QL_DIR!, 'shell/cron-command.py');
  const args = [
    '-I',
    '-S',
    supervisor,
    command,
    String(process.pid),
    receiptPath(triggerId) || '',
    process.execPath,
    join(__dirname, '../../shared/managedExit.cjs'),
  ];
  if (onCommandStart) args.push('report-start');
  if (outputPath) args.push('log-output', outputPath);
  const child = spawn('python3', args, {
    env: {
      ...process.env,
      QL_TRIGGER_ID: triggerId,
      QL_SUPERVISOR_RECEIPT: '1',
      QL_SUPERVISOR_LOG_BOUND: outputPath ? '1' : '',
    },
    stdio: onCommandStart ? ['pipe', 'pipe', 'pipe', 'pipe'] : 'pipe',
  }) as ChildProcessWithoutNullStreams;
  if (onCommandStart && child.stdio[3]) {
    const timing = child.stdio[3] as Readable;
    let stamp = '';
    timing.setEncoding('ascii').on('data', (chunk) => {
      stamp += chunk;
    });
    timing.once('end', () => {
      if (/^\d{13}$/.test(stamp)) onCommandStart(Number(stamp));
    });
    timing.on('error', () => {}); // Missing telemetry must not change the command result.
  }
  // A concurrent stop can close the pipe before the authorization write.
  child.stdin.on('error', () => {});
  return child;
}

export function releaseCronCommand(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  return new Promise((resolve, reject) =>
    child.stdin.end('run\n', (error?: Error) =>
      error ? reject(error) : resolve(),
    ),
  );
}
