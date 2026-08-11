import fs from 'fs/promises';
import path from 'path';
import dayjs from 'dayjs';
import config from '../../../config';
import { getUniqPath } from '../../../config/util';
import { sequelize } from '../../../data';
import { logStreamManager } from '../../../shared/logStreamManager';
import {
  ManualPrimaryRuntime,
  type ManualPrimaryLogFiles,
  type PreparedManualPrimaryLog,
} from '../../application/manualPrimaryRuntime';
import type { ManualPrimaryStartInput } from '../../compatibility/manualPrimaryExecutionBridge';
import { createLegacyLogOutputRef } from '../../compatibility/legacyLogOutputRef';
import type { RuntimeRolloutPolicy } from '../../domain/runtimeRollout';
import { PrimaryCronProjection } from '../legacy-sequelize/primaryCronProjection';
import { LegacySequelizeProjectedRunRepository } from '../legacy-sequelize/projectedRunRepository';
import { LocalProcessExecutor } from '../local-process/localProcessExecutor';
import { enableDurableLocalProcessOutput } from '../local-process/durableLocalProcessOutput';
import { CompletionReceiptFileStore } from '../fs/completionReceiptFileStore';
import type { CompletionReceiptJournal } from '../../ports/completionReceiptJournal';

export const DEFAULT_COMPLETION_RECEIPT_ROOT = path.join(
  config.dataPath,
  'runtime',
  'completion-receipts',
);
export const DEFAULT_LOCAL_PROCESS_LAUNCHER_PATH = path.join(
  config.rootPath,
  'shell',
  'ql3-launcher.sh',
);

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function relativeLogDirectory(root: string, value: string): string {
  const candidate = path.isAbsolute(value) ? value : path.resolve(root, value);
  if (!isWithin(root, candidate)) {
    throw new Error('Manual Primary log directory escapes the configured root');
  }
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  if (!relative || relative === '.') {
    throw new Error('Manual Primary log directory must be below the log root');
  }
  return relative;
}

export class LegacyManualPrimaryLogFiles implements ManualPrimaryLogFiles {
  private readonly completionReceipts: CompletionReceiptFileStore;
  private readonly completionReceiptRoot: string;

  constructor(
    private readonly logRoot = path.resolve(config.logPath),
    completionReceiptRoot = DEFAULT_COMPLETION_RECEIPT_ROOT,
    private readonly completionReceiptJournal?: Pick<
      CompletionReceiptJournal,
      'resolve'
    >,
  ) {
    this.completionReceiptRoot = path.resolve(completionReceiptRoot);
    this.completionReceipts = new CompletionReceiptFileStore(
      this.completionReceiptRoot,
    );
  }

  async prepare(
    input: ManualPrimaryStartInput,
  ): Promise<PreparedManualPrimaryLog> {
    const configured =
      !input.cron.logName || input.cron.logName === '/dev/null'
        ? await getUniqPath(input.cron.command, String(input.cron.id))
        : input.cron.logName;
    const directory = relativeLogDirectory(this.logRoot, configured);
    const logPath = path.posix.join(
      directory,
      dayjs(input.acceptedAtMs).format('YYYY-MM-DD-HH-mm-ss-SSS') + '.log',
    );
    createLegacyLogOutputRef(logPath);
    const absolutePath = path.resolve(this.logRoot, ...logPath.split('/'));
    if (!isWithin(this.logRoot, absolutePath)) {
      throw new Error('Manual Primary log file escapes the configured root');
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const output = enableDurableLocalProcessOutput(
      {
        async write(output) {
          await logStreamManager.write(
            absolutePath,
            Buffer.from(output.chunk).toString('utf8'),
          );
        },
      },
      {
        outputFilePath: absolutePath,
        completionReceiptRoot: this.completionReceiptRoot,
      },
    );
    const completionReceipts = this.completionReceipts;
    const completionReceiptJournal = this.completionReceiptJournal;
    return {
      logPath,
      output,
      async completionCommitted(attemptId) {
        await completionReceipts.remove(attemptId);
        await completionReceiptJournal?.resolve(attemptId);
      },
      async close() {
        await logStreamManager.closeStream(absolutePath);
      },
    };
  }
}

/** Legacy factory retained for focused tests; production activation uses the
 * shared lifecycle stack in defaultManualPrimaryActivation.ts. */
export function createDefaultManualPrimaryRuntime(
  rollout: RuntimeRolloutPolicy,
): ManualPrimaryRuntime {
  const repository = new LegacySequelizeProjectedRunRepository(sequelize, [
    new PrimaryCronProjection(sequelize),
  ]);
  return new ManualPrimaryRuntime(
    repository,
    new LocalProcessExecutor({
      durableLauncherPath: DEFAULT_LOCAL_PROCESS_LAUNCHER_PATH,
    }),
    rollout,
    new LegacyManualPrimaryLogFiles(),
  );
}
