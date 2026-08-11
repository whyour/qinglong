import {
  assertArtifactReadProjectId,
  normalizeArtifactReadSubject,
  normalizeLocalArtifactReadMetadata,
  normalizeLocalArtifactReadRange,
  type ArtifactReadSubject,
  type LocalArtifactReadMetadata,
  type LocalArtifactReadRange,
} from '../domain/artifactRead';
import { assertCompletionReceiptId } from '../domain/completionReceipt';
import type { LocalArtifactTruncationFact } from '../domain/localArtifactTruncation';
import { assertLocalExecutionArtifactId } from '../domain/localExecutionArtifact';
import type {
  ArtifactReadAuthorizationEffect,
  ArtifactReadAuthorizer,
} from '../ports/artifactReadAuthorizer';
import type { LocalArtifactByteRangeReader } from '../ports/localArtifactByteRangeReader';
import type { LocalArtifactReadMetadataRepository } from '../ports/localArtifactReadMetadataRepository';
import type { LocalArtifactTruncationFactStore } from '../ports/localArtifactTruncationFactStore';

export type LocalArtifactTruncationState = boolean | 'unknown';

export interface LocalArtifactTruncationView {
  truncated: LocalArtifactTruncationState;
  maximumBytes?: number;
  observedAtMs?: number;
}

export interface LocalArtifactReadRequest {
  subject: ArtifactReadSubject;
  projectId: string;
  runId: string;
  logArtifactId: string;
  range: LocalArtifactReadRange;
}

interface LocalArtifactReadIdentity {
  projectId: string;
  runId: string;
  attemptId: string;
  logArtifactId: string;
}

export type LocalArtifactReadResult =
  | { status: 'not_found' }
  | {
      status: 'forbidden';
      effect: Exclude<ArtifactReadAuthorizationEffect, 'allow'>;
    }
  | (LocalArtifactReadIdentity & {
      status: 'retained';
      retention: NonNullable<LocalArtifactReadMetadata['retention']>;
      truncation: { truncated: 'unknown' };
    })
  | (LocalArtifactReadIdentity & {
      status: 'missing';
      truncation: Readonly<LocalArtifactTruncationView>;
    })
  | (LocalArtifactReadIdentity & {
      status: 'available';
      content: Buffer;
      start: number;
      endExclusive: number;
      totalBytes: number;
      nextOffset?: number;
      truncation: Readonly<LocalArtifactTruncationView>;
    });

export class LocalArtifactReadEvidenceConflictError extends Error {
  constructor() {
    super('Local Artifact read evidence conflicts with database identity');
    this.name = 'LocalArtifactReadEvidenceConflictError';
  }
}

function identity(
  metadata: Readonly<LocalArtifactReadMetadata>,
): LocalArtifactReadIdentity {
  return {
    projectId: metadata.projectId,
    runId: metadata.runId,
    attemptId: metadata.attemptId,
    logArtifactId: metadata.logArtifactId,
  };
}

function sameIdentity(
  left: Readonly<LocalArtifactReadMetadata>,
  right: Readonly<LocalArtifactReadMetadata>,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.runId === right.runId &&
    left.attemptId === right.attemptId &&
    left.logArtifactId === right.logArtifactId
  );
}

function truncationView(
  metadata: Readonly<LocalArtifactReadMetadata>,
  fact: Readonly<LocalArtifactTruncationFact> | null,
): Readonly<LocalArtifactTruncationView> {
  if (!fact) return Object.freeze({ truncated: 'unknown' });
  if (
    fact.runId !== metadata.runId ||
    fact.attemptId !== metadata.attemptId ||
    fact.logArtifactId !== metadata.logArtifactId
  ) {
    throw new LocalArtifactReadEvidenceConflictError();
  }
  return Object.freeze({
    truncated: fact.quotaReached,
    maximumBytes: fact.maximumBytes,
    observedAtMs: fact.observedAtMs,
  });
}

export class LocalArtifactReadService {
  constructor(
    private readonly metadata: LocalArtifactReadMetadataRepository,
    private readonly authorizer: ArtifactReadAuthorizer,
    private readonly bytes: LocalArtifactByteRangeReader,
    private readonly truncationFacts: LocalArtifactTruncationFactStore,
  ) {}

  async read(
    request: LocalArtifactReadRequest,
  ): Promise<LocalArtifactReadResult> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('Local Artifact read request must be an object');
    }
    const subject = normalizeArtifactReadSubject(request.subject);
    assertArtifactReadProjectId(request.projectId);
    assertCompletionReceiptId(request.runId, 'runId');
    assertLocalExecutionArtifactId(request.logArtifactId);
    const range = normalizeLocalArtifactReadRange(request.range);
    const lookup = Object.freeze({
      projectId: request.projectId,
      runId: request.runId,
      logArtifactId: request.logArtifactId,
    });
    const initial = await this.metadata.find(lookup);
    if (!initial) return Object.freeze({ status: 'not_found' });
    const artifact = normalizeLocalArtifactReadMetadata(initial);
    const effect = await this.authorizer.authorize(
      Object.freeze({
        action: 'artifact.read',
        subject,
        projectId: artifact.projectId,
        runId: artifact.runId,
        logArtifactId: artifact.logArtifactId,
      }),
    );
    if (effect !== 'allow') {
      if (effect !== 'deny' && effect !== 'require_approval') {
        throw new TypeError('Artifact read authorization effect is invalid');
      }
      return Object.freeze({ status: 'forbidden', effect });
    }
    if (artifact.retention) {
      return Object.freeze({
        status: 'retained',
        ...identity(artifact),
        retention: artifact.retention,
        truncation: Object.freeze({ truncated: 'unknown' as const }),
      });
    }

    const content = await this.bytes.read(artifact.logArtifactId, range);
    if (content.status === 'missing') {
      const refreshedValue = await this.metadata.find(lookup);
      if (!refreshedValue) throw new LocalArtifactReadEvidenceConflictError();
      const refreshed = normalizeLocalArtifactReadMetadata(refreshedValue);
      if (!sameIdentity(artifact, refreshed)) {
        throw new LocalArtifactReadEvidenceConflictError();
      }
      if (refreshed.retention) {
        return Object.freeze({
          status: 'retained',
          ...identity(refreshed),
          retention: refreshed.retention,
          truncation: Object.freeze({ truncated: 'unknown' as const }),
        });
      }
      const fact = await this.truncationFacts.read(artifact.logArtifactId);
      return Object.freeze({
        status: 'missing',
        ...identity(artifact),
        truncation: truncationView(artifact, fact),
      });
    }

    const fact = await this.truncationFacts.read(artifact.logArtifactId);
    return Object.freeze({
      status: 'available',
      ...identity(artifact),
      content: content.content,
      start: content.start,
      endExclusive: content.endExclusive,
      totalBytes: content.totalBytes,
      ...(content.nextOffset === undefined
        ? {}
        : { nextOffset: content.nextOffset }),
      truncation: truncationView(artifact, fact),
    });
  }
}
