import express from 'express';
import Logger from '../loaders/logger';
import { metricsService } from './metrics';
import { Service } from 'typedi';
import { Server } from 'http';
import config from '../config';

@Service()
export class HttpServerService {
  private server?: Server = undefined;

  async initialize(expressApp: express.Application, port: number) {
    const hostsToTry = [
      config.bindHost,
      ...(config.bindHost !== '0.0.0.0' ? ['0.0.0.0'] : [])
    ];

    let lastError: Error | null = null;

    for (const host of hostsToTry) {
      try {
        const server = await this.tryListen(expressApp, port, host);
        Logger.debug(`✌️ HTTP service started successfully on ${host}:${port}`);
        metricsService.record('http_service_start', 1, {
          port: port.toString(),
          host
        });
        this.server = server;
        return server;
      } catch (err) {
        lastError = err as Error;
        Logger.warn(`Failed to bind HTTP on ${host}:${port}, trying next...`, err);
      }
    }

    Logger.error('Failed to start HTTP service on all hosts');
    throw lastError || new Error('Failed to start HTTP service');
  }

  private async tryListen(expressApp: express.Application, port: number, host: string): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = expressApp.listen(port, host, () => {
        resolve(server);
      });

      server.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
    });
  }

  async shutdown() {
    try {
      if (this.server) {
        await new Promise((resolve) => {
          this.server?.close(() => {
            Logger.debug('HTTP service stopped');
            metricsService.record('http_service_stop', 1);
            resolve(null);
          });
        });
      }
    } catch (err) {
      Logger.error('Error while shutting down HTTP service:', err);
      throw err;
    }
  }

  getServer() {
    return this.server;
  }
}
