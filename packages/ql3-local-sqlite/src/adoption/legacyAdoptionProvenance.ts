import { createHash, type Hash } from 'node:crypto';

export interface LegacyAdoptionTaskProvenancePayload {
  readonly adoptionMutationId: string;
  readonly rowOrdinal: number;
  readonly projectId: string;
  readonly sourceDigest: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskMutationId: string;
  readonly taskContentDigest: string;
  readonly triggerCount: number;
}

export interface LegacyAdoptionTriggerProvenancePayload {
  readonly adoptionMutationId: string;
  readonly rowOrdinal: number;
  readonly triggerOrdinal: number;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly triggerId: string;
  readonly triggerRevision: number;
  readonly triggerMutationId: string;
  readonly triggerContentDigest: string;
}

function itemDigest(
  domain: 'task' | 'trigger',
  payload: object,
): string {
  return createHash('sha256')
    .update(`qinglong3.legacy-adoption-${domain}-provenance.v1\0`)
    .update(JSON.stringify(payload))
    .digest('hex');
}

export function legacyAdoptionTaskProvenanceDigest(
  payload: Readonly<LegacyAdoptionTaskProvenancePayload>,
): string {
  return itemDigest('task', payload);
}

export function legacyAdoptionTriggerProvenanceDigest(
  payload: Readonly<LegacyAdoptionTriggerProvenancePayload>,
): string {
  return itemDigest('trigger', payload);
}

export class LegacyAdoptionPublicationDigest {
  readonly #hash: Hash;
  #sealed = false;

  constructor(mutationId: string) {
    this.#hash = createHash('sha256')
      .update('qinglong3.legacy-adoption-publication.v2\0')
      .update(mutationId);
  }

  appendTask(input: {
    readonly rowOrdinal: number;
    readonly sourceDigest: string;
    readonly taskContentDigest: string;
    readonly itemDigest: string;
  }): void {
    if (this.#sealed) throw new TypeError('Publication digest is sealed');
    this.#hash
      .update('\0task\0')
      .update(String(input.rowOrdinal))
      .update('\0')
      .update(input.sourceDigest)
      .update('\0')
      .update(input.taskContentDigest)
      .update('\0')
      .update(input.itemDigest);
  }

  appendTrigger(input: {
    readonly triggerContentDigest: string;
    readonly itemDigest: string;
  }): void {
    if (this.#sealed) throw new TypeError('Publication digest is sealed');
    this.#hash
      .update('\0trigger\0')
      .update(input.triggerContentDigest)
      .update('\0')
      .update(input.itemDigest);
  }

  digest(): string {
    if (this.#sealed) throw new TypeError('Publication digest is sealed');
    this.#sealed = true;
    return this.#hash.digest('hex');
  }
}
