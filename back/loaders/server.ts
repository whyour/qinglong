import { Server } from 'http';
import Logger from './logger';
import Sock from './sock';

export default async ({ server }: { server: Server }) => {
  await Sock({ server });
  Logger.info('✌️ Sock loaded');
  let exitTime = 0;
  let timer: NodeJS.Timeout;

  process.on('SIGINT', (singal) => {
    Logger.warn(`Server need close, singal ${singal}`);
    console.warn(`Server need close, singal ${singal}`);
    exitTime++;
    if (exitTime >= 3) {
      Logger.warn('Forcing server close');
      console.warn('Forcing server close');
      clearTimeout(timer);
      process.exit(1);
    }
    server.close(() => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        process.exit();
      }, 15000);
    });
  });

  process.on('uncaughtException', (error) => {
    Logger.error('Uncaught exception:', error);
    console.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    Logger.error('Unhandled rejection:', reason, promise);
    console.error('Unhandled rejection:', reason, promise);
    process.exit(1);
  });
};
