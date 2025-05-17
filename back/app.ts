import 'reflect-metadata';
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

class Application {
  private app: express.Application;
  private httpServerService?: HttpServerService;
  private grpcServerService?: GrpcServerService;
  private isShuttingDown = false;

  constructor() {
    this.app = express();
  }

  async start() {
    try {
      await this.initializeDatabase();
      await this.initServer();
      this.setupMiddlewares();
      await this.initializeServices();
      this.setupGracefulShutdown();

      process.send?.('ready');
    } catch (error) {
      Logger.error('Failed to start application:', error);
      process.exit(1);
    }
  }

  async initServer() {
    const { HttpServerService } = await import('./services/http');
    const { GrpcServerService } = await import('./services/grpc');
    this.httpServerService = Container.get(HttpServerService);
    this.grpcServerService = Container.get(GrpcServerService);
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

  private async initializeServices() {
    await this.grpcServerService?.initialize();

    await require('./loaders/app').default({ app: this.app });

    const server = await this.httpServerService?.initialize(
      this.app,
      config.port,
    );

    await require('./loaders/server').default({ server });
  }

  private setupGracefulShutdown() {
    const shutdown = async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      Logger.info('Shutting down services...');
      try {
        await Promise.all([
          this.grpcServerService?.shutdown(),
          this.httpServerService?.shutdown(),
        ]);
        process.exit(0);
      } catch (error) {
        Logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
}

const app = new Application();
app.start().catch((error) => {
  Logger.error('Application failed to start:', error);
  process.exit(1);
});
