#!/usr/bin/env node

const {
  startProductionClusterControlApplication,
} = require('../packages/ql3-cluster-control/dist/application-runtime/productionApplication.js');

const REQUIRED_ENVIRONMENT = Object.freeze([
  'QL3_HA_DATABASE_URL',
  'QL3_HA_REPLICA_ID',
  'QL3_HA_APPLICATION_NAME',
]);
const HA_SCHEDULER_MISFIRE_GRACE_MS = 5 * 60_000;

let application;
let stopping;

function send(message) {
  if (typeof process.send === 'function' && process.connected) {
    process.send(message);
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function addressRecord(address) {
  return Object.freeze({
    host: address.host,
    port: address.port,
  });
}

async function stop() {
  stopping ??= (async () => {
    if (application) await application.stop();
    application = undefined;
  })();
  return stopping;
}

async function main() {
  for (const name of REQUIRED_ENVIRONMENT) requiredEnvironment(name);
  const replicaId = requiredEnvironment('QL3_HA_REPLICA_ID');
  const databaseUrl = requiredEnvironment('QL3_HA_DATABASE_URL');
  const applicationName = requiredEnvironment('QL3_HA_APPLICATION_NAME');

  application = await startProductionClusterControlApplication({
    config: {
      enabled: true,
      profile: 'cluster-control',
      http: {
        host: '127.0.0.1',
        port: 0,
        drainTimeoutMs: 2_000,
      },
      database: {
        connection: {
          connectionString: databaseUrl,
          tls: { mode: 'disable' },
        },
        pool: {
          applicationName,
          maxConnections: 1,
          connectionTimeoutMs: 2_000,
        },
      },
      security: {
        apiCredentialPepperKeyring: {
          schemaVersion: 1,
          activePepperKeyId: 'legacy-v1',
          keys: [
            {
              pepperKeyId: 'legacy-v1',
              pepper: 'A'.repeat(43),
            },
          ],
        },
      },
    },
    recovery: {
      ownerId: replicaId,
      providers: [],
      claimLimit: 8,
      maxStartupPasses: 4,
    },
    scheduler: {
      // The fixture deliberately performs promotion, rewind and synchronous
      // rejoin between the original claim and the takeover observation.
      misfireGraceMs: HA_SCHEDULER_MISFIRE_GRACE_MS,
    },
    audit() {},
  });
  if (application.status !== 'active') {
    throw new Error('HA replica unexpectedly remained disabled');
  }
  send({
    type: 'ready',
    replicaId,
    processId: process.pid,
    applicationName,
    address: addressRecord(application.address),
    availability: application.availabilityStatus(),
    evidence: {
      contractName: application.evidence.contractName,
      contractVersion: application.evidence.contractVersion,
      serverMajor: application.evidence.serverMajor,
    },
  });

  process.on('message', async (message) => {
    if (!message || typeof message !== 'object') return;
    const requestId = message.requestId;
    try {
      if (message.type === 'status') {
        send({
          type: 'status',
          requestId,
          replicaId,
          availability: application?.availabilityStatus() ?? 'stopped',
        });
        return;
      }
      if (message.type === 'stop') {
        await stop();
        send({ type: 'stopped', requestId, replicaId });
        setImmediate(() => process.exit(0));
      }
    } catch (error) {
      send({
        type: 'request-error',
        requestId,
        replicaId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(0));
  });
}

process.once('disconnect', () => {
  void stop().finally(() => process.exit(0));
});

main().catch((error) => {
  send({
    type: 'fatal',
    message: error instanceof Error ? error.message : String(error),
  });
  process.stderr.write(
    `ql3 PostgreSQL HA replica failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  setImmediate(() => process.exit(1));
});
