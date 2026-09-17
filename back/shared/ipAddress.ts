import IP2Region from 'ip2region';
import { isIP } from 'net';

const MAX_ENTRIES = 64;
const TTL_MS = 5 * 60 * 1000;
// Keep only display text, never the database buffers or authentication state.
const addresses = new Map<string, { address: string; expiresAt: number }>();

export function lookupIpAddress(ip: string): string {
  const version = isIP(ip);
  if (!version) return '';
  const now = Date.now();
  const cached = addresses.get(ip);
  if (cached && cached.expiresAt > now) return cached.address;
  addresses.delete(ip);

  const result = new IP2Region({ disableIpv6: version === 4 }).search(ip);
  const address = result
    ? [...new Set([result.country, result.province, result.city, result.isp])]
        .filter(Boolean)
        .join(' ')
    : '';

  if (addresses.size >= MAX_ENTRIES) {
    addresses.delete(addresses.keys().next().value!);
  }
  addresses.set(ip, { address, expiresAt: now + TTL_MS });
  return address;
}
