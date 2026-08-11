export interface PinnedSemverApi {
  compare(left: string, right: string): number;
  satisfies(
    version: string,
    range: string,
    options?: Readonly<{ includePrerelease: boolean }>,
  ): boolean;
  valid(value: string): string | null;
  validRange(value: string): string | null;
}

let loadedSemver: PinnedSemverApi | undefined;

/**
 * Returns the production-pinned SemVer implementation without making its
 * DefinitelyTyped package part of every QingLong 3.0 builder closure.
 */
export function semver(): PinnedSemverApi {
  loadedSemver ??= require('semver') as PinnedSemverApi;
  return loadedSemver;
}
