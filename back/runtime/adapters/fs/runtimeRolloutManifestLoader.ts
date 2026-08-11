import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  defaultOffRuntimeRolloutPolicy,
  parseRuntimeRolloutManifest,
} from '../../domain/runtimeRolloutManifest';
import type {
  RuntimeRolloutLoadAudit,
  RuntimeRolloutLoadResult,
} from '../../ports/runtimeRolloutLoader';

export type {
  RuntimeRolloutLoadAudit,
  RuntimeRolloutLoadResult,
  RuntimeRolloutLoadStatus,
} from '../../ports/runtimeRolloutLoader';

export const MAX_RUNTIME_ROLLOUT_MANIFEST_BYTES = 64 * 1024;

export interface RuntimeRolloutManifestLoaderOptions {
  clock?: { now(): number };
  maxBytes?: number;
}

function rejected(
  audit: RuntimeRolloutLoadAudit,
  reasonCode: NonNullable<RuntimeRolloutLoadAudit['reasonCode']>,
): RuntimeRolloutLoadResult {
  return {
    status: 'rejected',
    policy: defaultOffRuntimeRolloutPolicy(),
    audit: { ...audit, status: 'rejected', reasonCode },
  };
}

export async function loadRuntimeRolloutManifest(
  sourcePath: string,
  options: RuntimeRolloutManifestLoaderOptions = {},
): Promise<RuntimeRolloutLoadResult> {
  if (!path.isAbsolute(sourcePath)) {
    throw new TypeError('Runtime rollout manifest path must be absolute');
  }
  const evaluatedAtMs = (options.clock ?? { now: Date.now }).now();
  if (!Number.isSafeInteger(evaluatedAtMs) || evaluatedAtMs < 0) {
    throw new TypeError('Runtime rollout clock returned an invalid timestamp');
  }
  const maxBytes = options.maxBytes ?? MAX_RUNTIME_ROLLOUT_MANIFEST_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('Runtime rollout maxBytes must be a positive integer');
  }
  const baseAudit: RuntimeRolloutLoadAudit = {
    event: 'runtime.rollout_config_evaluated',
    evaluatedAtMs,
    sourcePath,
    status: 'rejected',
  };

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'missing',
        policy: defaultOffRuntimeRolloutPolicy(),
        audit: {
          ...baseAudit,
          status: 'missing',
          reasonCode: 'FILE_MISSING',
        },
      };
    }
    return rejected(baseAudit, 'FILE_READ_FAILED');
  }

  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const hashedAudit = { ...baseAudit, sourceSha256 };
  if (bytes.byteLength > maxBytes) {
    return rejected(hashedAudit, 'FILE_TOO_LARGE');
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return rejected(hashedAudit, 'INVALID_JSON');
  }

  try {
    const decision = parseRuntimeRolloutManifest(value, evaluatedAtMs);
    const status = decision.manifest.enabled ? 'accepted' : 'disabled';
    return {
      status,
      policy: decision.policy,
      manifest: decision.manifest,
      audit: {
        ...hashedAudit,
        status,
        revision: decision.manifest.revision,
      },
    };
  } catch {
    return rejected(hashedAudit, 'INVALID_MANIFEST');
  }
}
