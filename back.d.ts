import 'express';

declare global {
  namespace Express {
    interface Request {
      platform: string;
    }
  }
}
