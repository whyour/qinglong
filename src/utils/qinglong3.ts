export interface QingLong3Capabilities {
  readonly schemaVersion: 1;
  readonly product: 'qinglong3';
  readonly version: string;
  readonly deployment: Readonly<{
    mode: 'local';
    profile: 'edge' | 'standalone';
  }>;
  readonly authentication: Readonly<{
    kind: 'api_credential';
    transport: 'bearer';
    persistence: 'memory_only';
    loginEndpoint: null;
  }>;
  readonly panel: Readonly<{
    bootstrap: true;
    cronList: 'bounded_read_only';
    runControl?: 'task_run_v1';
    legacyMutations: false;
    legacyLogin: false;
    subscriptions: false;
    scripts: false;
    environmentVariables: false;
    webSocket: false;
  }>;
  readonly limits: Readonly<{
    cronRows: number;
    cronPageSize: number;
    logChunkBytes: number;
  }>;
}

const CREDENTIAL_PATTERN =
  /^ql3c_[A-Za-z0-9][A-Za-z0-9._:-]{0,63}_[A-Za-z0-9_-]{43}$/;

let capabilities: Readonly<QingLong3Capabilities> | null = null;
let credential: string | null = null;
let session: Readonly<object> = Object.freeze({});

export function qingLong3Session(): Readonly<object> {
  return session;
}

function validCapabilities(value: any): value is QingLong3Capabilities {
  const profile = value?.deployment?.profile;
  return Boolean(
    value?.schemaVersion === 1 &&
      value?.product === 'qinglong3' &&
      typeof value?.version === 'string' &&
      value.version.startsWith('3.') &&
      value?.deployment?.mode === 'local' &&
      (profile === 'edge' || profile === 'standalone') &&
      value?.authentication?.kind === 'api_credential' &&
      value?.authentication?.transport === 'bearer' &&
      value?.authentication?.persistence === 'memory_only' &&
      value?.authentication?.loginEndpoint === null &&
      value?.panel?.bootstrap === true &&
      value?.panel?.cronList === 'bounded_read_only' &&
      (value?.panel?.runControl === undefined ||
        value.panel.runControl === 'task_run_v1') &&
      value?.panel?.legacyMutations === false &&
      value?.panel?.legacyLogin === false &&
      value?.panel?.subscriptions === false &&
      value?.panel?.scripts === false &&
      value?.panel?.environmentVariables === false &&
      value?.panel?.webSocket === false &&
      Number.isSafeInteger(value?.limits?.cronRows) &&
      value.limits.cronRows >= 1 &&
      value.limits.cronRows <= 256 &&
      Number.isSafeInteger(value?.limits?.cronPageSize) &&
      value.limits.cronPageSize >= 1 &&
      value.limits.cronPageSize <= 64 &&
      Number.isSafeInteger(value?.limits?.logChunkBytes) &&
      value.limits.logChunkBytes >= 1 &&
      value.limits.logChunkBytes <= 32 * 1024,
  );
}

export async function discoverQingLong3(
  endpoint: string,
): Promise<Readonly<QingLong3Capabilities> | null> {
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const value = await response.json();
    if (!validCapabilities(value?.capabilities)) return null;
    capabilities = Object.freeze(value.capabilities);
    return capabilities;
  } catch {
    return null;
  }
}

export function qingLong3Capabilities(): Readonly<QingLong3Capabilities> | null {
  return capabilities;
}

export function setQingLong3Credential(value: string): boolean {
  if (!CREDENTIAL_PATTERN.test(value)) return false;
  session = Object.freeze({});
  credential = value;
  return true;
}

export function qingLong3Credential(): string | null {
  return credential;
}

export function clearQingLong3Credential(): void {
  session = Object.freeze({});
  credential = null;
}

export function isQingLong3PanelSession(): boolean {
  return capabilities !== null && credential !== null;
}
