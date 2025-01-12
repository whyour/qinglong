const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PROTO_PATH = `${process.env.QL_DIR}/back/protos/api.proto`;
const options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
};

const packageDefinition = protoLoader.loadSync(PROTO_PATH, options);
const apiProto = grpc.loadPackageDefinition(packageDefinition).com.ql.api;

const client = new apiProto.Api(
  `0.0.0.0:5500`,
  grpc.credentials.createInsecure(),
  { 'grpc.enable_http_proxy': 0 },
);

const promisify = (fn) => {
  return (...args) => {
    return new Promise((resolve, reject) => {
      fn.call(client, ...args, (err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  };
};

const api = {
  getEnvs: promisify(client.GetEnvs),
  createEnv: promisify(client.CreateEnv),
  updateEnv: promisify(client.UpdateEnv),
  deleteEnvs: promisify(client.DeleteEnvs),
  moveEnv: promisify(client.MoveEnv),
  disableEnvs: promisify(client.DisableEnvs),
  enableEnvs: promisify(client.EnableEnvs),
  updateEnvNames: promisify(client.UpdateEnvNames),
  getEnvById: promisify(client.GetEnvById),
  systemNotify: promisify(client.SystemNotify),
};

module.exports = api;
