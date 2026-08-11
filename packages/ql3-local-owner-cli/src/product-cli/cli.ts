#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';

import { resolveQingLong3ProductCommand } from './productCommand';

const FORWARDED_SIGNALS = Object.freeze([
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
] as const);

export interface QingLong3ProductSignalChild {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
}

export interface QingLong3ProductSignalHost {
  on(signal: NodeJS.Signals, handler: () => void): unknown;
  off(signal: NodeJS.Signals, handler: () => void): unknown;
}

export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const number = constants.signals[signal];
  return typeof number === 'number' ? 128 + number : 1;
}

function lowSensitivityFailure(
  code: string,
  message: string,
): Readonly<Record<string, string | number>> {
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-product-cli',
    code,
    message,
  });
}

export function forwardSignals(
  child: QingLong3ProductSignalChild,
  signalHost: QingLong3ProductSignalHost = process,
): () => void {
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    signalHost.on(signal, handler);
    return Object.freeze({ signal, handler });
  });
  return () => {
    for (const { signal, handler } of handlers) {
      signalHost.off(signal, handler);
    }
  };
}

function invoke(targetFilePath: string, argv: readonly string[]): void {
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [targetFilePath, ...argv], {
      stdio: 'inherit',
      env: process.env,
      shell: false,
      windowsHide: true,
    });
  } catch {
    process.stderr.write(
      `${JSON.stringify(
        lowSensitivityFailure(
          'QL3_PRODUCT_COMMAND_START_FAILED',
          'QingLong 3.0 product command could not start',
        ),
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const removeSignalHandlers = forwardSignals(child);
  let settled = false;
  const settle = (exitCode: number): void => {
    if (settled) return;
    settled = true;
    removeSignalHandlers();
    process.exitCode = exitCode;
  };
  child.once('error', () => {
    process.stderr.write(
      `${JSON.stringify(
        lowSensitivityFailure(
          'QL3_PRODUCT_COMMAND_START_FAILED',
          'QingLong 3.0 product command could not start',
        ),
      )}\n`,
    );
    settle(1);
  });
  child.once('close', (code, signal) => {
    settle(code ?? signalExitCode(signal));
  });
}

function main(argv: readonly string[]): void {
  try {
    const resolution = resolveQingLong3ProductCommand(argv, __dirname);
    if (resolution.kind === 'help' || resolution.kind === 'version') {
      process.stdout.write(`${resolution.output}\n`);
      return;
    }
    if (resolution.kind === 'invalid') {
      process.stderr.write(
        `${JSON.stringify(
          lowSensitivityFailure(resolution.code, resolution.message),
        )}\n`,
      );
      process.exitCode = 64;
      return;
    }
    invoke(resolution.targetFilePath, resolution.argv);
  } catch {
    process.stderr.write(
      `${JSON.stringify(
        lowSensitivityFailure(
          'QL3_PRODUCT_CLI_INSTALLATION_INVALID',
          'QingLong 3.0 product command installation is invalid',
        ),
      )}\n`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
