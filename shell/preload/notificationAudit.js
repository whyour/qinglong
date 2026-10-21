const path = require('node:path');
const fs = require('node:fs');

// A reporting failure must never terminate a script or change its send result.
module.exports = async function reportNotificationAudit(payload) {
  let client;
  try {
    if (!process.env.QL_DIR) return;
    const grpc = require('@grpc/grpc-js');
    const loader = require('@grpc/proto-loader');
    const certDir = path.join(
      process.env.QL_DATA_DIR || path.join(process.env.QL_DIR, 'data'),
      'config/grpc',
    );
    const credentials = grpc.credentials.createSsl(
      fs.readFileSync(path.join(certDir, 'ca.crt')),
      fs.readFileSync(path.join(certDir, 'client.key')),
      fs.readFileSync(path.join(certDir, 'client.crt')),
    );
    const definition = loader.loadSync(
      path.join(process.env.QL_DIR, 'back/protos/api.proto'),
      { keepCase: true, defaults: true },
    );
    const Api = grpc.loadPackageDefinition(definition).com.ql.api.Api;
    client = new Api(
      `localhost:${process.env.GRPC_PORT || '5500'}`,
      credentials,
      { 'grpc.enable_http_proxy': 0 },
    );
    // Python sends all channel results together so they share startup and TLS.
    const records = Array.isArray(payload) ? payload : [payload];
    const deadline = new Date(Date.now() + 5000);
    await Promise.all(
      records.map(
        (record) =>
          new Promise((resolve) => {
            client.RecordNotifyLog(
              record,
              new grpc.Metadata(),
              { deadline },
              () => resolve(),
            );
          }),
      ),
    );
  } catch (_) {
    // Missing certificates, old panels and offline services are best effort.
  } finally {
    if (client) client.close();
  }
};
