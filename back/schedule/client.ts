import { credentials } from '@grpc/grpc-js';
import {
  AddCronRequest,
  AddCronResponse,
  CronClient,
  DeleteCronRequest,
  DeleteCronResponse,
} from '../protos/cron';
import config from '../config';
import { getGrpcCerts } from '../config/grpcCerts';

class Client {
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

  addCron(request: AddCronRequest['crons']): Promise<AddCronResponse> {
    return new Promise((resolve, reject) => {
      this.client.addCron({ crons: request }, (err, res) => {
        if (err) {
          reject(err);
        }
        resolve(res);
      });
    });
  }

  delCron(request: DeleteCronRequest['ids']): Promise<DeleteCronResponse> {
    return new Promise((resolve, reject) => {
      this.client.delCron({ ids: request }, (err, res) => {
        if (err) {
          reject(err);
        }
        resolve(res);
      });
    });
  }
}

export default new Client();
