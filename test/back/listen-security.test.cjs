const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const load = require('../helpers/load-security-module.cjs');
const logger = { debug() {}, warn() {}, error() {} };

for (const host of ['127.0.0.1', '::1', '192.0.2.1', '::']) {
  test(`HTTP binding ${host} never broadens an explicit private address`, async () => {
    const Http = load(path.join(__dirname, '../../back/services/http.ts'), {
      '../config': { bindHost: host },
      '../loaders/logger': logger,
      './metrics': { metricsService: { record() {} } },
      typedi: { Service: () => (x) => x },
    }).HttpServerService;
    const instance = new Http();
    const attempted = [];
    instance.tryListen = async (_app, _port, address) => {
      attempted.push(address);
      throw new Error('unavailable');
    };
    await assert.rejects(instance.initialize({}, 5700));
    assert.deepEqual(attempted, host === '::' ? ['::', '0.0.0.0'] : [host]);
  });
  test(`gRPC binding ${host} never broadens an explicit private address`, async () => {
    const attempted = [];
    const Grpc = load(path.join(__dirname, '../../back/services/grpc.ts'), {
      '../config': { bindHostGrpc: host, grpcPort: 5500 },
      '../loaders/logger': logger,
      './metrics': { metricsService: { record() {} } },
      typedi: { Service: () => (x) => x },
      '@grpc/grpc-js': {
        Server: class {
          addService() {}
          bindAsync(address, _credentials, cb) {
            attempted.push(address);
            cb(new Error('unavailable'));
          }
        },
        ServerCredentials: {
          createSsl(_ca, _certs, requireClientCert) {
            assert.equal(requireClientCert, true);
            return {};
          },
        },
      },
      '../protos/cron': { CronService: {} },
      '../protos/health': { HealthService: {} },
      '../protos/api': { ApiService: {} },
      '../schedule/addCron': {},
      '../schedule/delCron': {},
      '../schedule/health': {},
      '../schedule/api': {},
      '../config/grpcCerts': {
        initGrpcCerts: async () => ({
          caCert: 'test',
          serverCert: 'test',
          serverKey: 'test',
        }),
      },
    }).GrpcServerService;
    await assert.rejects(new Grpc().initialize());
    assert.deepEqual(
      attempted,
      host === '::' ? ['[::]:5500', '0.0.0.0:5500'] : [`${host}:5500`],
    );
  });
}
