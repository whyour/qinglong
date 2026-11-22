const { readFileSync } = require('fs');
const { join } = require('path');

class GrpcClient {
  static #certDir = join(
    process.env.QL_DATA_DIR || join(process.env.QL_DIR, 'data'),
    'config/grpc',
  );

  static #loadTlsCredentials(grpc) {
    try {
      return grpc.credentials.createSsl(
        readFileSync(join(GrpcClient.#certDir, 'ca.crt')),
        readFileSync(join(GrpcClient.#certDir, 'client.key')),
        readFileSync(join(GrpcClient.#certDir, 'client.crt')),
      );
    } catch {
      return grpc.credentials.createInsecure();
    }
  }

  static #config = {
    protoPath: join(process.env.QL_DIR, 'back/protos/api.proto'),
    serverAddress: `localhost:${process.env.GRPC_PORT || '5500'}`,
    protoOptions: {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
    },
    grpcOptions: {
      'grpc.enable_http_proxy': 0,
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
    'recordNotifyLog',
    'getCronDetail',
    'createCron',
    'updateCron',
    'deleteCrons',
    'getCrons',
    'getCronById',
    'enableCrons',
    'disableCrons',
    'runCrons',
  ];

  #client;
  #Metadata;
  #closed = false;
  #api = {};

  constructor() {
    this.#bindMethods();
  }

  #initializeClient() {
    // The panel dependencies resolve as they did before the task's global-path hook.
    module.loadingPanelDependencies = true;
    try {
      // Resolve explicitly: Node can cache a previous task require by parent directory.
      const grpc = require(require.resolve('@grpc/grpc-js'));
      const protoLoader = require(require.resolve('@grpc/proto-loader'));
      this.#Metadata = grpc.Metadata;
      const { protoPath, protoOptions, serverAddress, grpcOptions } =
        GrpcClient.#config;

      const packageDefinition = protoLoader.loadSync(protoPath, protoOptions);
      const apiProto = grpc.loadPackageDefinition(packageDefinition).com.ql.api;

      this.#client = new apiProto.Api(
        serverAddress,
        GrpcClient.#loadTlsCredentials(grpc),
        grpcOptions,
      );
    } catch (error) {
      throw new Error('Failed to initialize gRPC client: ' + error.message, {
        cause: error,
      });
    } finally {
      module.loadingPanelDependencies = false;
    }
  }

  #promisifyMethod(methodName) {
    const capitalizedMethod =
      methodName.charAt(0).toUpperCase() + methodName.slice(1);

    return async (params = {}) => {
      if (this.#closed) throw new Error('Channel has been shut down');
      if (!this.#client) this.#initializeClient();
      return new Promise((resolve, reject) => {
        const metadata = new this.#Metadata();
        const deadline = new Date(
          Date.now() + GrpcClient.#config.defaultTimeout,
        );

        this.#client[capitalizedMethod](
          params,
          metadata,
          { deadline },
          (error, response) => {
            if (error) {
              return reject(error);
            }
            resolve(response);
          },
        );
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
    this.#closed = true;
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
