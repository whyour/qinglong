const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { join } = require('path');

class GrpcClient {
  static #config = {
    protoPath: join(process.env.QL_DIR, 'back/protos/api.proto'),
    serverAddress: '0.0.0.0:5500',
    protoOptions: {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
    },
    grpcOptions: {
      'grpc.enable_http_proxy': 0,
      'grpc.keepalive_time_ms': 120000,
      'grpc.keepalive_timeout_ms': 20000,
      'grpc.max_receive_message_length': 100 * 1024 * 1024,
    },
    defaultTimeout: 30000,
  };

  static #methods = [
    'getEnvs',
    'createEnv',
    'updateEnv',
    'deleteEnvs',
    'moveEnv',
    'disableEnvs',
    'enableEnvs',
    'updateEnvNames',
    'getEnvById',
    'systemNotify',
    'getCronDetail',
    'createCron',
    'updateCron',
    'deleteCrons',
  ];

  #client;
  #api = {};

  constructor() {
    this.#initializeClient();
    this.#bindMethods();
  }

  #initializeClient() {
    try {
      const { protoPath, protoOptions, serverAddress, grpcOptions } =
        GrpcClient.#config;

      const packageDefinition = protoLoader.loadSync(protoPath, protoOptions);
      const apiProto = grpc.loadPackageDefinition(packageDefinition).com.ql.api;

      this.#client = new apiProto.Api(
        serverAddress,
        grpc.credentials.createInsecure(),
        grpcOptions,
      );

      this.#checkConnection();
    } catch (error) {
      console.error('Failed to initialize gRPC client:', error);
      process.exit(1);
    }
  }

  #checkConnection() {
    this.#client.waitForReady(Date.now() + 5000, (error) => {
      if (error) {
        console.error('gRPC client connection failed:', error);
        process.exit(1);
      }
    });
  }

  #promisifyMethod(methodName) {
    const capitalizedMethod =
      methodName.charAt(0).toUpperCase() + methodName.slice(1);
    const method = this.#client[capitalizedMethod].bind(this.#client);

    return async (params = {}) => {
      return new Promise((resolve, reject) => {
        const metadata = new grpc.Metadata();
        const deadline = new Date(
          Date.now() + GrpcClient.#config.defaultTimeout,
        );

        method(params, metadata, { deadline }, (error, response) => {
          if (error) {
            return reject(error);
          }
          resolve(response);
        });
      });
    };
  }

  #bindMethods() {
    GrpcClient.#methods.forEach((method) => {
      this.#api[method] = this.#promisifyMethod(method);
    });
  }

  getApi() {
    return {
      ...this.#api,
      close: this.close.bind(this),
    };
  }

  close() {
    if (this.#client) {
      this.#client.close();
      this.#client = null;
    }
  }
}

const grpcClient = new GrpcClient();

process.on('SIGTERM', () => {
  grpcClient.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  grpcClient.close();
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  if (reason instanceof Error) {
    if (reason.stack) {
      const relevantStack = reason.stack
        .split('\n')
        .filter((line) => {
          return (
            !line.includes('node:internal') &&
            !line.includes('node_modules/@grpc') &&
            !line.includes('processTicksAndRejections')
          );
        })
        .join('\n');
      console.error(relevantStack);
    }
  } else {
    console.error(reason);
  }
});

module.exports = grpcClient.getApi();
