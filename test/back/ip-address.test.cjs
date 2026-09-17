const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-security-module.cjs');
const file = path.join(__dirname, '../../back/shared/ipAddress.ts');
function fixture(
  search = () => ({ country: 'A', province: 'A', city: '', isp: 'B' }),
) {
  const instances = [];
  const { lookupIpAddress } = load(file, {
    ip2region: class {
      constructor(options) {
        instances.push(options);
      }
      search(ip) {
        return search(ip);
      }
    },
  });
  return { lookupIpAddress, instances };
}
test('address lookup preserves display formatting and caches only successful text results', () => {
  const h = fixture();
  assert.equal(h.lookupIpAddress('127.0.0.1'), 'A B');
  assert.equal(h.lookupIpAddress('127.0.0.1'), 'A B');
  assert.deepEqual(h.instances, [{ disableIpv6: true }]);
  assert.equal(h.lookupIpAddress('::1'), 'A B');
  assert.deepEqual(h.instances[1], { disableIpv6: false });
  assert.equal(h.lookupIpAddress('invalid'), '');
  assert.equal(h.instances.length, 2);
});
test('expired entries are refreshed without a timer', () => {
  let value = 'old';
  const h = fixture(() => ({ country: value }));
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    assert.equal(h.lookupIpAddress('127.0.0.1'), 'old');
    value = 'new';
    now += 299999;
    assert.equal(h.lookupIpAddress('127.0.0.1'), 'old');
    now++;
    assert.equal(h.lookupIpAddress('127.0.0.1'), 'new');
    assert.equal(h.instances.length, 2);
  } finally {
    Date.now = realNow;
  }
});
test('address cache is bounded to 64 entries', () => {
  const h = fixture();
  for (let i = 1; i <= 65; i++) h.lookupIpAddress(`10.0.0.${i}`);
  h.lookupIpAddress('10.0.0.65');
  assert.equal(h.instances.length, 65);
  h.lookupIpAddress('10.0.0.1');
  assert.equal(h.instances.length, 66);
});
test('missing results are cached, but failed reads can be retried', () => {
  let fail = true;
  const h = fixture(() => {
    if (fail) throw new Error('read failed');
    return null;
  });
  assert.throws(() => h.lookupIpAddress('127.0.0.1'), /read failed/);
  fail = false;
  assert.equal(h.lookupIpAddress('127.0.0.1'), '');
  assert.equal(h.lookupIpAddress('127.0.0.1'), '');
  assert.equal(h.instances.length, 2);
});
test('real IPv4 and IPv6 results match the original database lookup', () => {
  const IP2Region = require('ip2region').default;
  const { lookupIpAddress } = load(file);
  const original = new IP2Region();
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '8.8.8.8',
    '223.5.5.5',
    '::1',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
  ]) {
    const row = original.search(ip);
    const expected = row
      ? [...new Set([row.country, row.province, row.city, row.isp])]
          .filter(Boolean)
          .join(' ')
      : '';
    assert.equal(lookupIpAddress(ip), expected, ip);
  }
});
