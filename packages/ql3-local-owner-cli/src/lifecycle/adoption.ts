// Local lifecycle owns reviewed legacy adoption ceremonies.
import fs from 'node:fs';
import path from 'node:path';
import {
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
} from '@qinglong/local-command-file';
import {
  inspectLegacySqlitePath,
  publishReviewedLegacyCrontabAdoption,
  type CommitReviewedLegacyCrontabAdoptionOptions,
} from '@qinglong/local-admin';
import {
  issueReviewedLegacyCrontabAdoptionDecisionAuthorizationFile,
  LegacyCrontabDecisionIssuerKeyringFileProvider,
  withPrivateLegacyCrontabAdoptionDecisionReviewFile,
} from '@qinglong/local-admin/decision-issuer';
import { establishAuthenticatedLocalCommand } from '@qinglong/local-owner-console/authenticated-command';
import { openLocalSqliteBootstrapDatabase } from '@qinglong/local-sqlite/bootstrap';

const MAX_PATH_BYTES = 4096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface PathIdentity {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
  readonly uid: number;
  readonly mode: number;
}

interface DeploymentProofOptions {
  readonly deploymentRoot: string;
  readonly credentialFilePath: string;
  readonly filePaths: readonly string[];
  readonly mutableFilePaths?: readonly string[];
  readonly directoryPaths: readonly string[];
  readonly missingPaths?: readonly string[];
}

export interface IssueLegacyCrontabAdoptionDecisionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'legacy-crontab.decision.issue';
  readonly options: {
    readonly deploymentRoot: string;
    readonly databasePath: string;
    readonly profile: 'edge' | 'standalone';
    readonly ownerPepperKeyringDirectory: string;
    readonly issuerKeyringPath: string;
    readonly credentialFilePath: string;
    readonly sourcePath: string;
    readonly reviewFilePath: string;
    readonly authorizationPath: string;
    readonly expectedPlanDigest: string;
    readonly decisionId: string;
    readonly legacyTimezone?: string;
    readonly busyTimeoutMs?: number;
    readonly lifetimeMs?: number;
  };
}

export interface CommitLegacyCrontabAdoptionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'legacy-crontab.adoption.commit';
  readonly options: {
    readonly deploymentRoot: string;
    readonly targetPath: string;
    readonly profile: 'edge' | 'standalone';
    readonly ownerPepperKeyringDirectory: string;
    readonly issuerKeyringPath: string;
    readonly credentialFilePath: string;
    readonly sourcePath: string;
    readonly authorizationPath: string;
    readonly expectedPlanDigest: string;
    readonly expectedDecisionId: string;
    readonly projectId: string;
    readonly mutationId: string;
    readonly requestId: string;
    readonly legacyTimezone?: string;
    readonly busyTimeoutMs?: number;
  };
}

export interface IssueLegacyCrontabAdoptionDecisionCommandResult {
  readonly schemaVersion: 1;
  readonly operation: 'legacy-crontab.decision.issue';
  readonly review: {
    readonly decisionCount: number;
    readonly fileBytes: number;
    readonly fileDigest: string;
  };
  readonly authorization: {
    readonly decisionId: string;
    readonly decisionCount: number;
    readonly fileBytes: number;
    readonly fileDigest: string;
    readonly keyId: string;
  };
  readonly receipt: {
    readonly reviewerSubjectId: string;
    readonly issuedAtMs: number;
    readonly expiresAtMs: number;
    readonly decisionDigest: string;
  };
}

export interface CommitLegacyCrontabAdoptionCommandResult {
  readonly schemaVersion: 1;
  readonly operation: 'legacy-crontab.adoption.commit';
  readonly status: 'inserted' | 'existing';
  readonly adoption: {
    readonly mutationId: string;
    readonly decisionId: string;
    readonly projectId: string;
    readonly publicationDigest: string;
    readonly adoptedTaskCount: number;
    readonly adoptedTriggerCount: number;
    readonly skippedCount: number;
    readonly auditEventId: string;
    readonly createdAtMs: number;
  };
}

export type LegacyCrontabAdoptionCommand =
  | IssueLegacyCrontabAdoptionDecisionCommand
  | CommitLegacyCrontabAdoptionCommand;

export type LegacyCrontabAdoptionCommandResult =
  | IssueLegacyCrontabAdoptionDecisionCommandResult
  | CommitLegacyCrontabAdoptionCommandResult;

export class LegacyCrontabAdoptionCliConfigurationError extends TypeError {
  readonly code = 'LEGACY_CRONTAB_ADOPTION_CLI_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Legacy Crontab adoption CLI configuration is invalid: ${message}`);
    this.name = 'LegacyCrontabAdoptionCliConfigurationError';
  }
}

export class LegacyCrontabAdoptionCliAuthenticationError extends Error {
  readonly code = 'LEGACY_CRONTAB_ADOPTION_CLI_AUTHENTICATION_FAILED';

  constructor(message: string) {
    super(`Legacy Crontab adoption CLI authentication failed: ${message}`);
    this.name = 'LegacyCrontabAdoptionCliAuthenticationError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

function identity(
  targetPath: string,
  kind: PathIdentity['kind'],
  uid: number,
): PathIdentity {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(targetPath, { bigint: true });
  } catch (error) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      `${kind} is unavailable`,
      error,
    );
  }
  const expectedKind =
    kind === 'directory' ? stat.isDirectory() : stat.isFile();
  const mode = Number(stat.mode) & 0o777;
  if (
    !expectedKind ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    mode !== (kind === 'directory' ? 0o700 : 0o600)
  ) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      `${kind} ownership or private mode is invalid`,
    );
  }
  return Object.freeze({
    path: targetPath,
    kind,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNs: stat.mtimeNs,
    changedAtNs: stat.ctimeNs,
    uid,
    mode,
  });
}

function sameIdentity(expected: PathIdentity, mutableFile: boolean): void {
  const actual = identity(expected.path, expected.kind, expected.uid);
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.mode !== expected.mode ||
    (expected.kind === 'file' &&
      !mutableFile &&
      (actual.size !== expected.size ||
        actual.modifiedAtNs !== expected.modifiedAtNs ||
        actual.changedAtNs !== expected.changedAtNs))
  ) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      `${expected.kind} identity changed during command execution`,
    );
  }
}

function descendants(deploymentRoot: string, targetPath: string): string[] {
  const relative = path.relative(deploymentRoot, targetPath);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'authority paths must be descendants of deploymentRoot',
    );
  }
  const directories: string[] = [];
  let current = deploymentRoot;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    directories.push(current);
  }
  return directories;
}

function assertMissing(targetPath: string): void {
  try {
    fs.lstatSync(targetPath);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'authorization destination cannot be inspected',
      error,
    );
  }
  throw new LegacyCrontabAdoptionCliConfigurationError(
    'authorization destination must not exist',
  );
}

function optionalRuntimeOptions(options: Record<string, unknown>): string[] {
  return [
    ...(options.busyTimeoutMs === undefined ? [] : ['busyTimeoutMs']),
    ...(options.legacyTimezone === undefined ? [] : ['legacyTimezone']),
  ];
}

function validRuntimeOptions(options: Record<string, unknown>): boolean {
  return !(
    (options.legacyTimezone !== undefined &&
      (typeof options.legacyTimezone !== 'string' ||
        options.legacyTimezone.length < 1 ||
        options.legacyTimezone.length > 128)) ||
    (options.busyTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.busyTimeoutMs) ||
        (options.busyTimeoutMs as number) < 1 ||
        (options.busyTimeoutMs as number) > 60_000))
  );
}

function normalizeCommand(
  value: unknown,
): Readonly<LegacyCrontabAdoptionCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['schemaVersion', 'operation', 'options'])
  ) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'command shape is invalid',
    );
  }
  const command = value as Record<string, unknown>;
  if (
    command.schemaVersion !== 1 ||
    (command.operation !== 'legacy-crontab.decision.issue' &&
      command.operation !== 'legacy-crontab.adoption.commit') ||
    !command.options ||
    typeof command.options !== 'object' ||
    Array.isArray(command.options)
  ) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'command value is invalid',
    );
  }
  const options = command.options as Record<string, unknown>;
  const issue = command.operation === 'legacy-crontab.decision.issue';
  const expected = issue
    ? [
        'authorizationPath',
        ...optionalRuntimeOptions(options),
        'credentialFilePath',
        'databasePath',
        'decisionId',
        'deploymentRoot',
        'expectedPlanDigest',
        'issuerKeyringPath',
        ...(options.lifetimeMs === undefined ? [] : ['lifetimeMs']),
        'ownerPepperKeyringDirectory',
        'profile',
        'reviewFilePath',
        'sourcePath',
      ]
    : [
        'authorizationPath',
        ...optionalRuntimeOptions(options),
        'credentialFilePath',
        'deploymentRoot',
        'expectedDecisionId',
        'expectedPlanDigest',
        'issuerKeyringPath',
        'mutationId',
        'ownerPepperKeyringDirectory',
        'profile',
        'projectId',
        'requestId',
        'sourcePath',
        'targetPath',
      ];
  if (
    !exactKeys(options, expected) ||
    (options.profile !== 'edge' && options.profile !== 'standalone') ||
    typeof options.expectedPlanDigest !== 'string' ||
    !DIGEST_PATTERN.test(options.expectedPlanDigest) ||
    !validRuntimeOptions(options) ||
    (issue &&
      (typeof options.decisionId !== 'string' ||
        !UUID_V7_PATTERN.test(options.decisionId))) ||
    (issue &&
      options.lifetimeMs !== undefined &&
      (!Number.isSafeInteger(options.lifetimeMs) ||
        (options.lifetimeMs as number) < 1_000 ||
        (options.lifetimeMs as number) > 30 * 60 * 1_000)) ||
    (!issue &&
      (typeof options.expectedDecisionId !== 'string' ||
        !UUID_V7_PATTERN.test(options.expectedDecisionId) ||
        typeof options.mutationId !== 'string' ||
        !UUID_V4_PATTERN.test(options.mutationId) ||
        typeof options.projectId !== 'string' ||
        !LOCAL_ID_PATTERN.test(options.projectId) ||
        typeof options.requestId !== 'string' ||
        !LOCAL_ID_PATTERN.test(options.requestId)))
  ) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'command options are invalid',
    );
  }
  const pathKeys = [
    'authorizationPath',
    'credentialFilePath',
    'deploymentRoot',
    'issuerKeyringPath',
    'ownerPepperKeyringDirectory',
    'sourcePath',
    ...(issue ? ['databasePath', 'reviewFilePath'] : ['targetPath']),
  ];
  for (const key of pathKeys) {
    boundedPath(options[key], key);
  }
  return Object.freeze(value as LegacyCrontabAdoptionCommand);
}

function readCommandFile(
  commandFilePath: string,
): Readonly<LegacyCrontabAdoptionCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(commandFilePath));
  } catch (error) {
    if (error instanceof LegacyCrontabAdoptionCliConfigurationError) {
      throw error;
    }
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LegacyCrontabAdoptionCliConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw error;
  }
}

function deploymentProof(options: DeploymentProofOptions): {
  verify(): void;
} {
  const uid = currentUid();
  const rootPath = boundedPath(options.deploymentRoot, 'deploymentRoot');
  const root = identity(rootPath, 'directory', uid);
  const filePaths = options.filePaths.map((candidate) =>
    boundedPath(candidate, 'authority file'),
  );
  const directoryPaths = options.directoryPaths.map((candidate) =>
    boundedPath(candidate, 'authority directory'),
  );
  const missingPaths = (options.missingPaths ?? []).map((candidate) =>
    boundedPath(candidate, 'missing authority path'),
  );
  const mutableFilePaths = new Set(
    (options.mutableFilePaths ?? []).map((candidate) =>
      boundedPath(candidate, 'mutable authority file'),
    ),
  );
  if (
    [...mutableFilePaths].some((candidate) => !filePaths.includes(candidate))
  ) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'mutable authority files must be declared files',
    );
  }
  const nestedDirectories = new Set<string>();
  for (const target of [...filePaths, ...directoryPaths]) {
    for (const directory of descendants(rootPath, target)) {
      nestedDirectories.add(directory);
    }
  }
  const directories = [
    root,
    ...[...nestedDirectories]
      .filter((candidate) => candidate !== rootPath)
      .map((candidate) => identity(candidate, 'directory', uid)),
    ...directoryPaths
      .filter(
        (candidate, index) =>
          directoryPaths.indexOf(candidate) === index &&
          candidate !== rootPath &&
          !nestedDirectories.has(candidate),
      )
      .map((candidate) => identity(candidate, 'directory', uid)),
  ];
  const files = filePaths.map((candidate) => identity(candidate, 'file', uid));
  const uniqueFiles = new Set(
    files.map((entry) => `${entry.device}:${entry.inode}`),
  );
  if (uniqueFiles.size !== files.length) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'authority files must not share an inode',
    );
  }
  for (const missingPath of missingPaths) assertMissing(missingPath);
  if (!files.some((entry) => entry.path === options.credentialFilePath)) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'credential file must be part of the deployment proof',
    );
  }
  return Object.freeze({
    verify() {
      if (currentUid() !== uid) {
        throw new LegacyCrontabAdoptionCliConfigurationError(
          'POSIX user changed during command execution',
        );
      }
      for (const expected of [...directories, ...files]) {
        sameIdentity(expected, mutableFilePaths.has(expected.path));
      }
      for (const missingPath of missingPaths) assertMissing(missingPath);
    },
  });
}

type LocalBootstrapDatabase = Awaited<
  ReturnType<typeof openLocalSqliteBootstrapDatabase>
>;
type CommitReviewer = Parameters<
  NonNullable<
    CommitReviewedLegacyCrontabAdoptionOptions['confirmReviewerAuthority']
  >
>[0];

async function createReviewerAuthority(
  database: LocalBootstrapDatabase,
  deploymentRoot: string,
  databasePath: string,
  ownerPepperKeyringDirectory: string,
  credentialFilePath: string,
  proof: ReturnType<typeof deploymentProof>,
): Promise<{
  readonly reviewer: Readonly<CommitReviewer>;
  readonly confirm: () => Promise<void>;
}> {
  proof.verify();
  let authenticated: Awaited<
    ReturnType<typeof establishAuthenticatedLocalCommand>
  >;
  try {
    authenticated = await establishAuthenticatedLocalCommand(database, {
      deploymentRoot,
      databasePath,
      ownerPepperKeyringDirectory,
      credentialFilePath,
      authenticationNamespace: 'local_adoption',
    });
  } catch {
    throw new LegacyCrontabAdoptionCliAuthenticationError(
      'credential authority is unavailable',
    );
  }
  const reviewer: Readonly<CommitReviewer> = authenticated.principal;
  return Object.freeze({
    reviewer,
    async confirm() {
      proof.verify();
      try {
        await authenticated.confirm();
      } catch {
        throw new LegacyCrontabAdoptionCliAuthenticationError(
          'credential authority changed during adoption',
        );
      }
    },
  });
}

async function issueDecision(
  command: Readonly<IssueLegacyCrontabAdoptionDecisionCommand>,
): Promise<Readonly<IssueLegacyCrontabAdoptionDecisionCommandResult>> {
  const options = command.options;
  const proof = deploymentProof({
    deploymentRoot: options.deploymentRoot,
    credentialFilePath: options.credentialFilePath,
    filePaths: [
      options.databasePath,
      options.issuerKeyringPath,
      options.credentialFilePath,
      options.sourcePath,
      options.reviewFilePath,
    ],
    directoryPaths: [
      options.ownerPepperKeyringDirectory,
      path.dirname(options.authorizationPath),
    ],
    missingPaths: [options.authorizationPath],
  });
  const plan = inspectLegacySqlitePath({
    sourcePath: options.sourcePath,
    profile: options.profile,
    ...(options.legacyTimezone === undefined
      ? {}
      : { legacyTimezone: options.legacyTimezone }),
  });
  if (plan.planDigest !== options.expectedPlanDigest) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'source no longer matches expectedPlanDigest',
    );
  }
  return withPrivateLegacyCrontabAdoptionDecisionReviewFile(
    {
      filePath: options.reviewFilePath,
      expectedDecisionId: options.decisionId,
      expectedProfile: options.profile,
      expectedPlanDigest: plan.planDigest,
      expectedInventoryDigest: plan.tasks.inventoryDigest,
    },
    async (review) => {
      const database = await openLocalSqliteBootstrapDatabase({
        databasePath: options.databasePath,
        profile: options.profile,
        ...(options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: options.busyTimeoutMs }),
      });
      try {
        const authority = await createReviewerAuthority(
          database,
          options.deploymentRoot,
          options.databasePath,
          options.ownerPepperKeyringDirectory,
          options.credentialFilePath,
          proof,
        );
        const issued =
          await issueReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
            sourcePath: options.sourcePath,
            profile: options.profile,
            ...(options.legacyTimezone === undefined
              ? {}
              : { legacyTimezone: options.legacyTimezone }),
            expectedPlanDigest: plan.planDigest,
            decisionId: options.decisionId,
            authorizationPath: options.authorizationPath,
            issuerKeyringPath: options.issuerKeyringPath,
            decisions: review.decisions,
            authenticateReviewer: () => authority.reviewer,
            confirmIssuerAuthority: authority.confirm,
            confirmDecisionStreamAuthority: review.confirmIdentity,
            ...(options.lifetimeMs === undefined
              ? {}
              : { lifetimeMs: options.lifetimeMs }),
          });
        return Object.freeze({
          schemaVersion: 1,
          operation: 'legacy-crontab.decision.issue',
          review: Object.freeze({
            decisionCount: review.evidence.decisionCount,
            fileBytes: review.evidence.fileBytes,
            fileDigest: review.evidence.fileDigest,
          }),
          authorization: Object.freeze({
            decisionId: issued.file.decisionId,
            decisionCount: issued.file.decisionCount,
            fileBytes: issued.file.fileBytes,
            fileDigest: issued.file.fileDigest,
            keyId: issued.file.keyId,
          }),
          receipt: Object.freeze({
            reviewerSubjectId: issued.receipt.reviewer.subject.id,
            issuedAtMs: issued.receipt.issuedAtMs,
            expiresAtMs: issued.receipt.expiresAtMs,
            decisionDigest: issued.receipt.decisions.decisionDigest,
          }),
        });
      } finally {
        await database.close();
      }
    },
  );
}

async function commitAdoption(
  command: Readonly<CommitLegacyCrontabAdoptionCommand>,
): Promise<Readonly<CommitLegacyCrontabAdoptionCommandResult>> {
  const options = command.options;
  const proof = deploymentProof({
    deploymentRoot: options.deploymentRoot,
    credentialFilePath: options.credentialFilePath,
    filePaths: [
      options.targetPath,
      options.issuerKeyringPath,
      options.credentialFilePath,
      options.sourcePath,
      options.authorizationPath,
    ],
    mutableFilePaths: [options.targetPath],
    directoryPaths: [options.ownerPepperKeyringDirectory],
  });
  const plan = inspectLegacySqlitePath({
    sourcePath: options.sourcePath,
    profile: options.profile,
    ...(options.legacyTimezone === undefined
      ? {}
      : { legacyTimezone: options.legacyTimezone }),
  });
  if (plan.planDigest !== options.expectedPlanDigest) {
    throw new LegacyCrontabAdoptionCliConfigurationError(
      'source no longer matches expectedPlanDigest',
    );
  }
  const database = await openLocalSqliteBootstrapDatabase({
    databasePath: options.targetPath,
    profile: options.profile,
    ...(options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  try {
    const authority = await createReviewerAuthority(
      database,
      options.deploymentRoot,
      options.targetPath,
      options.ownerPepperKeyringDirectory,
      options.credentialFilePath,
      proof,
    );
    const confirmReviewerAuthority = async (
      reviewer: Readonly<CommitReviewer>,
    ): Promise<void> => {
      await authority.confirm();
      if (
        reviewer.subject.type !== authority.reviewer.subject.type ||
        reviewer.subject.id !== authority.reviewer.subject.id ||
        reviewer.authenticationId !== authority.reviewer.authenticationId ||
        reviewer.assurance !== authority.reviewer.assurance
      ) {
        throw new LegacyCrontabAdoptionCliAuthenticationError(
          'current operator does not match the signed reviewer',
        );
      }
    };
    const published = await publishReviewedLegacyCrontabAdoption({
      sourcePath: options.sourcePath,
      targetPath: options.targetPath,
      authorizationPath: options.authorizationPath,
      profile: options.profile,
      ...(options.legacyTimezone === undefined
        ? {}
        : { legacyTimezone: options.legacyTimezone }),
      expectedPlanDigest: plan.planDigest,
      expectedDecisionId: options.expectedDecisionId,
      projectId: options.projectId,
      mutationId: options.mutationId,
      requestId: options.requestId,
      keyProvider: new LegacyCrontabDecisionIssuerKeyringFileProvider(
        options.issuerKeyringPath,
      ),
      observedAtMs: Date.now(),
      ...(options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.busyTimeoutMs }),
      confirmReviewerAuthority,
    });
    return Object.freeze({
      schemaVersion: 1,
      operation: 'legacy-crontab.adoption.commit',
      status: published.status,
      adoption: Object.freeze({
        mutationId: published.adoption.mutationId,
        decisionId: published.adoption.decisionId,
        projectId: published.adoption.projectId,
        publicationDigest: published.adoption.publicationDigest,
        adoptedTaskCount: published.adoption.adoptedTaskCount,
        adoptedTriggerCount: published.adoption.adoptedTriggerCount,
        skippedCount: published.adoption.skippedCount,
        auditEventId: published.adoption.auditEventId,
        createdAtMs: published.adoption.createdAtMs,
      }),
    });
  } finally {
    await database.close();
  }
}

export async function runLegacyCrontabAdoptionCommandFile(
  commandFilePath: string,
): Promise<Readonly<LegacyCrontabAdoptionCommandResult>> {
  const command = readCommandFile(commandFilePath);
  return command.operation === 'legacy-crontab.decision.issue'
    ? issueDecision(command)
    : commitAdoption(command);
}
