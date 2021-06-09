import { Inject, Service } from 'typedi';
import * as pty from 'node-pty';
import os from 'os';
import winston from 'winston';
// Whether to use binary transport.
const USE_BINARY = os.platform() !== 'win32';

@Service()
export default class TerminalService {
  private terminals = {};
  private logs = {};

  constructor(@Inject('logger') private logger: winston.Logger) {}

  createTerminal(req) {
    const that = this;
    const env = Object.assign({}, process.env);
    env['COLORTERM'] = 'truecolor';
    const cols = parseInt(req.query.cols);
    const rows = parseInt(req.query.rows);
    const term = pty.spawn(
      process.platform === 'win32' ? 'cmd.exe' : 'bash',
      [],
      {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: process.platform === 'win32' ? undefined : env.PWD,
        env: env,
        encoding: USE_BINARY ? null : 'utf8',
      },
    );

    this.logger.info('Created terminal with PID: ' + term.pid);
    that.terminals[term.pid] = term;
    that.logs[term.pid] = '';
    term.on('data', function (data) {
      that.logs[term.pid] += data;
    });
    return term;
  }

  resizeTerminal(req) {
    const that = this;
    const pid = parseInt(req.params.pid);
    const cols = parseInt(req.query.cols as string);
    const rows = parseInt(req.query.rows as string);
    const term = this.terminals[pid];

    term.resize(cols, rows);
    that.logger.info(
      'Resized terminal ' +
        pid +
        ' to ' +
        cols +
        ' cols and ' +
        rows +
        ' rows.',
    );
  }

  listenTerminal(ws, req) {
    const that = this;
    const term = that.terminals[parseInt(req.params.pid)];
    this.logger.info('Connected to terminal ' + term.pid);
    ws.send(that.logs[term.pid]);

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
      that.logger.info('Closed terminal ' + term.pid);
      // Clean things up
      delete that.terminals[term.pid];
      delete that.logs[term.pid];
    });
  }
}
