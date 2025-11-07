import sockJs from 'sockjs';
import { Server } from 'http';
import { Container } from 'typedi';
import SockService from '../services/sock';
import { getPlatform } from '../config/util';
import { shareStore } from '../shared/store';

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
    if (authInfo) {
      const { token = '', tokens = {} } = authInfo;
      
      // Check legacy token field
      if (headerToken === token) {
        sockService.addClient(conn);

        conn.on('data', (message) => {
          conn.write(message);
        });

        conn.on('close', function () {
          sockService.removeClient(conn);
        });

        return;
      }
      
      // Check platform-specific tokens (support both legacy string and new TokenInfo[] format)
      const platformTokens = tokens[platform];
      if (platformTokens) {
        let isValidToken = false;
        
        if (typeof platformTokens === 'string') {
          // Legacy format: single string token
          isValidToken = headerToken === platformTokens;
        } else if (Array.isArray(platformTokens)) {
          // New format: array of TokenInfo objects
          isValidToken = platformTokens.some((t) => t.value === headerToken);
        }
        
        if (isValidToken) {
          sockService.addClient(conn);

          conn.on('data', (message) => {
            conn.write(message);
          });

          conn.on('close', function () {
            sockService.removeClient(conn);
          });

          return;
        }
      }
    }

    conn.close('404');
  });

  echo.installHandlers(server);
};
