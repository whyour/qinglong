/// <reference types="express" />

export {};

declare global {
  namespace Express {
    interface Request {
      platform: 'desktop' | 'mobile';
    }
  }
} 