import express, { Application, Request } from 'express';
import { AuthDataType, SystemModel } from '../data/system';
import { normalizeClientIp } from './clientIp';

const DEFAULT_TRUST_PROXY = 'loopback';

type TrustProxyValue = boolean | number | string;

let activeApp: Application | undefined;

function getEnvironmentSetting(): string {
  return process.env.QL_TRUST_PROXY?.trim() || '';
}

function normalizeSetting(value?: string): string {
  return value?.trim() || DEFAULT_TRUST_PROXY;
}

export function resolveTrustProxy(value?: string): TrustProxyValue {
  const setting = normalizeSetting(value);
  if (setting === 'true' || setting === 'false') {
    return setting === 'true';
  }
  if (/^\d+$/.test(setting)) {
    return Number(setting);
  }
  return setting;
}

function validateTrustProxy(value: string): string {
  const setting = normalizeSetting(value);
  if (setting.length > 500 || /[\r\n]/.test(setting)) {
    throw new Error('trust proxy 配置格式无效');
  }
  if (/^\d+$/.test(setting) && Number(setting) > 20) {
    throw new Error('代理层数不能超过 20');
  }

  const probe = express();
  probe.set('trust proxy', resolveTrustProxy(setting));
  return setting;
}

async function getStoredSetting(): Promise<string> {
  const doc = await SystemModel.findOne({
    where: { type: AuthDataType.systemConfig },
  });
  const info = (doc?.get('info') || {}) as Record<string, unknown>;
  return typeof info.trustProxy === 'string' ? info.trustProxy : '';
}

export async function getTrustProxyConfig() {
  const environmentSetting = getEnvironmentSetting();
  const storedSetting = await getStoredSetting();
  const trustProxy = normalizeSetting(environmentSetting || storedSetting);

  return {
    trustProxy,
    source: environmentSetting
      ? 'environment'
      : storedSetting
      ? 'system'
      : 'default',
    editable: !environmentSetting,
  };
}

export async function initializeTrustProxy(app: Application) {
  activeApp = app;
  const { trustProxy } = await getTrustProxyConfig();
  app.set('trust proxy', resolveTrustProxy(trustProxy));
}

export async function updateTrustProxy(value: string) {
  if (getEnvironmentSetting()) {
    throw new Error('环境变量 QL_TRUST_PROXY 已生效，系统设置不可覆盖');
  }

  const trustProxy = validateTrustProxy(value);
  const doc = await SystemModel.findOne({
    where: { type: AuthDataType.systemConfig },
  });
  if (!doc) {
    throw new Error('系统配置不存在');
  }

  const plain = doc.get({ plain: true });
  await SystemModel.update(
    { info: { ...(plain.info || {}), trustProxy } as any },
    { where: { id: plain.id } },
  );
  activeApp?.set('trust proxy', resolveTrustProxy(trustProxy));

  return getTrustProxyConfig();
}

function parseForwardedFor(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .flatMap((item) => item.split(','))
    .map((item) => normalizeClientIp(item))
    .filter(Boolean);
}

export async function diagnoseClientIp(req: Request) {
  const remoteAddress = normalizeClientIp(req.socket.remoteAddress);
  const forwardedFor = parseForwardedFor(req.headers['x-forwarded-for']);
  const hopsFromApp = [remoteAddress, ...forwardedFor.slice().reverse()].filter(
    Boolean,
  );
  const trust = req.app.get('trust proxy fn') as
    | ((ip: string, hop: number) => boolean)
    | undefined;

  let selectedIndex = Math.max(hopsFromApp.length - 1, 0);
  for (let index = 0; index < hopsFromApp.length - 1; index += 1) {
    if (!trust?.(hopsFromApp[index], index)) {
      selectedIndex = index;
      break;
    }
  }

  const hops = hopsFromApp.map((ip, index) => ({
    ip,
    hop: index,
    status:
      index < selectedIndex
        ? 'trusted'
        : index === selectedIndex
        ? 'client'
        : 'not_checked',
  }));

  return {
    ...(await getTrustProxyConfig()),
    remoteAddress,
    forwardedFor,
    expressIps: req.ips.map(normalizeClientIp),
    clientIp: normalizeClientIp(req.ip || req.socket.remoteAddress),
    hops,
  };
}
