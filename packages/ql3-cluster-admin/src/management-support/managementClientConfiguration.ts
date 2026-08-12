/** Package-private configuration preparation shared by management clients. */
import { createPrivateKey, X509Certificate } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';

export type ClusterAuthenticatedManagementClientKind =
  | 'package'
  | 'worker-credential'
  | 'automation'
  | 'approval'
  | 'model-credential'
  | 'run';

const MANAGEMENT_CLIENT_POLICIES: Readonly<
  Record<
    ClusterAuthenticatedManagementClientKind,
    Readonly<{
      managementPath: string;
      clientCertificate: 'forbidden' | 'required';
    }>
  >
> = Object.freeze({
  package: Object.freeze({
    managementPath: '/api/v3/plugin-packages/management',
    clientCertificate: 'forbidden',
  }),
  'worker-credential': Object.freeze({
    managementPath: '/api/v3/worker-credentials/management',
    clientCertificate: 'required',
  }),
  automation: Object.freeze({
    managementPath: '/api/v3/automations/management',
    clientCertificate: 'required',
  }),
  approval: Object.freeze({
    managementPath: '/api/v3/approvals/management',
    clientCertificate: 'required',
  }),
  'model-credential': Object.freeze({
    managementPath: '/api/v3/provider-credentials/management',
    clientCertificate: 'required',
  }),
  run: Object.freeze({
    managementPath: '/api/v3/runs/management',
    clientCertificate: 'required',
  }),
});

const MAXIMUM_CONFIG_BYTES = 16 * 1024;
const MAXIMUM_CA_BYTES = 256 * 1024;
const MAXIMUM_CLIENT_CERTIFICATE_BYTES = 256 * 1024;
const MAXIMUM_CLIENT_PRIVATE_KEY_BYTES = 256 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DNS_NAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

type JsonObject = Record<string, unknown>;

export interface ClusterAuthenticatedManagementClientConfigurationSummary {
  readonly schemaVersion: 1;
  readonly managementPath: string;
  readonly transport: 'https';
  readonly clientCertificate: 'forbidden' | 'required';
}

export interface PreparedClusterAuthenticatedManagementClientConfiguration {
  readonly endpoint: URL;
  readonly servername: string;
  readonly port: number;
  readonly requestTimeoutMs: number;
  readonly caBytes: Buffer;
  readonly clientCertificateBytes?: Buffer;
  readonly clientPrivateKeyBytes?: Buffer;
  dispose(): void;
}

export class ClusterPluginPackageManagementClientConfigurationError extends TypeError {
  readonly code = 'QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_CONFIG_INVALID';

  constructor() {
    super('Plugin Package management client configuration is invalid');
    this.name = 'ClusterPluginPackageManagementClientConfigurationError';
  }
}

function configurationFailure(): ClusterPluginPackageManagementClientConfigurationError {
  return new ClusterPluginPackageManagementClientConfigurationError();
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationFailure();
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw configurationFailure();
  }
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') throw configurationFailure();
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) throw configurationFailure();
  return uid;
}

export function readCanonicalFile(
  filePath: string,
  maximumBytes: number,
  mode: 'private' | 'public-integrity',
): Buffer {
  if (
    typeof filePath !== 'string' ||
    !isAbsolute(filePath) ||
    filePath.length > 4_096 ||
    CONTROL_PATTERN.test(filePath)
  ) {
    throw configurationFailure();
  }
  let before;
  try {
    before = lstatSync(filePath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1 ||
      before.size > maximumBytes ||
      realpathSync(filePath) !== filePath
    ) {
      throw configurationFailure();
    }
  } catch (error) {
    if (error instanceof ClusterPluginPackageManagementClientConfigurationError) {
      throw error;
    }
    throw configurationFailure();
  }
  const uid = currentUid();
  const permissions = before.mode & 0o777;
  if (
    (mode === 'private' && (before.uid !== uid || permissions !== 0o600)) ||
    (mode === 'public-integrity' && before.uid !== uid && before.uid !== 0) ||
    (mode === 'public-integrity' && (permissions & 0o022) !== 0)
  ) {
    throw configurationFailure();
  }

  let descriptor = -1;
  let bytes: Buffer | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY |
        ((constants as unknown as Readonly<Record<string, number>>).O_CLOEXEC ??
          0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid ||
      opened.mode !== before.mode ||
      opened.size !== before.size
    ) {
      throw configurationFailure();
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) throw configurationFailure();
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.uid !== opened.uid ||
      after.mode !== opened.mode ||
      after.size !== opened.size
    ) {
      throw configurationFailure();
    }
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof ClusterPluginPackageManagementClientConfigurationError) {
      throw error;
    }
    throw configurationFailure();
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw configurationFailure();
  }
}

export function isReviewedClusterAuthenticatedManagementClientProtocol(
  managementPath: string,
  clientCertificate: 'forbidden' | 'required',
): boolean {
  return Object.values(MANAGEMENT_CLIENT_POLICIES).some(
    (policy) =>
      policy.managementPath === managementPath &&
      policy.clientCertificate === clientCertificate,
  );
}

export function prepareClusterAuthenticatedManagementClientConfiguration(
  configFile: string,
  managementPath: string,
  clientCertificate: 'forbidden' | 'required',
): PreparedClusterAuthenticatedManagementClientConfiguration {
  if (
    !isReviewedClusterAuthenticatedManagementClientProtocol(
      managementPath,
      clientCertificate,
    )
  ) {
    throw configurationFailure();
  }
  let configBytes: Buffer | undefined;
  let caBytes: Buffer | undefined;
  let clientCertificateBytes: Buffer | undefined;
  let clientPrivateKeyBytes: Buffer | undefined;
  try {
    configBytes = readCanonicalFile(
      configFile,
      MAXIMUM_CONFIG_BYTES,
      'private',
    );
    const config = parseJson(configBytes);
    exactObject(
      config,
      clientCertificate === 'required'
        ? [
            'schemaVersion',
            'endpoint',
            'servername',
            'caFile',
            'clientCertificateFile',
            'clientPrivateKeyFile',
            'requestTimeoutMs',
          ]
        : [
            'schemaVersion',
            'endpoint',
            'servername',
            'caFile',
            'requestTimeoutMs',
          ],
    );
    if (
      config.schemaVersion !== 1 ||
      typeof config.endpoint !== 'string' ||
      typeof config.servername !== 'string' ||
      !DNS_NAME_PATTERN.test(config.servername) ||
      isIP(config.servername) !== 0 ||
      typeof config.caFile !== 'string' ||
      (clientCertificate === 'required' &&
        (typeof config.clientCertificateFile !== 'string' ||
          typeof config.clientPrivateKeyFile !== 'string')) ||
      !Number.isSafeInteger(config.requestTimeoutMs) ||
      (config.requestTimeoutMs as number) < 1_000 ||
      (config.requestTimeoutMs as number) > 30_000
    ) {
      throw configurationFailure();
    }
    const servername = config.servername;
    const requestTimeoutMs = config.requestTimeoutMs as number;
    let endpoint: URL;
    try {
      endpoint = new URL(config.endpoint);
    } catch {
      throw configurationFailure();
    }
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.search !== '' ||
      endpoint.hash !== '' ||
      endpoint.pathname !== managementPath ||
      endpoint.hostname !== servername ||
      isIP(endpoint.hostname) !== 0
    ) {
      throw configurationFailure();
    }
    const port = endpoint.port === '' ? 443 : Number(endpoint.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw configurationFailure();
    }
    caBytes = readCanonicalFile(
      config.caFile as string,
      MAXIMUM_CA_BYTES,
      'public-integrity',
    );
    try {
      new X509Certificate(caBytes);
    } catch {
      throw configurationFailure();
    }
    if (clientCertificate === 'required') {
      clientCertificateBytes = readCanonicalFile(
        config.clientCertificateFile as string,
        MAXIMUM_CLIENT_CERTIFICATE_BYTES,
        'public-integrity',
      );
      clientPrivateKeyBytes = readCanonicalFile(
        config.clientPrivateKeyFile as string,
        MAXIMUM_CLIENT_PRIVATE_KEY_BYTES,
        'private',
      );
      try {
        const certificate = new X509Certificate(clientCertificateBytes);
        const privateKey = createPrivateKey(clientPrivateKeyBytes);
        if (!certificate.checkPrivateKey(privateKey)) {
          throw configurationFailure();
        }
      } catch (error) {
        if (error instanceof ClusterPluginPackageManagementClientConfigurationError) {
          throw error;
        }
        throw configurationFailure();
      }
    }
    let disposed = false;
    return Object.freeze({
      endpoint,
      servername,
      port,
      requestTimeoutMs,
      caBytes,
      ...(clientCertificateBytes === undefined
        ? {}
        : {
            clientCertificateBytes,
            clientPrivateKeyBytes: clientPrivateKeyBytes!,
          }),
      dispose() {
        if (disposed) return;
        disposed = true;
        caBytes?.fill(0);
        clientCertificateBytes?.fill(0);
        clientPrivateKeyBytes?.fill(0);
      },
    });
  } catch (error) {
    caBytes?.fill(0);
    clientCertificateBytes?.fill(0);
    clientPrivateKeyBytes?.fill(0);
    if (error instanceof ClusterPluginPackageManagementClientConfigurationError) {
      throw error;
    }
    throw configurationFailure();
  } finally {
    configBytes?.fill(0);
  }
}

export function prepareClusterAuthenticatedManagementClientKindConfiguration(
  configFile: string,
  kind: ClusterAuthenticatedManagementClientKind,
): PreparedClusterAuthenticatedManagementClientConfiguration {
  const policy = MANAGEMENT_CLIENT_POLICIES[kind];
  if (policy === undefined) throw configurationFailure();
  return prepareClusterAuthenticatedManagementClientConfiguration(
    configFile,
    policy.managementPath,
    policy.clientCertificate,
  );
}

export function validateClusterAuthenticatedManagementClientConfiguration(
  configFile: string,
  kind: ClusterAuthenticatedManagementClientKind,
): Readonly<ClusterAuthenticatedManagementClientConfigurationSummary> {
  const policy = MANAGEMENT_CLIENT_POLICIES[kind];
  if (policy === undefined) throw configurationFailure();
  const prepared =
    prepareClusterAuthenticatedManagementClientKindConfiguration(
      configFile,
      kind,
    );
  try {
    return Object.freeze({
      schemaVersion: 1,
      managementPath: policy.managementPath,
      transport: 'https',
      clientCertificate: policy.clientCertificate,
    });
  } finally {
    prepared.dispose();
  }
}
