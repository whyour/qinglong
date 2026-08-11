'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  auditPostgresCaOverlapFingerprints,
} = require('../../scripts/ql3-postgres-ca-overlap-audit.cjs');

const fingerprint = (character) =>
  Array.from({ length: 32 }, () => character.repeat(2)).join(':');

test('accepts an exact old to overlap to new trust transition', () => {
  const report = auditPostgresCaOverlapFingerprints({
    oldFingerprints: [fingerprint('A'), fingerprint('B')],
    overlapFingerprints: [fingerprint('A'), fingerprint('B'), fingerprint('C')],
    newFingerprints: [fingerprint('B'), fingerprint('C')],
  });
  assert.equal(report.contract, 'qinglong/postgresql-ca-overlap@v1');
  assert.deepEqual(
    {
      old: report.old.count,
      overlap: report.overlap.count,
      new: report.new.count,
      retained: report.retainedCount,
      introduced: report.introducedCount,
      retired: report.retiredCount,
    },
    {
      old: 2,
      overlap: 3,
      new: 2,
      retained: 1,
      introduced: 1,
      retired: 1,
    },
  );
  assert.match(report.overlap.digest, /^[0-9a-f]{64}$/);
});

test('rejects an overlap bundle that omits an old anchor', () => {
  assert.throws(
    () =>
      auditPostgresCaOverlapFingerprints({
        oldFingerprints: [fingerprint('A'), fingerprint('B')],
        overlapFingerprints: [fingerprint('B'), fingerprint('C')],
        newFingerprints: [fingerprint('B'), fingerprint('C')],
      }),
    /exact union/,
  );
});

test('rejects an overlap bundle that adds an unreviewed anchor', () => {
  assert.throws(
    () =>
      auditPostgresCaOverlapFingerprints({
        oldFingerprints: [fingerprint('A')],
        overlapFingerprints: [
          fingerprint('A'),
          fingerprint('B'),
          fingerprint('C'),
        ],
        newFingerprints: [fingerprint('B')],
      }),
    /exact union/,
  );
});

test('rejects a no-op or one-way trust expansion', () => {
  assert.throws(
    () =>
      auditPostgresCaOverlapFingerprints({
        oldFingerprints: [fingerprint('A')],
        overlapFingerprints: [fingerprint('A'), fingerprint('B')],
        newFingerprints: [fingerprint('A'), fingerprint('B')],
      }),
    /introduce and retire/,
  );
});

test('rejects malformed and duplicate fingerprints', () => {
  assert.throws(
    () =>
      auditPostgresCaOverlapFingerprints({
        oldFingerprints: ['not-a-fingerprint'],
        overlapFingerprints: [fingerprint('A'), fingerprint('B')],
        newFingerprints: [fingerprint('B')],
      }),
    /non-canonical/,
  );
  assert.throws(
    () =>
      auditPostgresCaOverlapFingerprints({
        oldFingerprints: [fingerprint('A'), fingerprint('A')],
        overlapFingerprints: [fingerprint('A'), fingerprint('B')],
        newFingerprints: [fingerprint('B')],
      }),
    /duplicate/,
  );
});
