import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import path from 'path';
import config from './index';
import { fileExist } from './util';
import Logger from '../loaders/logger';

export interface GrpcTlsConfig {
  caCert: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
}

const certDir = path.join(config.configPath, 'grpc');
const caKeyPath = path.join(certDir, 'ca.key');
const caCertPath = path.join(certDir, 'ca.crt');
const serverKeyPath = path.join(certDir, 'server.key');
const serverCertPath = path.join(certDir, 'server.crt');
const clientKeyPath = path.join(certDir, 'client.key');
const clientCertPath = path.join(certDir, 'client.crt');

let cachedConfig: GrpcTlsConfig | null = null;

function run(args: string[]): string {
  return execFileSync('openssl', args, {
    stdio: 'pipe',
    timeout: 30000,
    encoding: 'utf-8',
  }).trim();
}

async function generateAllCerts(): Promise<GrpcTlsConfig> {
  Logger.info('[boot] Generating gRPC mTLS certificates...');
  await fs.mkdir(certDir, { recursive: true, mode: 0o700 });
  // Atomically reserve a private workspace for keys, CSRs and OpenSSL side files.
  const workspace = await fs.mkdtemp(path.join(certDir, '.generate-'));
  const caKeyTmp = path.join(workspace, 'ca.key');
  const caCertTmp = path.join(workspace, 'ca.crt');
  const serverKeyTmp = path.join(workspace, 'server.key');
  const serverCsrTmp = path.join(workspace, 'server.csr');
  const serverExtTmp = path.join(workspace, 'server.ext');
  const clientKeyTmp = path.join(workspace, 'client.key');
  const clientCsrTmp = path.join(workspace, 'client.csr');
  const clientExtTmp = path.join(workspace, 'client.ext');

  const cleanup = async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  };

  try {
    run(['genrsa', '-out', caKeyTmp, '2048']);
    run([
      'req',
      '-new',
      '-x509',
      '-days',
      '3650',
      '-key',
      caKeyTmp,
      '-out',
      caCertTmp,
      '-subj',
      '/CN=qinglong-ca/O=qinglong/C=CN',
    ]);
    const caKey = await fs.readFile(caKeyTmp, 'utf-8');
    const caCert = await fs.readFile(caCertTmp, 'utf-8');
    await fs.writeFile(caKeyPath, caKey, { mode: 0o600 });

    run(['genrsa', '-out', serverKeyTmp, '2048']);
    run([
      'req',
      '-new',
      '-key',
      serverKeyTmp,
      '-out',
      serverCsrTmp,
      '-subj',
      '/CN=grpc-server',
    ]);
    await fs.writeFile(
      serverExtTmp,
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\n',
    );
    const serverCert = run([
      'x509',
      '-req',
      '-days',
      '3650',
      '-in',
      serverCsrTmp,
      '-CA',
      caCertTmp,
      '-CAkey',
      caKeyTmp,
      '-CAserial',
      path.join(workspace, 'ca.srl'),
      '-CAcreateserial',
      '-extfile',
      serverExtTmp,
    ]);
    const serverKey = await fs.readFile(serverKeyTmp, 'utf-8');

    run(['genrsa', '-out', clientKeyTmp, '2048']);
    run([
      'req',
      '-new',
      '-key',
      clientKeyTmp,
      '-out',
      clientCsrTmp,
      '-subj',
      '/CN=grpc-client',
    ]);
    await fs.writeFile(clientExtTmp, 'extendedKeyUsage=clientAuth\n');
    const clientCert = run([
      'x509',
      '-req',
      '-days',
      '3650',
      '-in',
      clientCsrTmp,
      '-CA',
      caCertTmp,
      '-CAkey',
      caKeyTmp,
      '-CAserial',
      path.join(workspace, 'ca.srl'),
      '-CAcreateserial',
      '-extfile',
      clientExtTmp,
    ]);
    const clientKey = await fs.readFile(clientKeyTmp, 'utf-8');

    Logger.info('[boot] gRPC mTLS certificates generated successfully');
    return { caCert, serverCert, serverKey, clientCert, clientKey };
  } finally {
    await cleanup();
  }
}

async function saveCerts(tlsConfig: GrpcTlsConfig): Promise<void> {
  await fs.mkdir(certDir, { recursive: true });

  await fs.writeFile(caCertPath, tlsConfig.caCert, { mode: 0o644 });
  await fs.writeFile(serverCertPath, tlsConfig.serverCert, { mode: 0o644 });
  await fs.writeFile(serverKeyPath, tlsConfig.serverKey, { mode: 0o600 });
  await fs.writeFile(clientCertPath, tlsConfig.clientCert, { mode: 0o644 });
  await fs.writeFile(clientKeyPath, tlsConfig.clientKey, { mode: 0o600 });

  Logger.info(`[boot] gRPC mTLS certificates saved to ${certDir}`);
}

async function loadExistingCerts(): Promise<GrpcTlsConfig | null> {
  const exists = await Promise.all([
    fileExist(caCertPath),
    fileExist(serverCertPath),
    fileExist(serverKeyPath),
    fileExist(clientCertPath),
    fileExist(clientKeyPath),
  ]);

  if (exists.some((e) => !e)) {
    return null;
  }

  const [caCert, serverCert, serverKey, clientCert, clientKey] = await Promise.all([
    fs.readFile(caCertPath, 'utf-8'),
    fs.readFile(serverCertPath, 'utf-8'),
    fs.readFile(serverKeyPath, 'utf-8'),
    fs.readFile(clientCertPath, 'utf-8'),
    fs.readFile(clientKeyPath, 'utf-8'),
  ]);

  Logger.info('[boot] Loaded existing gRPC mTLS certificates from disk');
  return { caCert, serverCert, serverKey, clientCert, clientKey };
}

export async function initGrpcCerts(): Promise<GrpcTlsConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  let tlsConfig = await loadExistingCerts();

  if (!tlsConfig) {
    tlsConfig = await generateAllCerts();
    await saveCerts(tlsConfig);
  }

  cachedConfig = tlsConfig;
  return tlsConfig;
}

export function getGrpcCerts(): GrpcTlsConfig | null {
  return cachedConfig;
}
