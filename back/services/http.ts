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

        // Configure server timeouts for better compatibility with reverse proxies
        // Set keepAliveTimeout to 65 seconds (longer than Apache's default KeepAliveTimeout of 5s)
        // This prevents "Connection reset by peer" errors with Apache reverse proxy
        if (this.server) {
          this.server.keepAliveTimeout = 65000; // 65 seconds
          // headersTimeout should be slightly longer than keepAliveTimeout
          this.server.headersTimeout = 66000; // 66 seconds
          // Set a reasonable request timeout
          this.server.requestTimeout = 120000; // 120 seconds
        }

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
