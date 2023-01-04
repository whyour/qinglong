import { Server } from 'http';
import Logger from './logger';
import Sock from './sock';

export default async ({ server }: { server: Server }) => {
  await Sock({ server });
  Logger.info('✌️ Sock loaded');

  process.on('SIGINT', () => {
    Logger.info('✌️ Server need close');
    server.close(() => {
      Logger.info('✌️ Server closed');
      process.exit(0);
    });
  });
};
