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
          
          // Set server timeouts to prevent premature connection drops
          if (this.server) {
            // Timeout for receiving the entire request (including body) - 5 minutes
            this.server.requestTimeout = 300000;
            // Timeout for headers - 2 minutes  
            this.server.headersTimeout = 120000;
            // Keep-alive timeout - 65 seconds (slightly more than typical load balancer timeout)
            this.server.keepAliveTimeout = 65000;
          }
          
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
