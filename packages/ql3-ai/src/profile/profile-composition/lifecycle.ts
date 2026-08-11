import type {
  ModelGatewayProviderAuthority,
  ModelGatewayStorageAuthority,
  ModelPriceCatalogManagementAuthority,
} from './contracts';

export async function bestEffortAudit<T>(
  audit: (record: Readonly<T>) => void | Promise<void>,
  record: Readonly<T>,
): Promise<void> {
  try {
    await audit(record);
  } catch {
    // Diagnostic failure cannot replace the activation failure.
  }
}

export async function dispose(
  authority: ModelGatewayProviderAuthority | ModelGatewayStorageAuthority,
  method: 'dispose' | 'close',
): Promise<void> {
  const operation =
    method === 'dispose'
      ? (authority as ModelGatewayProviderAuthority).dispose
      : (authority as ModelGatewayStorageAuthority).close;
  if (operation) await operation.call(authority);
}

export async function closeModelPriceCatalogManagementAuthority(
  authority: ModelPriceCatalogManagementAuthority,
): Promise<void> {
  if (authority.close) await authority.close.call(authority);
}
