import sockJs from 'sockjs';
import { Server } from 'http';
import { Container } from 'typedi';
import SockService from '../services/sock';
import { getPlatform } from '../config/util';
import { shareStore } from '../shared/store';
import { isValidToken } from '../shared/auth';

export default async ({ server }: { server: Server }) => {
  const echo = sockJs.createServer({ prefix: '/api/ws', log: () => {} });
  const sockService = Container.get(SockService);

  echo.on('connection', async (conn) => {
    if (!conn.headers || !conn.url || !conn.pathname) {
      conn.close('404');
    }

    const authInfo = await shareStore.getAuthInfo();
    const platform = getPlatform(conn.headers['user-agent'] || '') || 'desktop';
    const headerToken = conn.url.replace(`${conn.pathname}?token=`, '');

    if (isValidToken(authInfo, headerToken, platform)) {
      sockService.addClient(conn);

      conn.on('data', (message) => {
        conn.write(message);
      });

      conn.on('close', function () {
        sockService.removeClient(conn);
      });

      return;
    }

    conn.close('404');
  });

  echo.installHandlers(server);
};
