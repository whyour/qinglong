/** Bounded read-only readiness probe for reviewed cluster management clients. */
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { TextDecoder } from 'node:util';

import {
  ClusterPluginPackageManagementClientRequestError,
  type ClusterAuthenticatedManagementClientKind,
  type ClusterPluginPackageManagementClientConnectionOptions,
  type ClusterPluginPackageManagementClientRawConnection,
} from './pluginPackageManagementClient';
import {
  ClusterPluginPackageManagementClientConfigurationError,
  prepareClusterAuthenticatedManagementClientKindConfiguration,
  type PreparedClusterAuthenticatedManagementClientConfiguration,
} from './managementClientConfiguration';

const MAXIMUM_RESPONSE_BYTES = 1_024;

export interface ClusterAuthenticatedManagementClientReadiness {
  readonly schemaVersion: 1;
  readonly transport: 'https';
  readonly ready: boolean;
}

function configurationFailure(): ClusterPluginPackageManagementClientConfigurationError {
  return new ClusterPluginPackageManagementClientConfigurationError();
}

function rawHeaderCount(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function readinessEnvelope(
  value: unknown,
): Readonly<{ schemaVersion: unknown; status: unknown }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'schemaVersion' ||
    keys[1] !== 'status'
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  return value as Readonly<{ schemaVersion: unknown; status: unknown }>;
}

function connectionOptionsValid(
  value: ClusterPluginPackageManagementClientConnectionOptions | undefined,
): boolean {
  return (
    value === undefined ||
    (!!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof value.connect === 'function')
  );
}

export async function probeClusterAuthenticatedManagementClientReadiness(
  configFile: string,
  kind: ClusterAuthenticatedManagementClientKind,
  connectionOptions?: ClusterPluginPackageManagementClientConnectionOptions,
): Promise<Readonly<ClusterAuthenticatedManagementClientReadiness>> {
  if (!connectionOptionsValid(connectionOptions)) throw configurationFailure();
  let prepared:
    | PreparedClusterAuthenticatedManagementClientConfiguration
    | undefined;
  let rawConnection:
    | ClusterPluginPackageManagementClientRawConnection
    | undefined;
  let connectionAgent: HttpsAgent | undefined;
  try {
    prepared = prepareClusterAuthenticatedManagementClientKindConfiguration(
      configFile,
      kind,
    );
    const {
      endpoint,
      servername,
      port,
      requestTimeoutMs,
      caBytes,
      clientCertificateBytes,
      clientPrivateKeyBytes,
    } = prepared;
    if (connectionOptions) {
      rawConnection = await connectionOptions.connect(
        Object.freeze({ hostname: endpoint.hostname, port }),
      );
      if (
        !rawConnection ||
        typeof rawConnection !== 'object' ||
        !(rawConnection.stream instanceof Duplex) ||
        typeof rawConnection.close !== 'function'
      ) {
        throw new ClusterPluginPackageManagementClientRequestError();
      }
      const establishedConnection = rawConnection;
      connectionAgent = new HttpsAgent({
        keepAlive: false,
        maxSockets: 1,
        maxFreeSockets: 0,
      });
      connectionAgent.createConnection = (_options, callback) => {
        const socket = tlsConnect({
          socket: establishedConnection.stream,
          ca: caBytes,
          ...(clientCertificateBytes === undefined
            ? {}
            : {
                cert: clientCertificateBytes,
                key: clientPrivateKeyBytes,
              }),
          servername,
          minVersion: 'TLSv1.3',
          maxVersion: 'TLSv1.3',
          rejectUnauthorized: true,
        });
        if (callback) {
          let reported = false;
          socket.once('secureConnect', () => {
            if (reported) return;
            reported = true;
            callback(null, socket);
          });
          socket.once('error', (error) => {
            if (reported) return;
            reported = true;
            callback(error, socket);
          });
        }
        return socket;
      };
    }
    return await new Promise((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let length = 0;
      const clearChunks = () => {
        for (const chunk of chunks) chunk.fill(0);
      };
      const finish = (
        error: unknown,
        result?: Readonly<ClusterAuthenticatedManagementClientReadiness>,
      ) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(result!);
      };
      const request = httpsRequest(
        {
          protocol: 'https:',
          hostname: endpoint.hostname,
          port,
          path: '/readyz',
          method: 'GET',
          servername,
          ca: caBytes,
          ...(clientCertificateBytes === undefined
            ? {}
            : {
                cert: clientCertificateBytes,
                key: clientPrivateKeyBytes,
              }),
          minVersion: 'TLSv1.3',
          maxVersion: 'TLSv1.3',
          rejectUnauthorized: true,
          agent: connectionAgent ?? false,
          headers: {
            accept: 'application/json',
            'accept-encoding': 'identity',
            connection: 'close',
          },
        },
        (response) => {
          response.once('aborted', () => {
            clearChunks();
            finish(new ClusterPluginPackageManagementClientRequestError());
          });
          response.once('error', (error) => {
            clearChunks();
            finish(
              new ClusterPluginPackageManagementClientRequestError(error),
            );
          });
          response.on('data', (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += bytes.length;
            if (length > MAXIMUM_RESPONSE_BYTES) {
              const error =
                new ClusterPluginPackageManagementClientRequestError();
              bytes.fill(0);
              clearChunks();
              response.destroy();
              request.destroy(error);
              finish(error);
              return;
            }
            chunks.push(bytes);
          });
          response.once('end', () => {
            try {
              if (
                rawHeaderCount(response.rawHeaders, 'content-type') !== 1 ||
                response.headers['content-type'] !==
                  'application/json; charset=utf-8' ||
                response.headers['content-encoding'] !== undefined ||
                rawHeaderCount(response.rawHeaders, 'content-length') > 1 ||
                (response.headers['content-length'] !== undefined &&
                  (!/^(?:0|[1-9][0-9]*)$/.test(
                    response.headers['content-length'],
                  ) ||
                    Number(response.headers['content-length']) !== length))
              ) {
                throw new ClusterPluginPackageManagementClientRequestError();
              }
              const bytes = Buffer.concat(chunks, length);
              let parsed: unknown;
              try {
                parsed = JSON.parse(
                  new TextDecoder('utf-8', { fatal: true }).decode(bytes),
                );
              } finally {
                bytes.fill(0);
                clearChunks();
              }
              const record = readinessEnvelope(parsed);
              const ready =
                response.statusCode === 200 && record.status === 'ready';
              const notReady =
                response.statusCode === 503 &&
                record.status === 'not_ready';
              if (record.schemaVersion !== 1 || (!ready && !notReady)) {
                throw new ClusterPluginPackageManagementClientRequestError();
              }
              finish(
                undefined,
                Object.freeze({
                  schemaVersion: 1,
                  transport: 'https',
                  ready,
                }),
              );
            } catch (error) {
              finish(
                error instanceof
                  ClusterPluginPackageManagementClientRequestError
                  ? error
                  : new ClusterPluginPackageManagementClientRequestError(
                      error,
                    ),
              );
            }
          });
        },
      );
      request.setTimeout(requestTimeoutMs, () => {
        request.destroy(
          new ClusterPluginPackageManagementClientRequestError(),
        );
      });
      request.once('error', (error) => {
        clearChunks();
        finish(
          error instanceof ClusterPluginPackageManagementClientRequestError
            ? error
            : new ClusterPluginPackageManagementClientRequestError(error),
        );
      });
      request.end();
    });
  } catch (error) {
    if (
      error instanceof ClusterPluginPackageManagementClientConfigurationError ||
      error instanceof ClusterPluginPackageManagementClientRequestError
    ) {
      throw error;
    }
    throw new ClusterPluginPackageManagementClientRequestError(error);
  } finally {
    connectionAgent?.destroy();
    try {
      await rawConnection?.close();
    } catch {
      // Probe outcome remains authoritative after bounded resource cleanup.
    }
    prepared?.dispose();
  }
}
