import { Router } from 'express';
import auth from './auth';
import cookie from './cookie';
import config from './config';
import log from './log';
import cron from './cron';

export default () => {
  const app = Router();
  auth(app);
  cookie(app);
  config(app);
  log(app);
  cron(app);

  return app;
};
