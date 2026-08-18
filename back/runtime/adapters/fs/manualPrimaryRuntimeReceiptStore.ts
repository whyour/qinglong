import { randomBytes } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import {
  createManualPrimaryRuntimeReceipt,
  MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE,
  MAX_MANUAL_PRIMARY_RUNTIME_RECEIPT_BYTES,
  parseManualPrimaryRuntimeReceipt,
  transitionManualPrimaryRuntimeReceipt,
  type ManualPrimaryRuntimeProcessIdentity,
  type ManualPrimaryRuntimeReceipt,
  type ManualPrimaryRuntimeReceiptState,
} from '../../domain/manualPrimaryRuntimeReceipt';
import type { ManualPrimaryRuntimeReceiptLifecycle } from '../../ports/manualPrimaryRuntimeReceipt';
import type { RuntimeRolloutLoadAudit } from '../../ports/runtimeRolloutLoader';
import {
  LinuxProcProcessIdentityProvider,
  type LocalProcessIdentityProvider,
} from '../local-process/localProcessIdentity';

export interface ManualPrimaryRuntimeReceiptStoreOptions {
  clock?: { now(): number };
  identityProvider?: LocalProcessIdentityProvider;
  platform?: NodeJS.Platform;
  pid?: number;
  randomId?: () => string;
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}

export class ManualPrimaryRuntimeReceiptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualPrimaryRuntimeReceiptConflictError';
  }
}

export class ManualPrimaryRuntimeReceiptStore
  implements ManualPrimaryRuntimeReceiptLifecycle
{
  private readonly target: string;
  private readonly clock: { now(): number };
  private readonly identityProvider: LocalProcessIdentityProvider;
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly randomId: () => string;
  private current?: ManualPrimaryRuntimeReceipt;

  constructor(
    private readonly root: string,
    private readonly profile: 'edge' | 'standalone',
    options: ManualPrimaryRuntimeReceiptStoreOptions = {},
  ) {
    if (!path.isAbsolute(root)) {
      throw new TypeError(
        'Manual Primary runtime receipt root must be absolute',
      );
    }
    this.target = path.join(root, MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE);
    this.clock = options.clock ?? { now: Date.now };
    this.identityProvider =
      options.identityProvider ?? new LinuxProcProcessIdentityProvider();
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.randomId = options.randomId ?? (() => randomBytes(16).toString('hex'));
  }

  async activated(audit: RuntimeRolloutLoadAudit): Promise<void> {
    if (
      typeof audit.revision !== 'string' ||
      typeof audit.sourceSha256 !== 'string'
    ) {
      throw new TypeError(
        'Accepted rollout audit lacks durable revision or source digest',
      );
    }
    await this.assertRoot();
    const processIdentity = await this.captureProcessIdentity();
    const existing = await this.read();
    await this.assertReplaceable(existing);
    const receipt = createManualPrimaryRuntimeReceipt({
      activationId: this.randomId(),
      profile: this.profile,
      revision: audit.revision,
      rolloutSourceSha256: audit.sourceSha256,
      activatedAtMs: this.now(),
      process: processIdentity,
    });
    await this.write(receipt);
    this.current = receipt;
  }

  async stopping(): Promise<void> {
    await this.transition('stopping');
  }

  async stopped(): Promise<void> {
    await this.transition('stopped');
  }

  async failed(): Promise<void> {
    if (this.current === undefined) return;
    await this.transition('failed');
  }

  private async transition(
    state: Exclude<ManualPrimaryRuntimeReceiptState, 'active'>,
  ): Promise<void> {
    if (this.current === undefined) {
      throw new ManualPrimaryRuntimeReceiptConflictError(
        'Manual Primary runtime receipt was not activated by this process',
      );
    }
    const observed = await this.read();
    if (
      observed === undefined ||
      observed.activationId !== this.current.activationId ||
      observed.receiptSha256 !== this.current.receiptSha256
    ) {
      throw new ManualPrimaryRuntimeReceiptConflictError(
        'Manual Primary runtime receipt ownership changed',
      );
    }
    const next = transitionManualPrimaryRuntimeReceipt(
      this.current,
      state,
      Math.max(this.current.updatedAtMs, this.now()),
    );
    await this.write(next);
    this.current = next;
  }

  private now(): number {
    const value = this.clock.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Manual Primary runtime receipt clock is invalid');
    }
    return value;
  }

  private async captureProcessIdentity(): Promise<ManualPrimaryRuntimeProcessIdentity> {
    const identity = await this.identityProvider.capture(this.pid);
    if (identity !== null) {
      return { kind: 'linux-proc', ...identity };
    }
    if (this.platform === 'linux') {
      throw new Error('Linux process identity is unavailable');
    }
    return { kind: 'portable', platform: this.platform, pid: this.pid };
  }

  private async assertReplaceable(
    existing: ManualPrimaryRuntimeReceipt | undefined,
  ): Promise<void> {
    if (
      existing === undefined ||
      existing.state === 'stopped' ||
      existing.state === 'failed'
    ) {
      return;
    }
    if (existing.process.kind !== 'linux-proc') return;
    const inspection = await this.identityProvider.inspect(existing.process);
    if (inspection.status === 'running') {
      throw new ManualPrimaryRuntimeReceiptConflictError(
        'Another Manual Primary runtime receipt is still live',
      );
    }
    if (!['exited', 'identity_mismatch'].includes(inspection.status)) {
      throw new ManualPrimaryRuntimeReceiptConflictError(
        'Previous Manual Primary runtime identity cannot be disproved',
      );
    }
  }

  private async assertRoot(): Promise<void> {
    const stat = await fs.lstat(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    ) {
      throw new TypeError('Manual Primary runtime receipt root is unsafe');
    }
  }

  private async read(): Promise<ManualPrimaryRuntimeReceipt | undefined> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        this.target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' &&
          stat.uid !== process.getuid()) ||
        stat.size < 2 ||
        stat.size > MAX_MANUAL_PRIMARY_RUNTIME_RECEIPT_BYTES
      ) {
        throw new TypeError('Manual Primary runtime receipt file is unsafe');
      }
      return parseManualPrimaryRuntimeReceipt(
        JSON.parse((await handle.readFile()).toString('utf8')),
      );
    } finally {
      await handle.close();
    }
  }

  private async write(receipt: ManualPrimaryRuntimeReceipt): Promise<void> {
    const temporary = path.join(
      this.root,
      `.ql3-runtime-receipt-${this.pid}-${randomBytes(8).toString('hex')}.tmp`,
    );
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.target);
      await this.bestEffortSyncDirectory();
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch((error) => {
        if (!isCode(error, 'ENOENT')) throw error;
      });
    }
  }

  private async bestEffortSyncDirectory(): Promise<void> {
    try {
      const handle = await fs.open(this.root, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // The atomic state remains valid on filesystems without directory fsync.
    }
  }
}
