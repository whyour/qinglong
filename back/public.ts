import express from 'express';
import { exec } from 'child_process';
import Logger from './loaders/logger';
import config from './config';

const app = express();

app.get('/api/public/panel/log', (req, res) => {
  exec(
    'pm2 logs panel --lines 500 --nostream --timestamp',
    (err, stdout, stderr) => {
      if (err || stderr) {
        return res.send({ code: 400, data: err || stderr });
      }
      return res.send({ code: 200, data: stdout });
    },
  );
});

app
  .listen(config.publicPort, async () => {
    await require('./loaders/sentry').default({ expressApp: app });
    await require('./loaders/db').default();

    Logger.info(`
      ################################################
      🛡️  Public listening on port: ${config.publicPort} 🛡️
      ################################################
    `);
  })
  .on('error', (err) => {
    Logger.error(err);
    process.exit(1);
  });
