import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
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

function run(cmd: string, execOpts?: Record<string, unknown>): string {
  const opts = { stdio: 'pipe', timeout: 30000, encoding: 'utf-8', ...execOpts } as any;
  return (execSync(cmd, opts) as string).trim();
}

async function tmpFile(prefix: string): Promise<string> {
  const dir = (await fileExist(certDir)) ? certDir : os.tmpdir();
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `.${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}.pem`);
}

async function generateAllCerts(): Promise<GrpcTlsConfig> {
  Logger.info('Generating gRPC mTLS certificates...');

  const caKeyTmp = await tmpFile('ca_key');
  const caCertTmp = await tmpFile('ca_cert');
  const serverKeyTmp = await tmpFile('server_key');
  const serverCsrTmp = await tmpFile('server_csr');
  const serverExtTmp = await tmpFile('server_ext');
  const clientKeyTmp = await tmpFile('client_key');
  const clientCsrTmp = await tmpFile('client_csr');
  const clientExtTmp = await tmpFile('client_ext');
  const srlTmp = path.join(path.dirname(caKeyTmp), '.grpc_ca.srl');

  const cleanup = async () => {
    for (const f of [caKeyTmp, caCertTmp, serverKeyTmp, serverCsrTmp, serverExtTmp,
      clientKeyTmp, clientCsrTmp, clientExtTmp, srlTmp]) {
      try { await fs.unlink(f); } catch {}
    }
  };

  try {
    // 1. CA（私钥直接存盘，证书写入临时文件供签发使用）
    run(`openssl genrsa -out '${caKeyTmp}' 2048 2>/dev/null`);
    run(`openssl req -new -x509 -days 3650 -key '${caKeyTmp}' -out '${caCertTmp}' -subj '/CN=qinglong-ca/O=qinglong/C=CN' 2>/dev/null`);
    const caKey = await fs.readFile(caKeyTmp, 'utf-8');
    const caCert = await fs.readFile(caCertTmp, 'utf-8');
    await fs.mkdir(certDir, { recursive: true });
    await fs.writeFile(caKeyPath, caKey, { mode: 0o600 });

    // 2. 服务端
    run(`openssl genrsa -out '${serverKeyTmp}' 2048 2>/dev/null`);
    run(`openssl req -new -key '${serverKeyTmp}' -out '${serverCsrTmp}' -subj '/CN=grpc-server' 2>/dev/null`);
    await fs.writeFile(serverExtTmp, 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\n');
    const serverCert = run(
      `openssl x509 -req -days 3650 -in '${serverCsrTmp}' -CA '${caCertTmp}' -CAkey '${caKeyTmp}' -CAcreateserial -extfile '${serverExtTmp}' 2>/dev/null`,
    );
    const serverKey = await fs.readFile(serverKeyTmp, 'utf-8');

    // 3. 客户端
    run(`openssl genrsa -out '${clientKeyTmp}' 2048 2>/dev/null`);
    run(`openssl req -new -key '${clientKeyTmp}' -out '${clientCsrTmp}' -subj '/CN=grpc-client' 2>/dev/null`);
    await fs.writeFile(clientExtTmp, 'extendedKeyUsage=clientAuth\n');
    const clientCert = run(
      `openssl x509 -req -days 3650 -in '${clientCsrTmp}' -CA '${caCertTmp}' -CAkey '${caKeyTmp}' -CAcreateserial -extfile '${clientExtTmp}' 2>/dev/null`,
    );
    const clientKey = await fs.readFile(clientKeyTmp, 'utf-8');

    await cleanup();
    Logger.info('gRPC mTLS certificates generated successfully');

    return { caCert, serverCert, serverKey, clientCert, clientKey };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function saveCerts(tlsConfig: GrpcTlsConfig): Promise<void> {
  await fs.mkdir(certDir, { recursive: true });

  await fs.writeFile(caCertPath, tlsConfig.caCert, { mode: 0o644 });
  await fs.writeFile(serverCertPath, tlsConfig.serverCert, { mode: 0o644 });
  await fs.writeFile(serverKeyPath, tlsConfig.serverKey, { mode: 0o600 });
  await fs.writeFile(clientCertPath, tlsConfig.clientCert, { mode: 0o644 });
  await fs.writeFile(clientKeyPath, tlsConfig.clientKey, { mode: 0o600 });

  Logger.info(`gRPC mTLS certificates saved to ${certDir}`);
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

  Logger.info('Loaded existing gRPC mTLS certificates from disk');
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
