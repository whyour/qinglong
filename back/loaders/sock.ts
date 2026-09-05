import sockJs from 'sockjs';
import { Server } from 'http';
import { Container } from 'typedi';
import SockService from '../services/sock';
import { getPlatform } from '../config/util';
import { shareStore } from '../shared/store';
import { isValidToken } from '../shared/auth';
import config from '../config';

export default async ({ server }: { server: Server }) => {
  const echo = sockJs.createServer({
    prefix: `${config.baseUrl}/api/ws`,
    log: () => {},
  });
  const sockService = Container.get(SockService);

  echo.on('connection', async (conn) => {
    if (!conn.headers || !conn.url || !conn.pathname) {
      conn.close('404');
      return;
    }

    const authInfo = await shareStore.getAuthInfo();
    const platform = getPlatform(conn.headers['user-agent'] || '') || 'desktop';
    const headerToken = conn.url.replace(`${conn.pathname}?token=`, '');

    if (isValidToken(authInfo, headerToken, platform, config.jwt.secret)) {
      sockService.addClient(conn);
      const checkSession = setInterval(async () => {
        try {
          const current = await shareStore.getAuthInfo();
          if (
            !isValidToken(current, headerToken, platform, config.jwt.secret)
          ) {
            conn.close('401');
          }
        } catch {
          conn.close('401');
        }
      }, 1000);
      checkSession.unref();

      conn.on('data', (message) => {
        conn.write(message);
      });

      conn.on('close', function () {
        clearInterval(checkSession);
        sockService.removeClient(conn);
      });

      return;
    }

    conn.close('404');
  });

  echo.installHandlers(server);
};
