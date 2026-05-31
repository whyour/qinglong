import { Server, ServerCredentials } from '@grpc/grpc-js';
import { CronService } from '../protos/cron';
import { HealthService } from '../protos/health';
import { ApiService } from '../protos/api';
import { addCron } from '../schedule/addCron';
import { delCron } from '../schedule/delCron';
import { check } from '../schedule/health';
import * as Api from '../schedule/api';
import Logger from '../loaders/logger';
import { promisify } from 'util';
import config from '../config';
import { metricsService } from './metrics';
import { Service } from 'typedi';

@Service()
export class GrpcServerService {
  private server: Server = new Server({ 'grpc.enable_http_proxy': 0 });

  private formatGrpcAddress(host: string, port: number): string {
    if (host === '::') {
      return `[::]:${port}`;
    }
    return `${host}:${port}`;
  }

  async initialize() {
    try {
      this.server.addService(HealthService, { check });
      this.server.addService(CronService, { addCron, delCron });
      this.server.addService(ApiService, Api);

      const grpcPort = config.grpcPort;
      const hostsToTry = [
        config.bindHostGrpc,
        ...(config.bindHostGrpc !== '0.0.0.0' ? ['0.0.0.0'] : [])
      ];
      const bindAsync = promisify(this.server.bindAsync).bind(this.server);

      let lastError: Error | null = null;

      for (const host of hostsToTry) {
        try {
          const address = this.formatGrpcAddress(host, grpcPort);
          await bindAsync(address, ServerCredentials.createInsecure());
          Logger.debug(`✌️ gRPC service started successfully on ${address}`);
          metricsService.record('grpc_service_start', 1, {
            port: grpcPort.toString(),
            host
          });
          return grpcPort;
        } catch (err) {
          lastError = err as Error;
          Logger.warn(`Failed to bind gRPC on ${host}:${grpcPort}, trying next...`, err);
        }
      }

      Logger.error('Failed to start gRPC service on all hosts');
      throw lastError || new Error('Failed to start gRPC service');
    } catch (err) {
      Logger.error('Failed to start gRPC service:', err);
      throw err;
    }
  }

  async shutdown() {
    try {
      if (this.server) {
        await new Promise((resolve) => {
          this.server.tryShutdown(() => {
            Logger.debug('gRPC service stopped');
            metricsService.record('grpc_service_stop', 1);
            resolve(null);
          });
        });
      }
    } catch (err) {
      Logger.error('Error while shutting down gRPC service:', err);
      throw err;
    }
  }

  getServer() {
    return this.server;
  }
}
