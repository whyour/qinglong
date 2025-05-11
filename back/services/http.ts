import express from 'express';
import Logger from '../loaders/logger';
import { metricsService } from './metrics';
import { Service } from 'typedi';
import { Server } from 'http';

@Service()
export class HttpServerService {
  private server?: Server = undefined;

  async initialize(expressApp: express.Application, port: number) {
    try {
      return new Promise((resolve, reject) => {
        this.server = expressApp.listen(port, '0.0.0.0', () => {
          Logger.debug(`✌️ HTTP service started successfully`);
          metricsService.record('http_service_start', 1, {
            port: port.toString(),
          });
          resolve(this.server);
        });

        this.server?.on('error', (err: Error) => {
          Logger.error('Failed to start HTTP service:', err);
          reject(err);
        });
      });
    } catch (err) {
      Logger.error('Failed to start HTTP service:', err);
      throw err;
    }
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
