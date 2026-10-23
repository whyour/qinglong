// A single, disposable backend process. Resolve startup dependencies, but never
// run appLoader: its initData/initTask hooks install dependencies and start user work.
import 'reflect-metadata';
import dns from 'dns';
import http from 'http';
// The first scheduler connection can outlive its short RPC deadline. Let the
// normal single-flight recovery finish within the supervised startup budget.
async function waitForUpgradeScheduler(
  readiness: {
    recover(): Promise<boolean>;
  },
  timeoutMs: number,
  retryMs = 250,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await readiness.recover()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(retryMs, remaining)),
    );
  } while (Date.now() < deadline);
  throw new Error('Upgrade scheduler readiness failed');
}
async function probeUpgrade() {
  if (!process.send || process.env.QL_UPGRADE_PROBE !== '1')
    throw new Error('Upgrade probe requires its isolated supervisor');
  dns.setDefaultResultOrder('ipv4first');
  const { default: config } = await import('../config');
  const { database } = await import('../data');
  const { default: loadDatabase } = await import('../loaders/db');
  const { Container } = await import('typedi');
  const { GrpcServerService } = await import('../services/grpc');
  const { HttpServerService } = await import('../services/http');
  const { createHttpApplication } = await import('../loaders/httpApplication');
  const { default: loadServer } = await import('../loaders/server');
  const { default: loadExpress } = await import('../loaders/express');
  await import('../loaders/app'); // Resolve normal startup hooks without running them.
  const { default: inject } = await import('../loaders/depInjector');
  const grpc = Container.get(GrpcServerService);
  const server = Container.get(HttpServerService);
  try {
    await loadDatabase();
    // Exercise an actual on-disk transaction as well as schema initialization.
    await database.transaction(async () => {
      await database.query('CREATE TABLE upgrade_probe (value INTEGER)');
      await database.query('INSERT INTO upgrade_probe VALUES (42)');
      const rows = await database.query('SELECT value FROM upgrade_probe');
      if (
        (
          rows[0] as {
            value: number;
          }
        )?.value !== 42
      )
        throw new Error('Upgrade database readback failed');
    });
    inject();
    config.grpcPort = await grpc.initialize();
    const { default: cronClient } = await import('../schedule/client');
    cronClient.readiness.configure(async () => {});
    await waitForUpgradeScheduler(
      cronClient.readiness,
      process.arch === 'arm' &&
        Number(
          (
            process.config.variables as {
              arm_version?: string | number;
            }
          ).arm_version,
        ) === 6
        ? 60000
        : 10000,
    );
    const app = await createHttpApplication();
    loadExpress({ app });
    const listener = await server.initialize(app, 0);
    await loadServer({ server: listener });
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new Error('No probe HTTP port');
    const health = await new Promise<any>((resolve, reject) => {
      const request = http.get(
        `http://127.0.0.1:${address.port}/api/health`,
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const result = JSON.parse(body);
              if (
                response.statusCode !== 200 ||
                result.code !== 200 ||
                result.data?.status !== 'ok' ||
                !result.data.services?.grpc ||
                !result.data.services?.http
              )
                throw new Error('Upgrade HTTP/gRPC health check failed');
              resolve(result.data);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.setTimeout(10000, () =>
        request.destroy(new Error('Upgrade health request timed out')),
      );
      request.on('error', reject);
    });
    process.send!({
      type: 'upgrade-probe',
      ok: true,
      build: health.build,
      memory: process.memoryUsage(),
      pid: process.pid,
    });
  } finally {
    await server.shutdown();
    grpc.getServer().forceShutdown();
    await database.close();
  }
}
process.once('disconnect', () => process.exit(1));
probeUpgrade()
  .then(() => process.exit(0))
  .catch((error) => {
    process.send?.({
      type: 'upgrade-probe',
      ok: false,
      code: error.code,
      message: error.message,
      stack: error.stack,
    });
    console.error(error);
    process.exit(1);
  });
