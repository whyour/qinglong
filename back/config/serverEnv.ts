import { Request, Response } from 'express';
import { pick } from 'lodash';

let pickedEnv: Record<string, string>;

function getPickedEnv() {
  if (pickedEnv) return pickedEnv;
  const picked = pick(process.env, ['QlBaseUrl', 'DeployEnv']);
  pickedEnv = picked as Record<string, string>;
  return picked;
}

export function serveEnv(_req: Request, res: Response) {
  res.type('.js');
  res.send(
    Object.entries(getPickedEnv())
      .map(([k, v]) => `window.__ENV__${k}=${JSON.stringify(v)};`)
      .join('\n'),
  );
}
