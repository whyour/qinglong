import express from 'express';
import { exec } from 'child_process';
import env from '@qinglong/env';

const app = express();

app.get('/api/public/panel/log', (req, res) => {
  exec(
    'pm2 logs panel --lines 500 --nostream --timestamp',
    (err, stdout, stderr) => {
      if (err || stderr) {
        return res.send({ code: 400, message: (err && err.message) || stderr });
      }
      return res.send({ code: 200, data: stdout });
    },
  );
});
console.log(env);
app
  .listen(env.PUBLIC_PORT, async () => {
    console.log('启动成功');
  })
  .on('error', (err) => {
    process.exit(1);
  });
