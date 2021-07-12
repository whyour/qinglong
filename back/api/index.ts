import { Router } from 'express';
import auth from './auth';
import env from './env';
import config from './config';
import log from './log';
import cron from './cron';
import script from './script';

export default () => {
  const app = Router();
  auth(app);
  env(app);
  config(app);
  log(app);
  cron(app);
  script(app);

  return app;
};
