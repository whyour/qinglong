import fs from 'fs/promises';
import path from 'path';
import { LocalArtifactCapacityUnavailableError } from '../../domain/localArtifactCapacity';
import type {
  LocalArtifactCapacityProbe,
  LocalArtifactCapacitySnapshot,
  LocalArtifactCapacitySource,
} from '../../ports/localArtifactCapacityProbe';

interface BigIntStatFs {
  bavail: bigint;
  blocks: bigint;
  bsize: bigint;
}

export class RootedLocalFileSystemCapacitySource
  implements LocalArtifactCapacitySource
{
  private readonly root: string;

  constructor(
    root: string,
    private readonly probe: LocalArtifactCapacityProbe = new LocalFileSystemCapacityProbe(),
  ) {
    if (!path.isAbsolute(root) || root.includes('\0')) {
      throw new TypeError('Local Artifact capacity root must be absolute');
    }
    this.root = path.resolve(root);
  }

  inspect(): Promise<LocalArtifactCapacitySnapshot> {
    return this.probe.inspect(this.root);
  }
}

interface StatFsPromises {
  statfs(value: string, options: { bigint: true }): Promise<BigIntStatFs>;
}

export class LocalFileSystemCapacityProbe
  implements LocalArtifactCapacityProbe
{
  async inspect(root: string): Promise<LocalArtifactCapacitySnapshot> {
    if (!path.isAbsolute(root) || root.includes('\0')) {
      throw new LocalArtifactCapacityUnavailableError();
    }
    try {
      const statfs = (fs as unknown as StatFsPromises).statfs;
      if (typeof statfs !== 'function') {
        throw new LocalArtifactCapacityUnavailableError();
      }
      const stat = await statfs.call(fs, root, { bigint: true });
      const availableBytes = stat.bavail * stat.bsize;
      const totalBytes = stat.blocks * stat.bsize;
      if (
        availableBytes < BigInt(0) ||
        totalBytes < BigInt(1) ||
        availableBytes > totalBytes
      ) {
        throw new LocalArtifactCapacityUnavailableError();
      }
      return Object.freeze({ availableBytes, totalBytes });
    } catch (error) {
      if (error instanceof LocalArtifactCapacityUnavailableError) throw error;
      throw new LocalArtifactCapacityUnavailableError();
    }
  }
}
