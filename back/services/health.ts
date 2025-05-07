import { Service } from 'typedi';
import Logger from '../loaders/logger';
import { GrpcServerService } from './grpc';
import { HttpServerService } from './http';

interface HealthStatus {
  status: 'ok' | 'error';
  services: {
    http: boolean;
    grpc: boolean;
  };
  metrics: {
    uptime: number;
    memory: {
      used: number;
      total: number;
    };
  };
}

@Service()
export class HealthService {
  private startTime = Date.now();

  constructor(
    private grpcServerService: GrpcServerService,
    private httpServerService: HttpServerService,
  ) {}

  async check(): Promise<HealthStatus> {
    const status: HealthStatus = {
      status: 'ok',
      services: {
        http: true,
        grpc: true,
      },
      metrics: {
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        memory: {
          used: process.memoryUsage().heapUsed,
          total: process.memoryUsage().heapTotal,
        },
      },
    };

    try {
      const httpServer = this.httpServerService.getServer();
      if (!httpServer) {
        status.services.http = false;
        status.status = 'error';
      }
    } catch (err) {
      status.services.http = false;
      status.status = 'error';
      Logger.error('HTTP server check failed:', err);
    }

    try {
      const grpcServer = this.grpcServerService.getServer();
      if (!grpcServer) {
        status.services.grpc = false;
        status.status = 'error';
      }
    } catch (err) {
      status.services.grpc = false;
      status.status = 'error';
      Logger.error('gRPC server check failed:', err);
    }

    return status;
  }
}
