import { Router } from 'express';
import auth from './auth';
import cookie from './cookie';
import config from './config';

export default () => {
  const app = Router();
  auth(app);
  cookie(app);
  config(app);
  return app;
};
