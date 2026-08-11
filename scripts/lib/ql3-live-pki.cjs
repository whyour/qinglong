#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function sha256File(crypto, filePath) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex')}`;
}

function createMutualTlsPki({ directory, servername, label, run, crypto }) {
  const file = (name) => path.join(directory, name);
  const paths = Object.freeze({
    caKey: file('ca.key'),
    caCertificate: file('ca.crt'),
    caConfig: file('ca.cnf'),
    caDatabase: file('ca.index'),
    caSerial: file('ca.serial'),
    caCrlNumber: file('ca.crlnumber'),
    caNewCertificates: file('ca-new-certificates'),
    serverKey: file('server.key'),
    serverRequest: file('server.csr'),
    serverCertificate: file('server.crt'),
    serverExtensions: file('server.ext'),
    oldClientKey: file('client-old.key'),
    oldClientRequest: file('client-old.csr'),
    oldClientCertificate: file('client-old.crt'),
    newClientKey: file('client-new.key'),
    newClientRequest: file('client-new.csr'),
    newClientCertificate: file('client-new.crt'),
    clientCertificateRevocationList: file('client.crl'),
  });

  run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${label} CA`,
      '-keyout',
      paths.caKey,
      '-out',
      paths.caCertificate,
    ],
    { capture: true, quiet: true },
  );
  fs.mkdirSync(paths.caNewCertificates, { mode: 0o700 });
  fs.writeFileSync(paths.caDatabase, '', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(paths.caSerial, '1000\n', {
    mode: 0o600,
    flag: 'wx',
  });
  fs.writeFileSync(paths.caCrlNumber, '1000\n', {
    mode: 0o600,
    flag: 'wx',
  });
  fs.writeFileSync(
    paths.caConfig,
    [
      '[ca]',
      'default_ca=client_ca',
      '[client_ca]',
      `database=${paths.caDatabase}`,
      `new_certs_dir=${paths.caNewCertificates}`,
      `certificate=${paths.caCertificate}`,
      `private_key=${paths.caKey}`,
      `serial=${paths.caSerial}`,
      `crlnumber=${paths.caCrlNumber}`,
      'default_md=sha256',
      'default_days=1',
      'default_crl_days=1',
      'policy=client_policy',
      'unique_subject=no',
      'copy_extensions=none',
      '[client_policy]',
      'commonName=supplied',
      '[client_certificate]',
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=clientAuth',
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  fs.writeFileSync(
    paths.serverExtensions,
    [
      'basicConstraints=CA:FALSE',
      'keyUsage=digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=DNS:${servername},DNS:${servername}.cluster.local`,
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  for (const [commonName, key, request, certificate] of [
    [
      `${label} old client`,
      paths.oldClientKey,
      paths.oldClientRequest,
      paths.oldClientCertificate,
    ],
    [
      `${label} replacement client`,
      paths.newClientKey,
      paths.newClientRequest,
      paths.newClientCertificate,
    ],
  ]) {
    run(
      'openssl',
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        `/CN=${commonName}`,
        '-keyout',
        key,
        '-out',
        request,
      ],
      { capture: true, quiet: true },
    );
    run(
      'openssl',
      [
        'ca',
        '-batch',
        '-notext',
        '-config',
        paths.caConfig,
        '-extensions',
        'client_certificate',
        '-in',
        request,
        '-out',
        certificate,
      ],
      { capture: true, quiet: true },
    );
  }
  run(
    'openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      `/CN=${servername}`,
      '-keyout',
      paths.serverKey,
      '-out',
      paths.serverRequest,
    ],
    { capture: true, quiet: true },
  );
  run(
    'openssl',
    [
      'x509',
      '-req',
      '-days',
      '1',
      '-in',
      paths.serverRequest,
      '-CA',
      paths.caCertificate,
      '-CAkey',
      paths.caKey,
      '-CAcreateserial',
      '-extfile',
      paths.serverExtensions,
      '-out',
      paths.serverCertificate,
    ],
    { capture: true, quiet: true },
  );
  const generateCrl = () =>
    run(
      'openssl',
      [
        'ca',
        '-gencrl',
        '-config',
        paths.caConfig,
        '-out',
        paths.clientCertificateRevocationList,
      ],
      { capture: true, quiet: true },
    );
  generateCrl();

  const read = () =>
    Object.freeze({
      ca: fs.readFileSync(paths.caCertificate, 'utf8'),
      serverCertificate: fs.readFileSync(paths.serverCertificate, 'utf8'),
      serverKey: fs.readFileSync(paths.serverKey, 'utf8'),
      oldClientCertificate: fs.readFileSync(paths.oldClientCertificate, 'utf8'),
      oldClientKey: fs.readFileSync(paths.oldClientKey, 'utf8'),
      newClientCertificate: fs.readFileSync(paths.newClientCertificate, 'utf8'),
      newClientKey: fs.readFileSync(paths.newClientKey, 'utf8'),
      clientCrl: fs.readFileSync(paths.clientCertificateRevocationList, 'utf8'),
    });

  return Object.freeze({
    paths,
    read,
    bundleSha256: () =>
      `sha256:${crypto
        .createHash('sha256')
        .update(fs.readFileSync(paths.caCertificate))
        .update(fs.readFileSync(paths.clientCertificateRevocationList))
        .digest('hex')}`,
    oldSerialSha256: () => {
      const serial = run(
        'openssl',
        ['x509', '-in', paths.oldClientCertificate, '-noout', '-serial'],
        { capture: true, quiet: true },
      ).stdout;
      return `sha256:${crypto
        .createHash('sha256')
        .update(serial)
        .digest('hex')}`;
    },
    newSerialSha256: () => {
      const serial = run(
        'openssl',
        ['x509', '-in', paths.newClientCertificate, '-noout', '-serial'],
        { capture: true, quiet: true },
      ).stdout;
      return `sha256:${crypto
        .createHash('sha256')
        .update(serial)
        .digest('hex')}`;
    },
    revokeOldClient() {
      run(
        'openssl',
        [
          'ca',
          '-batch',
          '-config',
          paths.caConfig,
          '-revoke',
          paths.oldClientCertificate,
        ],
        { capture: true, quiet: true },
      );
      generateCrl();
    },
  });
}

module.exports = { createMutualTlsPki, sha256File };
