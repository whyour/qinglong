/// <reference types="express" />

export {};

declare global {
  namespace Express {
    interface Request {
      platform: 'desktop' | 'mobile';
      user?: {
        userId?: number;
        role?: number;
      };
      auth?: any;
    }
  }
} 