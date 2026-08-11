import { createHash } from 'crypto';
import { MAX_LOG_ARTIFACT_ID_LENGTH } from './runStateMachine';
import type { RunDispatchCandidate } from './runDispatchCandidate';
import { assertRunDispatchCandidate } from './runDispatchCandidate';

const LOCAL_ARTIFACT_ID_PATTERN = /^local-[0-9a-f]{30}$/;

export function localExecutionArtifactId(
  candidate: Readonly<RunDispatchCandidate>,
): string {
  assertRunDispatchCandidate(candidate);
  return `local-${createHash('sha256')
    .update(candidate.runId, 'utf8')
    .update('\0', 'utf8')
    .update(candidate.attemptId, 'utf8')
    .digest('hex')
    .slice(0, 30)}`;
}

export function assertLocalExecutionArtifactId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length > MAX_LOG_ARTIFACT_ID_LENGTH ||
    !LOCAL_ARTIFACT_ID_PATTERN.test(value)
  ) {
    throw new TypeError('Local execution artifact id is invalid');
  }
}
