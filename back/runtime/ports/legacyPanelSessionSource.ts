export type LegacyPanelPlatform = 'desktop' | 'mobile';

export interface LegacyPanelSessionSource {
  isActive(token: string, platform: LegacyPanelPlatform): Promise<boolean>;
}

export interface LegacyPanelTokenSnapshot {
  value: string;
}

export interface LegacyPanelAuthSnapshot {
  token?: string;
  tokens?: Readonly<
    Record<
      string,
      string | readonly LegacyPanelTokenSnapshot[] | null | undefined
    >
  >;
}

export type LegacyPanelAuthSnapshotReader =
  () => Promise<Readonly<LegacyPanelAuthSnapshot> | null>;
