import { translate } from '../i18n';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import type { LocalContext } from './context';
import { atomicWrite } from './files';
import { checkedProcess } from './process';
import {
  repairConfiguration,
  installPanelDependencies,
  startPanel,
} from './operator';

export interface HealthObservation {
  healthy: boolean;
  status?: number;
  error?: string;
}

// Probe loopback directly: no inherited HTTP proxy, redirects or app credentials.
async function probe(
  port: number,
  route: string,
  matches: (body: string) => boolean,
): Promise<HealthObservation> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HealthObservation) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const request = http.get(
      { hostname: '127.0.0.1', port, path: route, headers: { Accept: '*/*' } },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            finish({
              healthy: false,
              status: response.statusCode,
              error: 'Response exceeds 1 MiB.',
            });
            request.destroy();
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          finish({
            healthy:
              status >= 200 &&
              status < 300 &&
              matches(Buffer.concat(chunks).toString('utf8')),
            status,
          });
        });
        response.on('error', () =>
          finish({ healthy: false, error: 'Response interrupted.' }),
        );
      },
    );
    const deadline = setTimeout(() => {
      finish({ healthy: false, error: 'Probe timed out.' });
      request.destroy();
    }, 5000);
    request.on('error', () =>
      finish({ healthy: false, error: 'Loopback request failed.' }),
    );
  });
}

export async function inspectPanel(
  context: LocalContext,
): Promise<{ panel: HealthObservation; backend: HealthObservation }> {
  const portText = context.env.QlPort || '5700';
  if (
    !/^\d+$/.test(portText) ||
    Number(portText) < 1 ||
    Number(portText) > 65535
  )
    throw new Error(translate(context.env, 'QlPort 必须在 1 到 65535 之间。'));
  const port = Number(portText);
  const basePath = (context.env.QlBaseUrl || '/').replace(/\/+$/, '');
  const [panel, backend] = await Promise.all([
    probe(port, `${basePath}/`, (body) =>
      /<div\s+id=["']root["']\s*>\s*<\/div>/.test(body),
    ),
    probe(port, `${basePath}/api/health?t=${Math.floor(Date.now() / 1000)}`, (body) => {
      try {
        const response: unknown = JSON.parse(body);
        return (
          !!response &&
          typeof response === 'object' &&
          'code' in response &&
          response.code === 200 &&
          'data' in response && !!response.data &&
          typeof response.data === 'object' &&
          'status' in response.data && response.data.status === 'ok'
        );
      } catch {
        return false;
      }
    }),
  ]);
  return { panel, backend };
}

export async function diagnosticLog(file: string): Promise<{
  file: string;
  text?: string;
  truncated?: boolean;
  error?: string;
}> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return { file, error: 'Not a regular log file.' };
    const length = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      stat.size - length,
    );
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    // Drop a partial UTF-8/line prefix when reading only the end of a file.
    if (stat.size > length)
      text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return {
      file,
      text: lines.slice(-300).join('\n'),
      truncated: stat.size > length || lines.length > 300,
    };
  } catch (error) {
    return {
      file,
      error:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Log is absent.'
          : 'Cannot read log.',
    };
  } finally {
    await handle?.close();
  }
}

export async function checkAndRepair(context: LocalContext): Promise<unknown> {
  await checkedProcess(
    'npm',
    ['i', '-g', 'pnpm@8.3.1', 'pm2', 'ts-node', 'typescript@5'],
    { cwd: context.root, env: context.env },
  );
  const restored = await repairConfiguration(context);
  await installPanelDependencies(context);
  const copied: string[] = [];
  for (const language of ['py', 'js']) {
    const destination = context.paths[`file_notify_${language}`]!;
    await atomicWrite(
      destination,
      await fs.readFile(context.paths[`file_notify_${language}_sample`]!),
    );
    copied.push(destination);
  }
  const before = await inspectPanel(context);
  const pm2Home =
    context.env.PM2_HOME || path.join(context.env.HOME || '/root', '.pm2');
  const logs = await Promise.all(
    ['qinglong-out.log', 'qinglong-error.log'].map((name) =>
      diagnosticLog(path.join(pm2Home, 'logs', name)),
    ),
  );
  const service = await startPanel(context);
  const after = await inspectPanel(context);
  return { restored, copied, before, service, after, logs };
}
