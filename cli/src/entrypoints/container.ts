#!/usr/bin/env node
import { translate } from '../shared/i18n/index';
import { createContext } from '../internal/runtime/context';
import { withCommandCancellation } from '../internal/runtime/cancellation';
import { runContainer } from '../internal/runtime/containerRuntime';

const event = (value: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
void withCommandCancellation(async (signal) => {
  if (process.argv.length > 2)
    throw new Error(translate(process.env, '容器入口仅接受通过环境变量配置。'));
  return runContainer(
    createContext({}, { ...process.env, QL_DIR: process.env.QL_DIR || '/ql' }),
    signal,
    { event },
  );
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: 'error',
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  },
);
