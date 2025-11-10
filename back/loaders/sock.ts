import sockJs from 'sockjs';
import { Server } from 'http';
import { Container } from 'typedi';
import SockService from '../services/sock';
import { getPlatform } from '../config/util';
import { shareStore } from '../shared/store';
import jwt from 'jsonwebtoken';
import config from '../config';

export default async ({ server }: { server: Server }) => {
  const echo = sockJs.createServer({ prefix: '/api/ws', log: () => {} });
  const sockService = Container.get(SockService);

  echo.on('connection', async (conn) => {
    if (!conn.headers || !conn.url || !conn.pathname) {
      conn.close('404');
    }

    const platform = getPlatform(conn.headers['user-agent'] || '') || 'desktop';
    const headerToken = conn.url.replace(`${conn.pathname}?token=`, '');
    
    let isAuthenticated = false;

    // First try to verify JWT token (for regular users)
    if (headerToken) {
      try {
        jwt.verify(headerToken, config.jwt.secret, { algorithms: ['HS384'] });
        isAuthenticated = true;
      } catch (error) {
        // JWT verification failed, will try authInfo check next
      }
    }

    // Also check against stored token for system admin
    if (!isAuthenticated) {
      const authInfo = await shareStore.getAuthInfo();
      if (authInfo) {
        const { token = '', tokens = {} } = authInfo;
        if (headerToken === token || tokens[platform] === headerToken) {
          isAuthenticated = true;
        }
      }
    }

    if (isAuthenticated) {
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
