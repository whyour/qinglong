import { Server } from 'http';
import Logger from './logger';
import Sock from './sock';

export default async ({ server }: { server: Server }) => {
  await Sock({ server });
  Logger.info('✌️ Sock loaded');

  process.on('SIGINT', () => {
    Logger.info('✌️ Server need close');
    server.close(() => {
      setTimeout(() => {
        process.exit();
      }, 10000);
    });

    setTimeout(() => {
      console.log('Forcing server close !!!');
      process.exit(1);
    }, 15000);
  });
};
