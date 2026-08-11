/** Shared Cluster management mutual-TLS trust validation boundary. */
import { createHash, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { TextDecoder } from 'node:util';

import type { ClusterManagementProcessConfigurationFailure } from '../../management-support/managementProcessSupport';

const MAX_PEM_BLOCKS = 16;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function exactPemBlocks(
  bytes: Buffer,
  label: 'CERTIFICATE' | 'X509 CRL',
  description: string,
  failure: ClusterManagementProcessConfigurationFailure,
): readonly Buffer[] {
  let value: string;
  try {
    value = STRICT_UTF8.decode(bytes);
  } catch {
    throw failure(`${description} bundle must be strict UTF-8`);
  }
  const pattern = new RegExp(
    `-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`,
    'g',
  );
  const matches = value.match(pattern);
  if (!matches || matches.length < 1 || matches.length > MAX_PEM_BLOCKS) {
    throw failure(
      `${description} bundle must contain 1 to ${MAX_PEM_BLOCKS} PEM blocks`,
    );
  }
  if (value.replace(pattern, '').trim() !== '') {
    throw failure(`${description} bundle contains unsupported data`);
  }
  return Object.freeze(
    matches.map((match) => Buffer.from(`${match}\n`, 'utf8')),
  );
}

function validateCertificateAuthorities(
  authorities: readonly Buffer[],
  now: number,
  failure: ClusterManagementProcessConfigurationFailure,
): void {
  const fingerprints = new Set<string>();
  for (const authorityBytes of authorities) {
    let authority: X509Certificate;
    try {
      authority = new X509Certificate(authorityBytes);
    } catch {
      throw failure('client certificate authority is not an X.509 certificate');
    }
    const validFrom = Date.parse(authority.validFrom);
    const validTo = Date.parse(authority.validTo);
    if (
      !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) ||
      now < validFrom ||
      now >= validTo
    ) {
      throw failure('client certificate authority is not currently valid');
    }
    if (!authority.ca) {
      throw failure('client certificate authority is not a CA');
    }
    if (fingerprints.has(authority.fingerprint256)) {
      throw failure('client certificate authority bundle contains a duplicate');
    }
    fingerprints.add(authority.fingerprint256);
  }
}

function rejectDuplicateRevocationLists(
  revocationLists: readonly Buffer[],
  failure: ClusterManagementProcessConfigurationFailure,
): void {
  const digests = new Set<string>();
  for (const revocationList of revocationLists) {
    const digest = createHash('sha256').update(revocationList).digest('hex');
    if (digests.has(digest)) {
      throw failure(
        'client certificate revocation list bundle contains a duplicate',
      );
    }
    digests.add(digest);
  }
}

export function validateWorkerCredentialManagementClientTrust(
  certificateAuthorityBundle: Buffer,
  certificateRevocationListBundle: Buffer,
  now: number,
  failure: ClusterManagementProcessConfigurationFailure,
): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw failure('TLS observation time is invalid');
  }
  const authorities = exactPemBlocks(
    certificateAuthorityBundle,
    'CERTIFICATE',
    'client certificate authority',
    failure,
  );
  let revocationLists: readonly Buffer[] = Object.freeze([]);
  try {
    revocationLists = exactPemBlocks(
      certificateRevocationListBundle,
      'X509 CRL',
      'client certificate revocation list',
      failure,
    );
    validateCertificateAuthorities(authorities, now, failure);
    rejectDuplicateRevocationLists(revocationLists, failure);
    try {
      createSecureContext({
        ca: [...authorities],
        crl: [...revocationLists],
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
      });
    } catch {
      throw failure('client trust or revocation bundle is invalid');
    }
  } finally {
    for (const authority of authorities) authority.fill(0);
    for (const revocationList of revocationLists) revocationList.fill(0);
  }
}

export const validateClusterManagementClientTrust =
  validateWorkerCredentialManagementClientTrust;
