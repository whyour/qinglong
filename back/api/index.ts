import { Router } from 'express';
import user from './user';
import env from './env';
import config from './config';
import log from './log';
import cron from './cron';
import script from './script';
import open from './open';
import dependence from './dependence';

export default () => {
  const app = Router();
  user(app);
  env(app);
  config(app);
  log(app);
  cron(app);
  script(app);
  open(app);
  dependence(app);

  return app;
};
