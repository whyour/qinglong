export interface LocalSecretKeyMaterial {
  keyId: string;
  /** Exactly 32 bytes; the consumer owns and must wipe this copy. */
  key: Uint8Array;
}

export interface LocalSecretKeyProvider {
  active(): Promise<LocalSecretKeyMaterial>;
  resolve(keyId: string): Promise<LocalSecretKeyMaterial | null>;
}
