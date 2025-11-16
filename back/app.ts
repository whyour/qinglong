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
  private httpWorker?: Worker;

  constructor() {
    this.app = express();
    // 创建一个全局中间件，删除查询参数中的t
    this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.query.t) {
        delete req.query.t;
      }
      next();
    });
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
    // Fork gRPC worker first and wait for it to be ready
    const grpcWorker = this.forkWorker('grpc');
    
    // Wait for gRPC worker to signal it's ready before starting HTTP worker
    this.waitForWorkerReady(grpcWorker, 30000)
      .then(() => {
        Logger.info('✌️ gRPC worker is ready, starting HTTP worker');
        this.httpWorker = this.forkWorker('http');
      })
      .catch((error) => {
        Logger.error('✌️ Failed to wait for gRPC worker:', error);
        process.exit(1);
      });

    cluster.on('exit', (worker, code, signal) => {
      const metadata = this.workerMetadataMap.get(worker.id);
      if (metadata) {
        if (!this.isShuttingDown) {
          Logger.error(
            `✌️ ${metadata.serviceType} worker ${worker.process.pid} died (${signal || code
            }). Restarting...`,
          );
          // If gRPC worker died, restart it and wait for it to be ready
          if (metadata.serviceType === 'grpc') {
            const newGrpcWorker = this.forkWorker('grpc');
            this.waitForWorkerReady(newGrpcWorker, 30000)
              .then(() => {
                Logger.info('✌️ gRPC worker restarted and ready');
                // Re-register cron jobs by notifying the HTTP worker
                if (this.httpWorker) {
                  try {
                    this.httpWorker.send('reregister-crons');
                    Logger.info('✌️ Sent reregister-crons message to HTTP worker');
                  } catch (error) {
                    Logger.error('✌️ Failed to send reregister-crons message:', error);
                  }
                }
              })
              .catch((error) => {
                Logger.error('✌️ Failed to restart gRPC worker:', error);
                process.exit(1);
              });
          } else {
            // For HTTP worker, just restart it
            const newWorker = this.forkWorker(metadata.serviceType);
            this.httpWorker = newWorker;
            Logger.info(`✌️ Restarted ${metadata.serviceType} worker (PID: ${newWorker.process.pid})`);
          }
        }

        this.workerMetadataMap.delete(worker.id);
      }
    });

    this.setupMasterShutdown();
  }

  private waitForWorkerReady(worker: Worker, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const messageHandler = (msg: any) => {
        if (msg === 'ready') {
          worker.removeListener('message', messageHandler);
          clearTimeout(timeoutId);
          resolve();
        }
      };
      worker.on('message', messageHandler);
      
      // Timeout after specified milliseconds
      const timeoutId = setTimeout(() => {
        worker.removeListener('message', messageHandler);
        reject(new Error(`Worker failed to start within ${timeoutMs / 1000} seconds`));
      }, timeoutMs);
    });
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
    const dbLoader = await import('./loaders/db');
    await dbLoader.default();
  }

  private setupMiddlewares() {
    this.app.use(helmet({
      contentSecurityPolicy: false,
    }));
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
              Logger.info(`✌️ Worker ${worker.process.pid} exited`);
              resolve();
            });

            try {
              worker.send('shutdown');
            } catch (error) {
              Logger.warn(
                `✌️ Failed to send shutdown to worker ${worker.process.pid}:`,
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
              Logger.warn('✌️ Worker shutdown timeout reached');
              resolve();
            }, 10000);
          }),
        ]);
        process.exit(0);
      } catch (error) {
        Logger.error('✌️ Error during worker shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  private async startWorkerProcess() {
    const serviceType = process.env.SERVICE_TYPE;
    if (!serviceType || !['http', 'grpc'].includes(serviceType)) {
      Logger.error('✌️ Invalid SERVICE_TYPE:', serviceType);
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
      Logger.error(`✌️ ${serviceType} worker failed:`, error);
      process.exit(1);
    }
  }

  private async startHttpService() {
    this.setupMiddlewares();

    const { HttpServerService } = await import('./services/http');
    this.httpServerService = Container.get(HttpServerService);

    const appLoader = await import('./loaders/app');
    await appLoader.default({ app: this.app });

    const server = await this.httpServerService.initialize(
      this.app,
      config.port,
    );

    const serverLoader = await import('./loaders/server');
    await (serverLoader.default as any)({ server });
    this.setupWorkerShutdown('http');
  }

  private async startGrpcService() {
    const { GrpcServerService } = await import('./services/grpc');
    this.grpcServerService = Container.get(GrpcServerService);

    await this.grpcServerService.initialize();
    this.setupWorkerShutdown('grpc');
  }

  private setupWorkerShutdown(serviceType: string) {
    process.on('message', async (msg) => {
      if (msg === 'shutdown') {
        this.gracefulShutdown(serviceType);
      } else if (msg === 'reregister-crons' && serviceType === 'http') {
        // Re-register cron jobs when gRPC worker restarts
        try {
          Logger.info('✌️ Received reregister-crons message, re-registering cron jobs...');
          const CronService = (await import('./services/cron')).default;
          const cronService = Container.get(CronService);
          await cronService.autosave_crontab();
          Logger.info('✌️ Cron jobs re-registered successfully');
        } catch (error) {
          Logger.error('✌️ Failed to re-register cron jobs:', error);
        }
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
      Logger.error(`✌️ [${serviceType}] Error during shutdown:`, error);
      process.exit(1);
    }
  }
}

const app = new Application();
app.start().catch((error) => {
  Logger.error('🙅‍♀️ Application failed to start:', error);
  process.exit(1);
});
