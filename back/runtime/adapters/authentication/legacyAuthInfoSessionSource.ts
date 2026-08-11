import { createHash, timingSafeEqual } from 'crypto';
import type {
  LegacyPanelAuthSnapshot,
  LegacyPanelAuthSnapshotReader,
  LegacyPanelPlatform,
  LegacyPanelSessionSource,
} from '../../ports/legacyPanelSessionSource';

export const MAX_LEGACY_PANEL_TOKEN_LENGTH = 4096;
export const MAX_LEGACY_PANEL_TOKENS_PER_PLATFORM = 64;

export class LegacyPanelSessionUnavailableError extends Error {
  readonly code = 'LEGACY_PANEL_SESSION_UNAVAILABLE';

  constructor() {
    super('Legacy panel session state is unavailable');
    this.name = 'LegacyPanelSessionUnavailableError';
  }
}

function assertToken(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_LEGACY_PANEL_TOKEN_LENGTH
  ) {
    throw new LegacyPanelSessionUnavailableError();
  }
}

function tokenMatches(left: string, right: string): boolean {
  assertToken(left);
  assertToken(right);
  return timingSafeEqual(
    createHash('sha256').update(left, 'utf8').digest(),
    createHash('sha256').update(right, 'utf8').digest(),
  );
}

function candidates(
  snapshot: Readonly<LegacyPanelAuthSnapshot>,
  platform: LegacyPanelPlatform,
): string[] {
  const result: string[] = [];
  if (snapshot.token !== undefined && snapshot.token !== '') {
    assertToken(snapshot.token);
    result.push(snapshot.token);
  }
  if (snapshot.tokens === undefined) return result;
  if (
    !snapshot.tokens ||
    typeof snapshot.tokens !== 'object' ||
    Array.isArray(snapshot.tokens)
  ) {
    throw new LegacyPanelSessionUnavailableError();
  }
  const platformTokens = snapshot.tokens[platform];
  if (platformTokens === null || platformTokens === undefined) return result;
  if (typeof platformTokens === 'string') {
    if (platformTokens === '') return result;
    assertToken(platformTokens);
    result.push(platformTokens);
    return result;
  }
  if (
    !Array.isArray(platformTokens) ||
    platformTokens.length > MAX_LEGACY_PANEL_TOKENS_PER_PLATFORM
  ) {
    throw new LegacyPanelSessionUnavailableError();
  }
  for (const item of platformTokens) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new LegacyPanelSessionUnavailableError();
    }
    assertToken(item.value);
    result.push(item.value);
  }
  return result;
}

export class LegacyAuthInfoSessionSource implements LegacyPanelSessionSource {
  constructor(private readonly read: LegacyPanelAuthSnapshotReader) {
    if (typeof read !== 'function') {
      throw new TypeError('Legacy panel auth snapshot reader is invalid');
    }
  }

  async isActive(
    token: string,
    platform: LegacyPanelPlatform,
  ): Promise<boolean> {
    assertToken(token);
    if (platform !== 'desktop' && platform !== 'mobile') {
      throw new TypeError('Legacy panel platform is invalid');
    }
    let snapshot: Readonly<LegacyPanelAuthSnapshot> | null;
    try {
      snapshot = await this.read();
    } catch {
      throw new LegacyPanelSessionUnavailableError();
    }
    if (!snapshot) return false;
    if (typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new LegacyPanelSessionUnavailableError();
    }
    return candidates(snapshot, platform).some((candidate) =>
      tokenMatches(candidate, token),
    );
  }
}
