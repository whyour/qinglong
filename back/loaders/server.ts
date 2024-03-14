import { Server } from 'http';
import Logger from './logger';
import Sock from './sock';

export default async ({ server }: { server: Server }) => {
  await Sock({ server });
  Logger.info('✌️ Sock loaded');

  process.on('uncaughtException', (error) => {
    Logger.error('Uncaught exception:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    Logger.error('Unhandled rejection:', reason, promise);
  });
};
