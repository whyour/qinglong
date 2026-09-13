import sockJs, { Connection } from 'sockjs';
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
  const sessions = new Map<Connection, { token: string; platform: string }>();
  let sessionTimer: ReturnType<typeof setInterval> | undefined;
  let checking = false;

  const checkSessions = async () => {
    if (checking || sessions.size === 0) return;
    checking = true;
    // Connections accepted during this read must not use an older snapshot.
    const batch = [...sessions];
    try {
      const current = await shareStore.getAuthInfo();
      for (const [conn, { token, platform }] of batch) {
        if (
          sessions.has(conn) &&
          !isValidToken(current, token, platform, config.jwt.secret)
        ) {
          conn.close('401');
        }
      }
    } catch {
      for (const [conn] of batch) {
        if (sessions.has(conn)) conn.close('401');
      }
    } finally {
      checking = false;
    }
  };

  echo.on('connection', async (conn) => {
    if (!conn.headers || !conn.url || !conn.pathname) {
      conn.close('404');
      return;
    }

    let closed = false;
    conn.on('close', () => {
      closed = true;
      sessions.delete(conn);
      sockService.removeClient(conn);
      if (sessions.size === 0 && sessionTimer) {
        clearInterval(sessionTimer);
        sessionTimer = undefined;
      }
    });

    let authInfo;
    try {
      authInfo = await shareStore.getAuthInfo();
    } catch {
      if (!closed) conn.close('401');
      return;
    }
    if (closed) return;
    const platform = getPlatform(conn.headers['user-agent'] || '') || 'desktop';
    const headerToken = conn.url.replace(`${conn.pathname}?token=`, '');

    if (isValidToken(authInfo, headerToken, platform, config.jwt.secret)) {
      sockService.addClient(conn);
      sessions.set(conn, { token: headerToken, platform });
      if (!sessionTimer) {
        sessionTimer = setInterval(checkSessions, 1000);
        sessionTimer.unref();
      }

      conn.on('data', (message) => {
        conn.write(message);
      });

      return;
    }

    conn.close('404');
  });

  echo.installHandlers(server);
};
