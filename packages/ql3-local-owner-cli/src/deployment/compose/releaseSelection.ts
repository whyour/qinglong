import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_SELECTION_BYTES = 64 * 1024;
const LOCAL_SELECTION_SCHEMA = 'qinglong/local-compose-release-image@v2';
const CATALOG_SCHEMA = 'qinglong/release-catalog-consumption-ceremony@v1';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const VERSION_PATTERN = /^3\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const SOURCE_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IMAGE_PATTERN =
  /^ghcr\.io\/([a-z0-9](?:[a-z0-9-]{0,38}))\/qinglong3-local-application@(sha256:[a-f0-9]{64})$/;

export interface LocalComposeReleaseSelectionInput {
  readonly path: string;
  readonly expectedSelectionDigest: string;
}

export interface LocalComposeReleaseAuthority {
  readonly image: string;
  readonly allowRootService: boolean;
  readonly selectionDigest: string;
  readonly releaseSetDigest: string;
  readonly releaseVersion: string;
  readonly releaseSourceRevision: string;
  readonly releaseSourceRef: string;
  readonly releaseScope: 'local' | 'all';
  readonly catalogSchema: typeof CATALOG_SCHEMA;
  readonly catalogSourceRepository: string;
  readonly catalogWorkflowIdentity: string;
  readonly catalogImmutableReference: string;
  readonly catalogManifestDigest: string;
  readonly catalogConsumptionReportDigest: string;
  readonly catalogDiscoveryTagAuthority: 'none';
}

export interface ResolvedLocalComposeReleaseSelection
  extends LocalComposeReleaseSelectionInput {
  readonly authority: Readonly<LocalComposeReleaseAuthority>;
}

export class LocalComposeReleaseSelectionError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LocalComposeReleaseSelectionError';
  }
}

function fail(message: string, cause?: unknown): never {
  throw new LocalComposeReleaseSelectionError(message, { cause });
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    fail(`${label} shape is invalid`);
  }
}

function digest(value: string): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(value, 'utf8')
    .digest('hex')}`;
}

function readSelectionFile(filePath: string, uid: number): string {
  let parentStat: fs.Stats;
  try {
    parentStat = fs.lstatSync(path.dirname(filePath));
  } catch (error) {
    fail('release selection is unavailable', error);
  }
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== uid ||
    (parentStat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(path.dirname(filePath)) !== path.dirname(filePath)
  ) {
    fail('release selection must be a private canonical current-UID file');
  }
  let descriptor: number | undefined;
  let before: fs.Stats;
  let after: fs.Stats;
  let bytes: Buffer;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.uid !== uid ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size < 2 ||
      before.size > MAX_SELECTION_BYTES ||
      fs.realpathSync(filePath) !== filePath
    ) {
      fail('release selection must be a private canonical current-UID file');
    }
    bytes = fs.readFileSync(descriptor);
    after = fs.fstatSync(descriptor);
  } catch (error) {
    if (error instanceof LocalComposeReleaseSelectionError) throw error;
    fail('release selection cannot be read through a stable descriptor', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.byteLength !== before.size
  ) {
    fail('release selection changed while being read');
  }
  const contents = bytes.toString('utf8');
  if (!Buffer.from(contents, 'utf8').equals(bytes)) {
    fail('release selection must contain valid UTF-8');
  }
  return contents;
}

export function resolveLocalComposeReleaseSelection(
  input: Readonly<LocalComposeReleaseSelectionInput>,
  uid: number,
  allowRootService: boolean,
): Readonly<ResolvedLocalComposeReleaseSelection> {
  if (
    typeof input.path !== 'string' ||
    !path.isAbsolute(input.path) ||
    path.resolve(input.path) !== input.path ||
    typeof input.expectedSelectionDigest !== 'string' ||
    !DIGEST_PATTERN.test(input.expectedSelectionDigest)
  ) {
    fail('release selection input is invalid');
  }
  const contents = readSelectionFile(input.path, uid);
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    fail('release selection must contain valid JSON', error);
  }
  if (`${JSON.stringify(value)}\n` !== contents) {
    fail('release selection must use canonical JSON encoding');
  }
  exactKeys(
    value,
    [
      'catalog',
      'deploymentFamily',
      'release',
      'releaseSetDigest',
      'schema',
      'schemaVersion',
      'selectionDigest',
      'service',
      'verification',
    ],
    'release selection',
  );
  exactKeys(
    value.release,
    ['scope', 'sourceRef', 'sourceRevision', 'version'],
    'release',
  );
  exactKeys(
    value.catalog,
    [
      'consumptionReportDigest',
      'discoveryTagAuthority',
      'immutableReference',
      'manifestDigest',
      'releaseSetDigest',
      'schema',
      'sourceRepository',
      'workflowIdentity',
    ],
    'catalog',
  );
  exactKeys(value.service, ['allowRootService', 'image', 'kind'], 'service');
  exactKeys(
    value.verification,
    [
      'catalogConsumption',
      'deploymentMutation',
      'externalToolResultsReplayed',
      'networkAccess',
      'releaseSet',
      'sourceRecordsReplayed',
    ],
    'verification',
  );
  const release = value.release;
  const catalog = value.catalog;
  const service = value.service;
  const verification = value.verification;
  const image = typeof service.image === 'string' ? service.image : '';
  const imageMatch = IMAGE_PATTERN.exec(image);
  const { selectionDigest, ...unsigned } = value;
  const calculatedDigest = digest(JSON.stringify(unsigned));
  if (
    value.schemaVersion !== 1 ||
    value.schema !== LOCAL_SELECTION_SCHEMA ||
    value.deploymentFamily !== 'local' ||
    typeof release.version !== 'string' ||
    !VERSION_PATTERN.test(release.version) ||
    typeof release.sourceRevision !== 'string' ||
    !SOURCE_REVISION_PATTERN.test(release.sourceRevision) ||
    release.sourceRef !== `refs/tags/v${release.version}` ||
    (release.scope !== 'local' && release.scope !== 'all') ||
    typeof value.releaseSetDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.releaseSetDigest) ||
    catalog.schema !== CATALOG_SCHEMA ||
    typeof catalog.sourceRepository !== 'string' ||
    !SOURCE_REPOSITORY_PATTERN.test(catalog.sourceRepository) ||
    catalog.workflowIdentity !==
      `https://github.com/${catalog.sourceRepository}/.github/workflows/ql3-image-release.yml@${release.sourceRef}` ||
    typeof catalog.manifestDigest !== 'string' ||
    !DIGEST_PATTERN.test(catalog.manifestDigest) ||
    typeof catalog.consumptionReportDigest !== 'string' ||
    !DIGEST_PATTERN.test(catalog.consumptionReportDigest) ||
    catalog.releaseSetDigest !== value.releaseSetDigest ||
    catalog.discoveryTagAuthority !== 'none' ||
    !imageMatch ||
    catalog.immutableReference !==
      `ghcr.io/${imageMatch[1]}/qinglong3-release-catalog@${catalog.manifestDigest}` ||
    service.kind !== 'compose' ||
    service.allowRootService !== allowRootService ||
    verification.releaseSet !==
      'standalone_structure_identity_and_self_digest' ||
    verification.sourceRecordsReplayed !== false ||
    verification.catalogConsumption !== 'offline_reconstructed' ||
    verification.externalToolResultsReplayed !== false ||
    verification.networkAccess !== false ||
    verification.deploymentMutation !== false ||
    typeof selectionDigest !== 'string' ||
    !DIGEST_PATTERN.test(selectionDigest) ||
    selectionDigest !== calculatedDigest ||
    selectionDigest !== input.expectedSelectionDigest
  ) {
    fail('release selection identity or digest binding is invalid');
  }
  return Object.freeze({
    path: input.path,
    expectedSelectionDigest: input.expectedSelectionDigest,
    authority: Object.freeze({
      image,
      allowRootService,
      selectionDigest,
      releaseSetDigest: value.releaseSetDigest,
      releaseVersion: release.version,
      releaseSourceRevision: release.sourceRevision,
      releaseSourceRef: release.sourceRef,
      releaseScope: release.scope,
      catalogSchema: CATALOG_SCHEMA,
      catalogSourceRepository: catalog.sourceRepository,
      catalogWorkflowIdentity: catalog.workflowIdentity,
      catalogImmutableReference: catalog.immutableReference,
      catalogManifestDigest: catalog.manifestDigest,
      catalogConsumptionReportDigest: catalog.consumptionReportDigest,
      catalogDiscoveryTagAuthority: 'none' as const,
    }),
  });
}
