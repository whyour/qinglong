import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { cutoverDigest } from '../cutover/targetEvidence';
import type {
  LocalDeploymentPrepareCommand,
  LocalDeploymentProfile,
} from '../foundation/contract';
import { LocalDeploymentConfigurationError } from '../foundation/error';
import {
  applicationConfiguration,
  deploymentPaths,
  descriptor,
} from '../foundation/render';
import type { NormalizedLocalDeploymentAdoptedBundleCommand } from '../adopted-bundle/contract';
import {
  renderLocalDeploymentAdoptedBundleMaterial,
  verifyLocalDeploymentAdoptedEvidence,
  type LocalDeploymentAdoptedBundleReceipt,
} from '../adopted-bundle/material';
import { inspectComposeImageSelectionGeneration } from './composeRevision';

const APPLICATION_SCHEMA_V2 = 'qinglong/local-application-process@v2';
const APPLICATION_SCHEMA_V4 = 'qinglong/local-application-process@v4';
const LINEAGE_SCHEMA = 'qinglong/local-compose-deployment-lineage@v1';
const MAX_PRIVATE_FILE_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LocalDeploymentComposeLineageReceipt {
  readonly schema: typeof LINEAGE_SCHEMA;
  readonly mode: 'fresh' | 'adopted';
  readonly applicationConfigDigest: string;
  readonly adoptedBundleDigest: string | null;
  readonly activationDigest: string | null;
  readonly commitmentDigest: string | null;
  readonly legacyDataApplicationCommitDigest: string | null;
  readonly legacyDataApplicationReceiptDigest: string | null;
}

export interface LocalDeploymentComposeLineage {
  readonly mode: 'fresh' | 'adopted';
  readonly instanceId: string;
  readonly profile: LocalDeploymentProfile;
  readonly busyTimeoutMs?: number;
  readonly databasePath: string;
  readonly sourcePath: string | null;
  readonly bundleId: string | null;
  readonly receipt: Readonly<LocalDeploymentComposeLineageReceipt>;
}

interface ParsedAdoptedApplication {
  readonly instanceId: string;
  readonly profile: LocalDeploymentProfile;
  readonly busyTimeoutMs?: number;
  readonly storage: Readonly<{
    sourcePath: string;
    targetPath: string;
    recoveryPath: string;
    manifestPath: string;
    activationPath: string;
    expectedActivationDigest: string;
  }>;
  readonly cutover: Readonly<{
    cutoverId: string;
    commitmentPath: string;
    expectedCommitmentDigest: string;
  }>;
  readonly legacyDataApplication: Readonly<{
    commitPath: string;
    expectedCommitDigest: string;
    expectedReceiptDigest: string;
  }>;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    configurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
  }
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    configurationError(`${label} is invalid`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    value.includes('//') ||
    Buffer.byteLength(value, 'utf8') > 4_096
  ) {
    configurationError(`${label} is not a canonical bounded absolute path`);
  }
  return value;
}

function strictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function readExactPrivateFile(
  filePath: string,
  uid: number,
  gid: number,
  label: string,
): string {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      Number(opened.uid) !== uid ||
      Number(opened.gid) !== gid ||
      (Number(opened.mode) & 0o777) !== 0o600 ||
      opened.nlink !== 1n ||
      opened.size < 2n ||
      opened.size > BigInt(MAX_PRIVATE_FILE_BYTES) ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError(`${label} identity is invalid`);
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      offset !== bytes.byteLength ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.uid !== opened.uid ||
      after.gid !== opened.gid ||
      after.mode !== opened.mode ||
      after.nlink !== opened.nlink
    ) {
      configurationError(`${label} changed while reading`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError(`${label} cannot be read`, error);
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function verifyExactPrivateFile(
  filePath: string,
  expected: string,
  uid: number,
  gid: number,
  label: string,
): void {
  if (readExactPrivateFile(filePath, uid, gid, label) !== expected) {
    configurationError(`${label} content drifted`);
  }
}

function parseJson(contents: string, label: string): Record<string, unknown> {
  try {
    return object(JSON.parse(contents), label);
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError(`${label} is invalid`, error);
  }
}

function optionalBusyTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 100 ||
    (value as number) > 30_000
  ) {
    configurationError('application busyTimeoutMs is invalid');
  }
  return value as number;
}

function parseFreshApplication(
  value: Readonly<Record<string, unknown>>,
): Readonly<{
  instanceId: string;
  profile: LocalDeploymentProfile;
  databasePath: string;
  busyTimeoutMs?: number;
}> {
  const storage = object(value.storage, 'application storage');
  if (
    typeof value.instanceId !== 'string' ||
    (value.profile !== 'edge' && value.profile !== 'standalone') ||
    storage.mode !== 'fresh'
  ) {
    configurationError('application configuration is not a fresh Compose v2');
  }
  const databasePath = absolutePath(
    storage.databasePath,
    'application databasePath',
  );
  const busyTimeoutMs = optionalBusyTimeout(storage.busyTimeoutMs);
  return Object.freeze({
    instanceId: value.instanceId,
    profile: value.profile,
    databasePath,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
  });
}

function parseAdoptedApplication(
  value: Readonly<Record<string, unknown>>,
  deploymentRoot: string,
): Readonly<ParsedAdoptedApplication> {
  exact(
    value,
    [
      'ai',
      'cutover',
      'instanceId',
      'legacyDataApplication',
      'pluginPackages',
      'profile',
      'runtime',
      'schema',
      'storage',
    ],
    'adopted application configuration',
  );
  if (
    typeof value.instanceId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.instanceId) ||
    (value.profile !== 'edge' && value.profile !== 'standalone')
  ) {
    configurationError('adopted application identity is invalid');
  }
  const storage = object(value.storage, 'adopted storage');
  const optionalStorageKeys = Object.hasOwn(storage, 'busyTimeoutMs')
    ? ['busyTimeoutMs']
    : [];
  exact(
    storage,
    [
      'activationPath',
      'expectedActivationDigest',
      'manifestPath',
      'mode',
      'recoveryPath',
      'sourcePath',
      'targetPath',
      ...optionalStorageKeys,
    ],
    'adopted storage',
  );
  const runtime = object(value.runtime, 'adopted runtime');
  exact(
    runtime,
    ['artifactRoot', 'receiptRoot', 'secretKeyringPath'],
    'adopted runtime',
  );
  const pluginPackages = object(
    value.pluginPackages,
    'adopted plugin packages',
  );
  exact(
    pluginPackages,
    [
      'activationRoot',
      'maxPages',
      'pageSize',
      'recoverySource',
      'stagingRoot',
      'taskPublicationMaxPages',
      'taskPublicationPageSize',
    ],
    'adopted plugin packages',
  );
  const recoverySource = object(
    pluginPackages.recoverySource,
    'plugin recovery source',
  );
  exact(recoverySource, ['mode'], 'plugin recovery source');
  const ai = object(value.ai, 'adopted AI');
  exact(ai, ['deployment'], 'adopted AI');
  const cutover = object(value.cutover, 'adopted cutover');
  exact(
    cutover,
    ['commitmentPath', 'cutoverId', 'expectedCommitmentDigest'],
    'adopted cutover',
  );
  const dataApplication = object(
    value.legacyDataApplication,
    'legacy data application',
  );
  exact(
    dataApplication,
    ['commitPath', 'expectedCommitDigest', 'expectedReceiptDigest'],
    'legacy data application',
  );
  const sourcePath = absolutePath(storage.sourcePath, 'sourcePath');
  const authorityPaths = {
    targetPath: absolutePath(storage.targetPath, 'targetPath'),
    recoveryPath: absolutePath(storage.recoveryPath, 'recoveryPath'),
    manifestPath: absolutePath(storage.manifestPath, 'manifestPath'),
    activationPath: absolutePath(storage.activationPath, 'activationPath'),
    commitmentPath: absolutePath(cutover.commitmentPath, 'commitmentPath'),
    commitPath: absolutePath(dataApplication.commitPath, 'commitPath'),
  };
  const paths = deploymentPaths(deploymentRoot);
  const pageSize = value.profile === 'edge' ? 4 : 16;
  if (
    storage.mode !== 'adopted' ||
    strictDescendant(deploymentRoot, sourcePath) ||
    Object.values(authorityPaths).some(
      (candidate) => !strictDescendant(deploymentRoot, candidate),
    ) ||
    new Set([sourcePath, ...Object.values(authorityPaths)]).size !== 7 ||
    runtime.receiptRoot !== paths.receipts ||
    runtime.artifactRoot !== paths.artifacts ||
    runtime.secretKeyringPath !== paths.localSecretKeyring ||
    pluginPackages.stagingRoot !== paths.pluginStaging ||
    pluginPackages.activationRoot !== paths.pluginActivation ||
    recoverySource.mode !== 'disabled' ||
    pluginPackages.pageSize !== pageSize ||
    pluginPackages.maxPages !== pageSize ||
    pluginPackages.taskPublicationPageSize !== pageSize ||
    pluginPackages.taskPublicationMaxPages !== pageSize ||
    ai.deployment !== 'excluded' ||
    typeof cutover.cutoverId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cutover.cutoverId)
  ) {
    configurationError('adopted application authority binding drifted');
  }
  const busyTimeoutMs = optionalBusyTimeout(storage.busyTimeoutMs);
  return Object.freeze({
    instanceId: value.instanceId,
    profile: value.profile,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    storage: Object.freeze({
      sourcePath,
      targetPath: authorityPaths.targetPath,
      recoveryPath: authorityPaths.recoveryPath,
      manifestPath: authorityPaths.manifestPath,
      activationPath: authorityPaths.activationPath,
      expectedActivationDigest: digest(
        storage.expectedActivationDigest,
        'expectedActivationDigest',
      ),
    }),
    cutover: Object.freeze({
      cutoverId: cutover.cutoverId,
      commitmentPath: authorityPaths.commitmentPath,
      expectedCommitmentDigest: digest(
        cutover.expectedCommitmentDigest,
        'expectedCommitmentDigest',
      ),
    }),
    legacyDataApplication: Object.freeze({
      commitPath: authorityPaths.commitPath,
      expectedCommitDigest: digest(
        dataApplication.expectedCommitDigest,
        'expectedCommitDigest',
      ),
      expectedReceiptDigest: digest(
        dataApplication.expectedReceiptDigest,
        'expectedReceiptDigest',
      ),
    }),
  });
}

function parseBundleReceipt(
  contents: string,
): Readonly<LocalDeploymentAdoptedBundleReceipt> {
  const value = parseJson(contents, 'adopted bundle receipt');
  exact(
    value,
    [
      'activationDigest',
      'applicationConfigDigest',
      'bundleDigest',
      'bundleId',
      'commitmentDigest',
      'composeSelectionDigest',
      'cutoverId',
      'deploymentRootDigest',
      'instanceId',
      'kind',
      'legacyDataApplicationCommitDigest',
      'legacyDataApplicationReceiptDigest',
      'manifestDigest',
      'preparedAtMs',
      'profile',
      'recoverySha256',
      'schemaVersion',
      'serviceDescriptorDigest',
      'serviceKind',
      'sourcePathDigest',
      'sourceSha256',
      'state',
      'targetIdentityDigest',
    ],
    'adopted bundle receipt',
  );
  const { bundleDigest, ...payload } = value;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'qinglong3-local-adopted-deployment-bundle' ||
    value.state !== 'prepared' ||
    typeof value.bundleId !== 'string' ||
    !UUID_V4_PATTERN.test(value.bundleId) ||
    !Number.isSafeInteger(value.preparedAtMs) ||
    (value.preparedAtMs as number) < 0 ||
    (value.profile !== 'edge' && value.profile !== 'standalone') ||
    typeof value.instanceId !== 'string' ||
    typeof value.cutoverId !== 'string' ||
    value.serviceKind !== 'compose' ||
    Object.entries(value).some(([key, candidate]) =>
      key.endsWith('Digest')
        ? typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate)
        : false,
    ) ||
    typeof value.sourceSha256 !== 'string' ||
    !DIGEST_PATTERN.test(value.sourceSha256) ||
    typeof value.recoverySha256 !== 'string' ||
    !DIGEST_PATTERN.test(value.recoverySha256) ||
    cutoverDigest(payload) !== bundleDigest
  ) {
    configurationError('adopted bundle receipt drifted');
  }
  return value as unknown as Readonly<LocalDeploymentAdoptedBundleReceipt>;
}

function lineageReceipt(input: {
  readonly mode: 'fresh' | 'adopted';
  readonly applicationConfigDigest: string;
  readonly adoptedBundleDigest?: string;
  readonly activationDigest?: string;
  readonly commitmentDigest?: string;
  readonly legacyDataApplicationCommitDigest?: string;
  readonly legacyDataApplicationReceiptDigest?: string;
}): Readonly<LocalDeploymentComposeLineageReceipt> {
  const adopted = input.mode === 'adopted';
  return Object.freeze({
    schema: LINEAGE_SCHEMA,
    mode: input.mode,
    applicationConfigDigest: input.applicationConfigDigest,
    adoptedBundleDigest: adopted ? input.adoptedBundleDigest! : null,
    activationDigest: adopted ? input.activationDigest! : null,
    commitmentDigest: adopted ? input.commitmentDigest! : null,
    legacyDataApplicationCommitDigest: adopted
      ? input.legacyDataApplicationCommitDigest!
      : null,
    legacyDataApplicationReceiptDigest: adopted
      ? input.legacyDataApplicationReceiptDigest!
      : null,
  });
}

export function inspectLocalDeploymentComposeLineage(
  deploymentRoot: string,
  uid: number,
  gid: number,
  allowRootService: boolean,
): Readonly<LocalDeploymentComposeLineage> {
  const paths = deploymentPaths(deploymentRoot);
  const applicationContents = readExactPrivateFile(
    paths.applicationConfig,
    uid,
    gid,
    'application configuration',
  );
  const application = parseJson(
    applicationContents,
    'application configuration',
  );
  if (application.schema === APPLICATION_SCHEMA_V2) {
    const fresh = parseFreshApplication(application);
    const syntheticPrepare: Readonly<LocalDeploymentPrepareCommand> = {
      schemaVersion: 1,
      operation: 'local.deployment.prepare',
      options: {
        deploymentRoot,
        profile: fresh.profile,
        instanceId: fresh.instanceId,
        ...(fresh.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: fresh.busyTimeoutMs }),
        service: {
          kind: 'compose',
          releaseSelection: {
            path: paths.composeSelection,
            expectedSelectionDigest: 'sha256:'.concat('0'.repeat(64)),
          },
          allowRootService,
        },
      },
      request: {
        ownerPepperKeyId: 'lineage',
        registerMutationId: '00000000-0000-4000-8000-000000000001',
        activateMutationId: '00000000-0000-4000-8000-000000000002',
        registeredAtMs: 0,
        activatedAtMs: 0,
      },
    };
    const expectedApplication = applicationConfiguration(
      syntheticPrepare,
      paths,
    );
    if (applicationContents !== expectedApplication) {
      configurationError('fresh application configuration drifted');
    }
    const expectedDescriptor = descriptor(
      syntheticPrepare,
      paths.applicationConfig,
      uid,
      gid,
    );
    verifyExactPrivateFile(
      path.join(paths.service, expectedDescriptor.fileName),
      expectedDescriptor.contents,
      uid,
      gid,
      'fresh Compose descriptor',
    );
    return Object.freeze({
      mode: 'fresh' as const,
      instanceId: fresh.instanceId,
      profile: fresh.profile,
      ...(fresh.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: fresh.busyTimeoutMs }),
      databasePath: paths.database,
      sourcePath: null,
      bundleId: null,
      receipt: lineageReceipt({
        mode: 'fresh',
        applicationConfigDigest: sha256(applicationContents),
      }),
    });
  }
  if (application.schema !== APPLICATION_SCHEMA_V4) {
    configurationError('Compose requires an Application v2 or adopted v4');
  }
  const adopted = parseAdoptedApplication(application, deploymentRoot);
  const bundleContents = readExactPrivateFile(
    path.join(paths.service, 'adopted-bundle.json'),
    uid,
    gid,
    'adopted bundle receipt',
  );
  const bundle = parseBundleReceipt(bundleContents);
  if (
    bundle.profile !== adopted.profile ||
    bundle.instanceId !== adopted.instanceId ||
    bundle.cutoverId !== adopted.cutover.cutoverId ||
    bundle.deploymentRootDigest !== sha256(deploymentRoot) ||
    bundle.sourcePathDigest !== sha256(adopted.storage.sourcePath) ||
    bundle.applicationConfigDigest !== sha256(applicationContents) ||
    bundle.activationDigest !== adopted.storage.expectedActivationDigest ||
    bundle.commitmentDigest !== adopted.cutover.expectedCommitmentDigest ||
    bundle.legacyDataApplicationCommitDigest !==
      adopted.legacyDataApplication.expectedCommitDigest ||
    bundle.legacyDataApplicationReceiptDigest !==
      adopted.legacyDataApplication.expectedReceiptDigest
  ) {
    configurationError('adopted bundle application binding drifted');
  }
  const initialSelection = inspectComposeImageSelectionGeneration(
    paths.composeRevisions,
    1,
    uid,
  );
  const command: Readonly<NormalizedLocalDeploymentAdoptedBundleCommand> =
    Object.freeze({
      schemaVersion: 1 as const,
      operation: 'local.deployment.adopted.verify' as const,
      options: Object.freeze({
        deploymentRoot,
        profile: adopted.profile,
        instanceId: adopted.instanceId,
        ...(adopted.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: adopted.busyTimeoutMs }),
        service: Object.freeze({
          kind: 'compose' as const,
          allowRootService,
          releaseSelection: Object.freeze({
            path: paths.composeSelection,
            expectedSelectionDigest: initialSelection.selectionDigest,
            authority: initialSelection,
          }),
        }),
      }),
      request: Object.freeze({
        bundleId: bundle.bundleId,
        preparedAtMs: bundle.preparedAtMs,
        cutoverId: adopted.cutover.cutoverId,
        storage: adopted.storage,
        cutover: Object.freeze({
          commitmentPath: adopted.cutover.commitmentPath,
          expectedCommitmentDigest: adopted.cutover.expectedCommitmentDigest,
        }),
        legacyDataApplication: adopted.legacyDataApplication,
      }),
    });
  const evidence = verifyLocalDeploymentAdoptedEvidence(command, uid, gid);
  const material = renderLocalDeploymentAdoptedBundleMaterial(
    command,
    evidence,
    uid,
    gid,
  );
  verifyExactPrivateFile(
    material.paths.applicationConfig,
    material.applicationConfig,
    uid,
    gid,
    'adopted application configuration',
  );
  verifyExactPrivateFile(
    material.paths.descriptor,
    material.descriptor.contents,
    uid,
    gid,
    'adopted Compose descriptor',
  );
  verifyExactPrivateFile(
    material.paths.bundleReceipt,
    material.receiptContents,
    uid,
    gid,
    'adopted bundle receipt',
  );
  if (material.composeSelection === null) {
    configurationError('adopted Compose selection is unavailable');
  }
  verifyExactPrivateFile(
    material.paths.composeRevision,
    material.composeSelection,
    uid,
    gid,
    'initial adopted Compose revision',
  );
  return Object.freeze({
    mode: 'adopted' as const,
    instanceId: adopted.instanceId,
    profile: adopted.profile,
    ...(adopted.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: adopted.busyTimeoutMs }),
    databasePath: adopted.storage.targetPath,
    sourcePath: adopted.storage.sourcePath,
    bundleId: bundle.bundleId,
    receipt: lineageReceipt({
      mode: 'adopted',
      applicationConfigDigest: bundle.applicationConfigDigest,
      adoptedBundleDigest: bundle.bundleDigest,
      activationDigest: bundle.activationDigest,
      commitmentDigest: bundle.commitmentDigest,
      legacyDataApplicationCommitDigest:
        bundle.legacyDataApplicationCommitDigest,
      legacyDataApplicationReceiptDigest:
        bundle.legacyDataApplicationReceiptDigest,
    }),
  });
}

export function normalizeLocalDeploymentComposeLineageReceipt(
  value: unknown,
): Readonly<LocalDeploymentComposeLineageReceipt> {
  const receipt = object(value, 'Compose deployment lineage');
  exact(
    receipt,
    [
      'activationDigest',
      'adoptedBundleDigest',
      'applicationConfigDigest',
      'commitmentDigest',
      'legacyDataApplicationCommitDigest',
      'legacyDataApplicationReceiptDigest',
      'mode',
      'schema',
    ],
    'Compose deployment lineage',
  );
  const adopted = receipt.mode === 'adopted';
  if (
    receipt.schema !== LINEAGE_SCHEMA ||
    (receipt.mode !== 'fresh' && !adopted) ||
    typeof receipt.applicationConfigDigest !== 'string' ||
    !DIGEST_PATTERN.test(receipt.applicationConfigDigest) ||
    [
      receipt.adoptedBundleDigest,
      receipt.activationDigest,
      receipt.commitmentDigest,
      receipt.legacyDataApplicationCommitDigest,
      receipt.legacyDataApplicationReceiptDigest,
    ].some((candidate) =>
      adopted
        ? typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate)
        : candidate !== null,
    )
  ) {
    configurationError('Compose deployment lineage is invalid');
  }
  return Object.freeze({
    schema: LINEAGE_SCHEMA,
    mode: receipt.mode,
    applicationConfigDigest: receipt.applicationConfigDigest,
    adoptedBundleDigest: receipt.adoptedBundleDigest,
    activationDigest: receipt.activationDigest,
    commitmentDigest: receipt.commitmentDigest,
    legacyDataApplicationCommitDigest:
      receipt.legacyDataApplicationCommitDigest,
    legacyDataApplicationReceiptDigest:
      receipt.legacyDataApplicationReceiptDigest,
  }) as Readonly<LocalDeploymentComposeLineageReceipt>;
}

export function assertLocalDeploymentComposeLineageReceipt(
  value: unknown,
  expected: Readonly<LocalDeploymentComposeLineageReceipt>,
): void {
  const actual = normalizeLocalDeploymentComposeLineageReceipt(value);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    configurationError('Compose deployment lineage drifted');
  }
}
