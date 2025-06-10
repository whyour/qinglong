import 'reflect-metadata';
import cluster, { type Worker } from 'cluster';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Container } from 'typedi';
import config from './config';
import Logger from './loaders/logger';
import { monitoringMiddleware } from './middlewares/monitoring';
import { type GrpcServerService } from './services/grpc';
import { type HttpServerService } from './services/http';

interface WorkerMetadata {
  id: number;
  pid: number;
  serviceType: string;
  startTime: Date;
}

class Application {
  private app: express.Application;
  private httpServerService?: HttpServerService;
  private grpcServerService?: GrpcServerService;
  private isShuttingDown = false;
  private workerMetadataMap = new Map<number, WorkerMetadata>();

  constructor() {
    this.app = express();
  }

  async start() {
    try {
      if (cluster.isPrimary) {
        await this.initializeDatabase();
      }
      if (cluster.isPrimary) {
        this.startMasterProcess();
      } else {
        await this.startWorkerProcess();
      }
    } catch (error) {
      Logger.error('Failed to start application:', error);
      process.exit(1);
    }
  }

  private startMasterProcess() {
    this.forkWorker('http');
    this.forkWorker('grpc');

    cluster.on('exit', (worker, code, signal) => {
      const metadata = this.workerMetadataMap.get(worker.id);
      if (metadata) {
        if (!this.isShuttingDown) {
          Logger.error(
            `${metadata.serviceType} worker ${worker.process.pid} died (${
              signal || code
            }). Restarting...`,
          );
          const newWorker = this.forkWorker(metadata.serviceType);
          Logger.info(
            `Restarted ${metadata.serviceType} worker (New PID: ${newWorker.process.pid})`,
          );
        }

        this.workerMetadataMap.delete(worker.id);
      }
    });

    this.setupMasterShutdown();
  }

  private forkWorker(serviceType: string): Worker {
    const worker = cluster.fork({ SERVICE_TYPE: serviceType });

    this.workerMetadataMap.set(worker.id, {
      id: worker.id,
      pid: worker.process.pid!,
      serviceType,
      startTime: new Date(),
    });

    return worker;
  }

  private async initializeDatabase() {
    await require('./loaders/db').default();
  }

  private setupMiddlewares() {
    this.app.use(helmet());
    this.app.use(cors(config.cors));
    this.app.use(compression());
    this.app.use(monitoringMiddleware);
  }

  private setupMasterShutdown() {
    const shutdown = async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      const workers = Object.values(cluster.workers || {});
      const workerPromises: Promise<void>[] = [];

      workers.forEach((worker) => {
        if (worker) {
          const exitPromise = new Promise<void>((resolve) => {
            worker.once('exit', () => {
              Logger.info(`Worker ${worker.process.pid} exited`);
              resolve();
            });

            try {
              worker.send('shutdown');
            } catch (error) {
              Logger.warn(
                `Failed to send shutdown to worker ${worker.process.pid}:`,
                error,
              );
            }
          });

          workerPromises.push(exitPromise);
        }
      });

      try {
        await Promise.race([
          Promise.all(workerPromises),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              Logger.warn('Worker shutdown timeout reached');
              resolve();
            }, 10000);
          }),
        ]);
        process.exit(0);
      } catch (error) {
        Logger.error('Error during worker shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  private async startWorkerProcess() {
    const serviceType = process.env.SERVICE_TYPE;
    if (!serviceType || !['http', 'grpc'].includes(serviceType)) {
      Logger.error('Invalid SERVICE_TYPE:', serviceType);
      process.exit(1);
    }

    Logger.info(`✌️ ${serviceType} worker started (PID: ${process.pid})`);

    try {
      if (serviceType === 'http') {
        await this.startHttpService();
      } else {
        await this.startGrpcService();
      }

      process.send?.('ready');
    } catch (error) {
      Logger.error(`${serviceType} worker failed:`, error);
      process.exit(1);
    }
  }

  private async startHttpService() {
    this.setupMiddlewares();

    const { HttpServerService } = await import('./services/http');
    this.httpServerService = Container.get(HttpServerService);

    await require('./loaders/app').default({ app: this.app });

    const server = await this.httpServerService.initialize(
      this.app,
      config.port,
    );

    await require('./loaders/server').default({ server });
    this.setupWorkerShutdown('http');
  }

  private async startGrpcService() {
    const { GrpcServerService } = await import('./services/grpc');
    this.grpcServerService = Container.get(GrpcServerService);

    await this.grpcServerService.initialize();
    this.setupWorkerShutdown('grpc');
  }

  private setupWorkerShutdown(serviceType: string) {
    process.on('message', (msg) => {
      if (msg === 'shutdown') {
        this.gracefulShutdown(serviceType);
      }
    });

    const shutdown = () => this.gracefulShutdown(serviceType);
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  private async gracefulShutdown(serviceType: string) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    try {
      if (serviceType === 'http') {
        await this.httpServerService?.shutdown();
      } else {
        await this.grpcServerService?.shutdown();
      }
      process.exit(0);
    } catch (error) {
      Logger.error(`[${serviceType}] Error during shutdown:`, error);
      process.exit(1);
    }
  }
}

const app = new Application();
app.start().catch((error) => {
  Logger.error('Application failed to start:', error);
  process.exit(1);
});
