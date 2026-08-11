// Credential ownership: persist active Worker certificate material atomically.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  assertWorkerCertificateIdentitySummary,
  validateWorkerCertificateIdentity,
  type WorkerCertificateIdentitySummary,
} from './workerCertificateIdentity';

const MAX_IDENTITY_FILE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 4096;
const GENERATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_GENERATIONS = 8;

export interface WorkerCertificateFileStoreOptions {
  readonly rootDirectory: string;
  readonly retainedGenerations?: number;
}

export interface InstallWorkerCertificateIdentityInput {
  readonly privateKeyPem: string | Buffer;
  readonly certificateChainPem: string | Buffer;
  readonly trustAnchors: readonly (string | Buffer)[];
  readonly now?: number;
  readonly minimumRemainingValidityMs?: number;
}

export interface ActiveWorkerCertificateIdentity
  extends WorkerCertificateIdentitySummary {
  readonly generationId: string;
  readonly installedAtMs: number;
  readonly privateKeyFile: string;
  readonly certificateChainFile: string;
}

export interface InstallWorkerCertificateIdentityResult
  extends ActiveWorkerCertificateIdentity {
  readonly cleanupPending: boolean;
}

export interface WorkerCertificateRenewalState {
  readonly consecutiveFailures: number;
  readonly nextAttemptAtMs: number | null;
  readonly lastAttemptAtMs: number | null;
  readonly lastSuccessAtMs: number | null;
}

export interface WorkerCertificateStore {
  readActive(
    trustAnchors: readonly (string | Buffer)[],
    now?: number,
  ): Promise<ActiveWorkerCertificateIdentity | undefined>;
  install(
    input: InstallWorkerCertificateIdentityInput,
  ): Promise<InstallWorkerCertificateIdentityResult>;
  readRenewalState(): Promise<WorkerCertificateRenewalState>;
  writeRenewalState(state: WorkerCertificateRenewalState): Promise<void>;
}

export interface WorkerCertificateIdentityManifest
  extends WorkerCertificateIdentitySummary {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly installedAtMs: number;
}

interface RenewalStateManifest extends WorkerCertificateRenewalState {
  readonly schemaVersion: 1;
}

export class WorkerCertificateStoreError extends Error {
  constructor(message: string) {
    super(`Worker certificate store is unavailable: ${message}`);
    this.name = 'WorkerCertificateStoreError';
  }
}

function safeNow(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new WorkerCertificateStoreError('observation time is invalid');
  }
  return now;
}

async function safeDirectory(path: string): Promise<void> {
  let existed = true;
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    existed = false;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new WorkerCertificateStoreError('directory metadata is unsafe');
  }
  if (!existed) await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeSyncedFile(
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(path, flags);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > maximumBytes ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new WorkerCertificateStoreError('file metadata is unsafe');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
      bytes.fill(0);
      throw new WorkerCertificateStoreError('file size is unsafe');
    }
    return bytes;
  } catch (error) {
    if (error instanceof WorkerCertificateStoreError) throw error;
    throw new WorkerCertificateStoreError('file is unavailable');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertSafeExistingDirectory(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new WorkerCertificateStoreError('directory is unavailable');
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new WorkerCertificateStoreError('directory metadata is unsafe');
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index])
  );
}

function identityManifest(value: unknown): WorkerCertificateIdentityManifest {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'certificateSha256',
      'generationId',
      'installedAtMs',
      'notAfterMs',
      'notBeforeMs',
      'publicKeySpkiSha256',
      'schemaVersion',
      'serialNumber',
    ])
  ) {
    throw new WorkerCertificateStoreError('identity manifest is invalid');
  }
  const candidate = value as Partial<WorkerCertificateIdentityManifest>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.generationId !== 'string' ||
    !GENERATION_PATTERN.test(candidate.generationId) ||
    !Number.isSafeInteger(candidate.installedAtMs) ||
    Number(candidate.installedAtMs) < 0
  ) {
    throw new WorkerCertificateStoreError('identity manifest is invalid');
  }
  assertWorkerCertificateIdentitySummary(
    candidate as WorkerCertificateIdentitySummary,
  );
  return Object.freeze(candidate as WorkerCertificateIdentityManifest);
}

function renewalStateManifest(value: unknown): RenewalStateManifest {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'consecutiveFailures',
      'lastAttemptAtMs',
      'lastSuccessAtMs',
      'nextAttemptAtMs',
      'schemaVersion',
    ])
  ) {
    throw new WorkerCertificateStoreError('renewal state is invalid');
  }
  const candidate = value as Partial<RenewalStateManifest>;
  const optionalTime = (time: unknown): boolean =>
    time === null || (Number.isSafeInteger(time) && Number(time) >= 0);
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.consecutiveFailures) ||
    Number(candidate.consecutiveFailures) < 0 ||
    Number(candidate.consecutiveFailures) > 16 ||
    !optionalTime(candidate.nextAttemptAtMs) ||
    !optionalTime(candidate.lastAttemptAtMs) ||
    !optionalTime(candidate.lastSuccessAtMs)
  ) {
    throw new WorkerCertificateStoreError('renewal state is invalid');
  }
  return Object.freeze(candidate as RenewalStateManifest);
}

async function parseJsonFile<T>(
  path: string,
  parser: (value: unknown) => T,
): Promise<T> {
  const bytes = await readBoundedFile(path, MAX_MANIFEST_BYTES);
  try {
    return parser(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch (error) {
    if (error instanceof WorkerCertificateStoreError) throw error;
    throw new WorkerCertificateStoreError('manifest JSON is invalid');
  } finally {
    bytes.fill(0);
  }
}

export class WorkerCertificateFileStore implements WorkerCertificateStore {
  private readonly rootDirectory: string;
  private readonly generationsDirectory: string;
  private readonly retainedGenerations: number;
  private installing = false;

  constructor(options: WorkerCertificateFileStoreOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      typeof options.rootDirectory !== 'string' ||
      !isAbsolute(options.rootDirectory) ||
      options.rootDirectory.length > 4096 ||
      /[\0\r\n]/.test(options.rootDirectory)
    ) {
      throw new WorkerCertificateStoreError('rootDirectory is invalid');
    }
    const retainedGenerations = options.retainedGenerations ?? 2;
    if (
      !Number.isSafeInteger(retainedGenerations) ||
      retainedGenerations < 1 ||
      retainedGenerations > 4
    ) {
      throw new WorkerCertificateStoreError(
        'retainedGenerations must be between 1 and 4',
      );
    }
    this.rootDirectory = options.rootDirectory;
    this.generationsDirectory = join(options.rootDirectory, 'generations');
    this.retainedGenerations = retainedGenerations;
  }

  private async initialize(): Promise<void> {
    try {
      await safeDirectory(this.rootDirectory);
      await safeDirectory(this.generationsDirectory);
    } catch (error) {
      if (error instanceof WorkerCertificateStoreError) throw error;
      throw new WorkerCertificateStoreError('directory is unavailable');
    }
  }

  private async writeAtomicManifest(
    name: string,
    value: unknown,
    onCommitted?: () => void,
  ): Promise<void> {
    const temporary = join(this.rootDirectory, `.${name}.${randomUUID()}.tmp`);
    const destination = join(this.rootDirectory, name);
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    try {
      if (bytes.byteLength > MAX_MANIFEST_BYTES) {
        throw new WorkerCertificateStoreError('manifest exceeds hard limit');
      }
      await writeSyncedFile(temporary, bytes, 0o600);
      await rename(temporary, destination);
      onCommitted?.();
      await syncDirectory(this.rootDirectory);
    } finally {
      bytes.fill(0);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async readActiveSummary(): Promise<
    WorkerCertificateIdentityManifest | undefined
  > {
    await this.initialize();
    try {
      return await parseJsonFile(
        join(this.rootDirectory, 'active.json'),
        identityManifest,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (
        error instanceof WorkerCertificateStoreError &&
        error.message.endsWith('file is unavailable')
      ) {
        const stat = await lstat(join(this.rootDirectory, 'active.json')).catch(
          () => undefined,
        );
        if (!stat) return undefined;
      }
      throw error;
    }
  }

  async readActive(
    trustAnchors: readonly (string | Buffer)[],
    now: number = Date.now(),
  ): Promise<ActiveWorkerCertificateIdentity | undefined> {
    const manifest = await this.readActiveSummary();
    if (!manifest) return undefined;
    const generationDirectory = join(
      this.generationsDirectory,
      manifest.generationId,
    );
    const privateKeyFile = join(generationDirectory, 'private-key.pem');
    const certificateChainFile = join(
      generationDirectory,
      'certificate-chain.pem',
    );
    await assertSafeExistingDirectory(generationDirectory);
    const privateKeyPem = await readBoundedFile(
      privateKeyFile,
      MAX_IDENTITY_FILE_BYTES,
    );
    let certificateChainPem: Buffer | undefined;
    try {
      certificateChainPem = await readBoundedFile(
        certificateChainFile,
        MAX_IDENTITY_FILE_BYTES,
      );
      const summary = validateWorkerCertificateIdentity({
        privateKeyPem,
        certificateChainPem,
        trustAnchors,
        now: safeNow(now),
      });
      if (
        summary.certificateSha256 !== manifest.certificateSha256 ||
        summary.publicKeySpkiSha256 !== manifest.publicKeySpkiSha256 ||
        summary.serialNumber !== manifest.serialNumber ||
        summary.notBeforeMs !== manifest.notBeforeMs ||
        summary.notAfterMs !== manifest.notAfterMs
      ) {
        throw new WorkerCertificateStoreError('active identity was modified');
      }
      return Object.freeze({
        ...summary,
        generationId: manifest.generationId,
        installedAtMs: manifest.installedAtMs,
        privateKeyFile,
        certificateChainFile,
      });
    } finally {
      privateKeyPem.fill(0);
      certificateChainPem?.fill(0);
    }
  }

  async install(
    input: InstallWorkerCertificateIdentityInput,
  ): Promise<InstallWorkerCertificateIdentityResult> {
    if (this.installing) {
      throw new WorkerCertificateStoreError('another install is in progress');
    }
    this.installing = true;
    let stagingDirectory: string | undefined;
    let generationDirectory: string | undefined;
    let activated = false;
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new WorkerCertificateStoreError('install input is invalid');
      }
      const now = safeNow(input.now);
      const summary = validateWorkerCertificateIdentity({ ...input, now });
      await this.initialize();
      const entries = await readdir(this.generationsDirectory, {
        withFileTypes: true,
      });
      if (entries.length >= MAX_GENERATIONS) {
        throw new WorkerCertificateStoreError(
          'generation capacity requires maintenance',
        );
      }
      const generationId = randomUUID();
      generationDirectory = join(this.generationsDirectory, generationId);
      stagingDirectory = join(
        this.generationsDirectory,
        `.staging-${generationId}`,
      );
      await mkdir(stagingDirectory, { mode: 0o700 });
      const privateKeyBytes = Buffer.isBuffer(input.privateKeyPem)
        ? Buffer.from(input.privateKeyPem)
        : Buffer.from(input.privateKeyPem, 'utf8');
      const certificateBytes = Buffer.isBuffer(input.certificateChainPem)
        ? Buffer.from(input.certificateChainPem)
        : Buffer.from(input.certificateChainPem, 'utf8');
      const manifest: WorkerCertificateIdentityManifest = Object.freeze({
        schemaVersion: 1,
        generationId,
        installedAtMs: now,
        ...summary,
      });
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      try {
        await Promise.all([
          writeSyncedFile(
            join(stagingDirectory, 'private-key.pem'),
            privateKeyBytes,
            0o600,
          ),
          writeSyncedFile(
            join(stagingDirectory, 'certificate-chain.pem'),
            certificateBytes,
            0o600,
          ),
          writeSyncedFile(
            join(stagingDirectory, 'metadata.json'),
            manifestBytes,
            0o600,
          ),
        ]);
      } finally {
        privateKeyBytes.fill(0);
        certificateBytes.fill(0);
        manifestBytes.fill(0);
      }
      await syncDirectory(stagingDirectory);
      await rename(stagingDirectory, generationDirectory);
      stagingDirectory = undefined;
      await syncDirectory(this.generationsDirectory);
      await this.writeAtomicManifest('active.json', manifest, () => {
        activated = true;
      });
      const cleanupPending = !(await this.pruneRetired(manifest.generationId));
      return Object.freeze({
        ...summary,
        generationId,
        installedAtMs: now,
        privateKeyFile: join(generationDirectory, 'private-key.pem'),
        certificateChainFile: join(
          generationDirectory,
          'certificate-chain.pem',
        ),
        cleanupPending,
      });
    } catch (error) {
      if (error instanceof WorkerCertificateStoreError) throw error;
      throw new WorkerCertificateStoreError('install failed');
    } finally {
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      if (generationDirectory && !activated) {
        await rm(generationDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      this.installing = false;
    }
  }

  private async pruneRetired(activeGenerationId: string): Promise<boolean> {
    try {
      const entries = await readdir(this.generationsDirectory, {
        withFileTypes: true,
      });
      const generations: Array<{
        generationId: string;
        installedAtMs: number;
      }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !GENERATION_PATTERN.test(entry.name)) {
          continue;
        }
        const metadata = await parseJsonFile(
          join(this.generationsDirectory, entry.name, 'metadata.json'),
          identityManifest,
        );
        if (metadata.generationId !== entry.name) return false;
        generations.push({
          generationId: entry.name,
          installedAtMs: metadata.installedAtMs,
        });
      }
      generations.sort(
        (left, right) =>
          right.installedAtMs - left.installedAtMs ||
          right.generationId.localeCompare(left.generationId),
      );
      const keep = new Set(
        generations
          .filter((item) => item.generationId !== activeGenerationId)
          .slice(0, Math.max(0, this.retainedGenerations - 1))
          .map((item) => item.generationId),
      );
      keep.add(activeGenerationId);
      for (const generation of generations) {
        if (!keep.has(generation.generationId)) {
          await rm(join(this.generationsDirectory, generation.generationId), {
            recursive: true,
            force: true,
          });
        }
      }
      await syncDirectory(this.generationsDirectory);
      return true;
    } catch {
      return false;
    }
  }

  async readRenewalState(): Promise<WorkerCertificateRenewalState> {
    await this.initialize();
    try {
      const manifest = await parseJsonFile(
        join(this.rootDirectory, 'renewal.json'),
        renewalStateManifest,
      );
      const { schemaVersion: _schemaVersion, ...state } = manifest;
      return Object.freeze(state);
    } catch (error) {
      const stat = await lstat(join(this.rootDirectory, 'renewal.json')).catch(
        () => undefined,
      );
      if (!stat) {
        return Object.freeze({
          consecutiveFailures: 0,
          nextAttemptAtMs: null,
          lastAttemptAtMs: null,
          lastSuccessAtMs: null,
        });
      }
      throw error;
    }
  }

  async writeRenewalState(state: WorkerCertificateRenewalState): Promise<void> {
    await this.initialize();
    const manifest = renewalStateManifest({ schemaVersion: 1, ...state });
    await this.writeAtomicManifest('renewal.json', manifest);
  }
}
