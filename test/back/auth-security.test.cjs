const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const load = require('../helpers/load-security-module.cjs');
const { isValidToken } = load(
  path.join(__dirname, '../../back/shared/auth.ts'),
);
const { hashPassword, verifyPassword } = load(
  path.join(__dirname, '../../back/shared/password.ts'),
);
const secret = 'security-test-secret';
const token = (payload = {}, options = {}) =>
  jwt.sign(payload, secret, {
    algorithm: 'HS384',
    expiresIn: '1h',
    ...options,
  });
const info = (value) => ({ token: value, tokens: {} });

test('valid legacy and platform sessions retain compatibility', () => {
  const value = token();
  for (const auth of [
    info(value),
    { tokens: { desktop: value } },
    { tokens: { desktop: [{ value }] } },
  ]) {
    assert.equal(isValidToken(auth, value, 'desktop', secret), true);
  }
  assert.equal(
    isValidToken({ tokens: { mobile: value } }, value, 'desktop', secret),
    false,
  );
});

test('session membership never bypasses JWT signature, expiry, algorithm or nbf', () => {
  const values = [
    token({}, { expiresIn: -1 }),
    token({}, { algorithm: 'HS256' }),
    token({ nbf: Math.floor(Date.now() / 1000) + 60 }),
    jwt.sign({}, 'wrong-secret', { algorithm: 'HS384', expiresIn: '1h' }),
    jwt.sign({}, secret, { algorithm: 'HS384' }),
    'not-a-token',
  ];
  for (const value of values)
    assert.equal(isValidToken(info(value), value, 'desktop', secret), false);
  assert.equal(isValidToken({ tokens: {} }, token(), 'desktop', secret), false);
  assert.equal(isValidToken(null, token(), 'desktop', secret), false);
  assert.equal(isValidToken(info(''), '', 'desktop', secret), false);
});

test('platform token metadata can shorten but cannot extend JWT expiration', () => {
  const value = token();
  assert.equal(
    isValidToken(
      { tokens: { desktop: [{ value, expiration: 1 }] } },
      value,
      'desktop',
      secret,
    ),
    false,
  );
});

test('passwords are salted and legacy plaintext can migrate without changing the password', async () => {
  const first = await hashPassword('owner-password');
  const second = await hashPassword('owner-password');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('owner-password', first), true);
  assert.equal(await verifyPassword('wrong-password', first), false);
  assert.equal(await verifyPassword(first, first), false);
  assert.equal(await verifyPassword('old-password', 'old-password'), true);
  assert.equal(await verifyPassword('wrong', 'old-password'), false);
});
