import { Router } from 'express';
import * as pty from 'node-pty';
import os from 'os';
import Container from 'typedi';
import { Logger } from 'winston';
// Whether to use binary transport.
const USE_BINARY = os.platform() !== 'win32';
const route = Router();

export default (app: Router) => {
  const terminals = {};
  const logs = {};
  app.use('/', route);
  route.post('/terminals', (req, res) => {
    const logger: Logger = Container.get('logger');
    const env = Object.assign({}, process.env);
    env['COLORTERM'] = 'truecolor';
    const cols = parseInt(req.query.cols as string),
      rows = parseInt(req.query.rows as string),
      term = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : 'bash', [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: process.platform === 'win32' ? undefined : env.PWD,
        env: env,
        encoding: USE_BINARY ? null : 'utf8',
      });

    logger.info('Created terminal with PID: ' + term.pid);
    terminals[term.pid] = term;
    logs[term.pid] = '';
    term.on('data', function (data) {
      logs[term.pid] += data;
    });
    res.send(term.pid.toString());
    res.end();
  });

  route.post('/terminals/:pid/size', (req, res) => {
    const logger: Logger = Container.get('logger');
    const pid = parseInt(req.params.pid),
      cols = parseInt(req.query.cols as string),
      rows = parseInt(req.query.rows as string),
      term = terminals[pid];

    term.resize(cols, rows);
    logger.info(
      'Resized terminal ' +
        pid +
        ' to ' +
        cols +
        ' cols and ' +
        rows +
        ' rows.',
    );
    res.end();
  });

  // @ts-ignore
  route.ws('/terminals/:pid', function (ws, req) {
    const logger: Logger = Container.get('logger');
    const term = terminals[parseInt(req.params.pid)];
    logger.info('Connected to terminal ' + term.pid);
    ws.send(logs[term.pid]);

    // string message buffering
    function buffer(socket, timeout) {
      let s = '';
      let sender = null;
      return (data) => {
        s += data;
        if (!sender) {
          sender = setTimeout(() => {
            socket.send(s);
            s = '';
            sender = null;
          }, timeout);
        }
      };
    }
    // binary message buffering
    function bufferUtf8(socket, timeout) {
      let buffer = [];
      let sender = null;
      let length = 0;
      return (data) => {
        buffer.push(data);
        length += data.length;
        if (!sender) {
          sender = setTimeout(() => {
            socket.send(Buffer.concat(buffer, length));
            buffer = [];
            sender = null;
            length = 0;
          }, timeout);
        }
      };
    }
    const send = USE_BINARY ? bufferUtf8(ws, 5) : buffer(ws, 5);

    term.on('data', function (data) {
      try {
        send(data);
      } catch (ex) {
        // The WebSocket is not open, ignore
      }
    });
    ws.on('message', function (msg) {
      term.write(msg);
    });
    ws.on('close', function () {
      term.kill();
      logger.info('Closed terminal ' + term.pid);
      // Clean things up
      delete terminals[term.pid];
      delete logs[term.pid];
    });
  });
};
