import { Router } from 'express';
import Container from 'typedi';
import { Logger } from 'winston';
import TerminalService from '../services/terminal';
// Whether to use binary transport.
const route = Router();

export default (app: Router) => {
  const logger: Logger = Container.get('logger');

  app.use('/', route);
  route.post('/terminals', (req, res) => {
    const terminalService = Container.get(TerminalService);
    const term = terminalService.createTerminal(req);
    res.send(term.pid.toString());
    res.end();
  });

  route.post('/terminals/:pid/size', (req, res) => {
    const terminalService = Container.get(TerminalService);
    terminalService.resizeTerminal(req);
    res.end();
  });

  route.ws('/terminals/:pid', function (ws, req) {
    const terminalService = Container.get(TerminalService);
    terminalService.listenTerminal(ws, req);
  });
};
