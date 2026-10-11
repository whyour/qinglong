import { Request } from 'express';

const IPV4_MAPPED_PREFIX = '::ffff:';

export function normalizeClientIp(value?: string): string {
  let ip = (value || '').trim().toLowerCase();
  if (!ip) {
    return '';
  }

  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }

  const zoneIndex = ip.indexOf('%');
  if (zoneIndex !== -1) {
    ip = ip.slice(0, zoneIndex);
  }

  if (ip.startsWith(IPV4_MAPPED_PREFIX)) {
    return ip.slice(IPV4_MAPPED_PREFIX.length);
  }

  return ip;
}

export function getClientIp(req: Request): string {
  return normalizeClientIp(req.ip || req.socket.remoteAddress);
}
