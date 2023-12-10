import { credentials } from '@grpc/grpc-js';
import {
  AddCronRequest,
  AddCronResponse,
  CronClient,
  DeleteCronRequest,
  DeleteCronResponse,
} from '../protos/cron';
import config from '../config';

class Client {
  private client = new CronClient(
    `0.0.0.0:${config.cronPort}`,
    credentials.createInsecure(),
    { 'grpc.enable_http_proxy': 0 },
  );

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
