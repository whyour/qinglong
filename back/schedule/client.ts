import { credentials, status, Metadata } from '@grpc/grpc-js';
import {
  AddCronRequest,
  AddCronResponse,
  CronClient,
  DeleteCronRequest,
  DeleteCronResponse,
} from '../protos/cron';
import config from '../config';
import { getGrpcCerts } from '../config/grpcCerts';

import { HealthService } from '../protos/health';
import { SchedulerReadiness } from '../shared/schedulerReadiness';

class Client {
  readonly readiness = new SchedulerReadiness(() => this.probe());

  private async waitForReady(timeoutMs: number) {
    try {
      await new Promise<void>((resolve, reject) => {
        this.client.waitForReady(Date.now() + timeoutMs, (err) =>
          err ? reject(err) : resolve()
        );
      });
    } catch (error) {
      this.readiness.invalidate();
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { status: 503 }
      );
    }
  }

  private async probe(): Promise<void> {
    await this.waitForReady(1000);
    await new Promise<void>((resolve, reject) => {
      this.client.makeUnaryRequest(
        HealthService.check.path,
        HealthService.check.requestSerialize,
        HealthService.check.responseDeserialize,
        { service: 'scheduler' },
        { deadline: Date.now() + 1000 },
        (err, res) => err ? reject(err) : res?.status === 1 ? resolve() : reject(new Error('Scheduler unavailable')),
      );
    });
  }
  private _client: CronClient | null = null;

  private get client(): CronClient {
    if (!this._client) {
      const tlsConfig = getGrpcCerts()!;
      this._client = new CronClient(
        `localhost:${config.grpcPort}`,
        credentials.createSsl(
          Buffer.from(tlsConfig.caCert),
          Buffer.from(tlsConfig.clientKey),
          Buffer.from(tlsConfig.clientCert),
        ),
        { 'grpc.enable_http_proxy': 0 },
      );
    }
    return this._client;
  }

  async addCron(
    request: AddCronRequest['crons'],
    replace = false
  ): Promise<AddCronResponse> {
    await this.waitForReady(2000);
    return new Promise((resolve, reject) => {
      this.client.addCron(
        { crons: request, replace },
        new Metadata(),
        { deadline: Date.now() + 5000 },
        (err, res) => {
          if (err) {
            if (err.code === status.UNAVAILABLE) {
              this.readiness.invalidate();
              Object.assign(err, { status: 503 });
            }
            return reject(err);
          }
          resolve(res);
        }
      );
    });
  }

  async delCron(request: DeleteCronRequest['ids']): Promise<DeleteCronResponse> {
    await this.waitForReady(2000);
    return new Promise((resolve, reject) => {
      this.client.delCron({ ids: request }, new Metadata(), { deadline: Date.now() + 5000 }, (err, res) => {
        if (err) {
          if (err.code === status.UNAVAILABLE) {
            this.readiness.invalidate();
            Object.assign(err, { status: 503 });
          }
          return reject(err);
        }
        resolve(res);
      });
    });
  }
}

export default new Client();
