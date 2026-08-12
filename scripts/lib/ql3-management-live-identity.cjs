#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function createManagementIdentityCeremony(options) {
  assert.match(options.issuer, /^https:\/\/[A-Za-z0-9.-]+\/$/);
  for (const value of [
    options.audience,
    options.purpose,
    options.tokenType,
    options.subject,
    options.jtiPrefix,
  ]) {
    assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/);
  }

  function reviewedKey(kid) {
    assert.match(kid, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    return Object.freeze({
      kid,
      privateKey,
      publicJwk: Object.freeze({
        ...publicKey.export({ format: 'jwk' }),
        alg: 'EdDSA',
        kid,
        use: 'sig',
      }),
    });
  }

  function keyset(generation, keys, revokedKids = []) {
    assert.ok(Number.isSafeInteger(generation) && generation >= 1);
    return Object.freeze({
      schemaVersion: 1,
      generation,
      issuer: options.issuer,
      audience: options.audience,
      keys: keys.map((key) => key.publicJwk),
      revokedKids: [...revokedKids],
      assuranceMappings: [
        {
          acr: 'urn:ql3:mfa',
          assurance: 'multi_factor',
          requiredAmr: ['pwd', 'otp'],
        },
      ],
      constraints: {
        maxAssertionBytes: 8 * 1024,
        maxLifetimeMs: 5 * 60 * 1000,
        maxAuthenticationAgeMs: 5 * 60 * 1000,
        clockSkewMs: 5 * 1000,
      },
    });
  }

  function assertionForSubject(key, subject, suffix = crypto.randomUUID()) {
    assert.match(subject, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    const now = Math.floor(Date.now() / 1_000);
    const header = Buffer.from(
      JSON.stringify({
        alg: 'EdDSA',
        kid: key.kid,
        typ: options.tokenType,
      }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        acr: 'urn:ql3:mfa',
        amr: ['pwd', 'otp'],
        aud: options.audience,
        auth_time: now - 1,
        exp: now + 290,
        iat: now,
        iss: options.issuer,
        jti: options.jtiPrefix + '-' + suffix,
        ql3_purpose: options.purpose,
        sub: subject,
      }),
    ).toString('base64url');
    const signed = header + '.' + payload;
    return (
      signed +
      '.' +
      crypto
        .sign(null, Buffer.from(signed, 'ascii'), key.privateKey)
        .toString('base64url')
    );
  }

  function assertion(key, suffix = crypto.randomUUID()) {
    return assertionForSubject(key, options.subject, suffix);
  }

  function weakAssertion(key, suffix = crypto.randomUUID()) {
    const now = Math.floor(Date.now() / 1_000);
    const header = Buffer.from(
      JSON.stringify({
        alg: 'EdDSA',
        kid: key.kid,
        typ: options.tokenType,
      }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        acr: 'urn:ql3:password',
        amr: ['pwd'],
        aud: options.audience,
        auth_time: now - 1,
        exp: now + 290,
        iat: now,
        iss: options.issuer,
        jti: options.jtiPrefix + '-weak-' + suffix,
        ql3_purpose: options.purpose,
        sub: options.subject,
      }),
    ).toString('base64url');
    const signed = header + '.' + payload;
    return (
      signed +
      '.' +
      crypto
        .sign(null, Buffer.from(signed, 'ascii'), key.privateKey)
        .toString('base64url')
    );
  }

  return Object.freeze({
    assertion,
    assertionForSubject,
    keyset,
    reviewedKey,
    weakAssertion,
  });
}

module.exports = { createManagementIdentityCeremony };
