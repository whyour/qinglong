export interface LegacyExecutionIdentity {
  pid?: number;
  logArtifactId?: string;
}

export function selectOneLegacyExecution<T extends LegacyExecutionIdentity>(
  candidates: readonly T[],
  selector: LegacyExecutionIdentity,
): T[] {
  const byLog =
    selector.logArtifactId === undefined
      ? []
      : candidates.filter(
          (candidate) => candidate.logArtifactId === selector.logArtifactId,
        );
  const byPid =
    selector.pid === undefined
      ? []
      : candidates.filter((candidate) => candidate.pid === selector.pid);

  if (selector.logArtifactId !== undefined && selector.pid !== undefined) {
    const byPidSet = new Set(byPid);
    const intersection = byLog.filter((candidate) => byPidSet.has(candidate));
    if (intersection.length === 1) return intersection;
    if (intersection.length > 1) return [];
    if (byLog.length === 0 && byPid.length === 1) return byPid;
    if (byPid.length === 0 && byLog.length === 1) return byLog;
    if (byLog.length === 0 && byPid.length === 0) {
      return candidates.length === 1 ? [...candidates] : [];
    }
    return [];
  }
  if (selector.logArtifactId !== undefined) {
    if (byLog.length === 1) return byLog;
    return byLog.length === 0 && candidates.length === 1 ? [...candidates] : [];
  }
  if (selector.pid !== undefined) {
    if (byPid.length === 1) return byPid;
    return byPid.length === 0 && candidates.length === 1 ? [...candidates] : [];
  }
  return candidates.length === 1 ? [...candidates] : [];
}
