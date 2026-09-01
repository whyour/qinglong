#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DOMAINS = Object.freeze([
  'schema_lineage',
  'automation',
  'secret_and_config',
  'run_history',
  'plugin_package',
  'ai_and_tool',
  'identity_policy_audit',
  'unknown',
]);
const DATABASES = Object.freeze(['legacy', 'target']);
const FACT_KINDS = Object.freeze(['schema_object', 'table']);
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(message) {
  throw new Error(message);
}

function canonicalFile(filePath, maximumBytes, label) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > maximumBytes ||
    fs.realpathSync(resolved) !== resolved
  ) {
    fail(`${label} must be one bounded canonical regular file`);
  }
  return resolved;
}

function readJson(filePath, label) {
  const resolved = canonicalFile(filePath, MAX_JSON_BYTES, label);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    return fail(`${label} must contain valid JSON`);
  }
}

function writeExclusive(filePath, records) {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  if (
    fs.existsSync(resolved) ||
    !fs.lstatSync(parent).isDirectory() ||
    fs.realpathSync(parent) !== parent
  ) {
    fail('fixture output must be a new file below one canonical directory');
  }
  const descriptor = fs.openSync(
    resolved,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(
      descriptor,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return resolved;
}

function fixtureRoot(value) {
  const resolved = path.resolve(value || '');
  if (
    !path.isAbsolute(value || '') ||
    !fs.lstatSync(resolved).isDirectory() ||
    fs.realpathSync(resolved) !== resolved
  ) {
    fail('reconciliation root must be one canonical directory');
  }
  return resolved;
}

function validateSummary(root, status) {
  const summary = readJson(
    path.join(root, 'summary.json'),
    'reconciliation summary',
  );
  if (
    summary?.schemaVersion !== 1 ||
    summary?.schema !==
      'qinglong/local-alpha-reconciliation-rehearsal-summary@v1' ||
    summary?.status !== status ||
    (summary?.profile !== 'edge' && summary?.profile !== 'standalone')
  ) {
    fail(`reconciliation summary is not in ${status} state`);
  }
  return summary;
}

function validateFact(fact, expected) {
  if (
    fact?.schemaVersion !== 1 ||
    fact?.schema !== 'qinglong3-local-reconciliation-diagnostic-fact' ||
    fact?.database !== expected.database ||
    fact?.domain !== expected.domain ||
    fact?.factKind !== expected.factKind ||
    !Number.isSafeInteger(fact.ordinal) ||
    fact.ordinal < 1 ||
    !DIGEST.test(fact.factDigest || '') ||
    !['informational', 'required', 'blocked'].includes(fact.decisionRequirement)
  ) {
    fail('diagnostic fact is incompatible with the fixture contract');
  }
}

function diagnosticFacts(root, summary) {
  const facts = [];
  let pageCount = 0;
  for (const database of DATABASES) {
    for (const domain of DOMAINS) {
      for (const factKind of FACT_KINDS) {
        let pageNumber = 0;
        let expectedOffset = 0;
        while (true) {
          const page = readJson(
            path.join(
              root,
              'diagnostics',
              `${database}-${domain}-${factKind}-${pageNumber}.json`,
            ),
            'diagnostic page',
          );
          if (
            page?.schemaVersion !== 1 ||
            page?.schema !== 'qinglong3-local-reconciliation-diagnostic-page' ||
            page?.state !== 'reconciliation_review_prepared' ||
            page?.reviewId !== summary.review.reviewId ||
            page?.planDigest !== summary.plan.planDigest ||
            page?.preparationDigest !== summary.review.preparationDigest ||
            page?.database !== database ||
            page?.domain !== domain ||
            page?.factKind !== factKind ||
            page?.offset !== expectedOffset ||
            page?.limit !== 64 ||
            !Array.isArray(page.records) ||
            page.recordCount !== page.records.length ||
            !DIGEST.test(page.pageDigest || '')
          ) {
            fail('diagnostic page is detached or malformed');
          }
          for (const fact of page.records) {
            validateFact(fact, { database, domain, factKind });
            facts.push(fact);
          }
          pageCount += 1;
          if (page.complete === true && page.nextOffset === null) break;
          if (
            page.complete !== false ||
            !Number.isSafeInteger(page.nextOffset) ||
            page.nextOffset <= expectedOffset
          ) {
            fail('diagnostic pagination is invalid');
          }
          expectedOffset = page.nextOffset;
          pageNumber += 1;
        }
      }
    }
  }
  if (
    pageCount !== summary.review.diagnosticPages ||
    facts.length !== summary.review.diagnosticRecords
  ) {
    fail('diagnostic inventory differs from the reconciliation summary');
  }
  return facts;
}

function readNdjson(filePath, maximumBytes, label) {
  const resolved = canonicalFile(filePath, maximumBytes, label);
  try {
    return fs
      .readFileSync(resolved, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
  } catch {
    return fail(`${label} must be canonical NDJSON`);
  }
}

function reviewFixture(root, output) {
  const summary = validateSummary(root, 'operator_decision_required');
  if (
    !UUID_V4.test(summary.review?.reviewId || '') ||
    !DIGEST.test(summary.plan?.planDigest || '') ||
    !DIGEST.test(summary.review?.preparationDigest || '')
  ) {
    fail('review fixture identity is invalid');
  }
  const facts = diagnosticFacts(root, summary);
  let adoptedAutomationTables = 0;
  const decisions = [];
  for (const fact of facts) {
    if (fact.decisionRequirement === 'informational') continue;
    const automationTable =
      fact.database === 'legacy' &&
      fact.domain === 'automation' &&
      fact.factKind === 'table' &&
      fact.tableName === 'Crontabs' &&
      fact.decisionRequirement === 'required';
    if (automationTable) adoptedAutomationTables += 1;
    const blocked = fact.decisionRequirement === 'blocked';
    const legacy = fact.database === 'legacy';
    const legacyRunHistory = legacy && fact.domain === 'run_history';
    decisions.push({
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-review-decision',
      database: fact.database,
      domain: fact.domain,
      factKind: fact.factKind,
      ordinal: fact.ordinal,
      factDigest: fact.factDigest,
      disposition: automationTable
        ? 'adopt_legacy'
        : blocked || legacyRunHistory
        ? 'manual_external'
        : legacy
        ? 'exclude_legacy'
        : 'retain_target',
      reason: automationTable
        ? 'prefer_legacy'
        : blocked || legacyRunHistory
        ? 'external_recovery_required'
        : legacy
        ? 'legacy_excluded'
        : 'preserve_target',
    });
  }
  if (adoptedAutomationTables !== 1 || decisions.length < 1) {
    fail('fixture requires exactly one reviewable Legacy Crontabs table');
  }
  const records = [
    {
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-review-decision-header',
      diagnosticsContractVersion: 1,
      reviewId: summary.review.reviewId,
      profile: summary.profile,
      planDigest: summary.plan.planDigest,
      preparationDigest: summary.review.preparationDigest,
    },
    ...decisions,
  ];
  const filePath = writeExclusive(output, records);
  return Object.freeze({
    mode: 'review',
    filePath,
    decisionCount: decisions.length,
    adoptedAutomationTables,
  });
}

function completionReviewFixture(root, output) {
  const summary = validateSummary(root, 'operator_decision_required');
  if (
    !UUID_V4.test(summary.review?.reviewId || '') ||
    !DIGEST.test(summary.plan?.planDigest || '') ||
    !DIGEST.test(summary.review?.preparationDigest || '')
  ) {
    fail('completion review fixture identity is invalid');
  }
  const facts = diagnosticFacts(root, summary);
  let adoptedAutomationTables = 0;
  let legacyRunHistoryFacts = 0;
  let targetRunHistoryFacts = 0;
  let secretConfigFacts = 0;
  const decisions = [];
  for (const fact of facts) {
    if (fact.decisionRequirement === 'informational') continue;
    const externallyRecoverableSecretConfig =
      fact.decisionRequirement === 'blocked' &&
      fact.domain === 'secret_and_config' &&
      fact.reason === 'secret_custody_required';
    if (
      fact.decisionRequirement === 'blocked' &&
      !externallyRecoverableSecretConfig
    ) {
      fail('completion review fixture refuses blocked diagnostic facts');
    }
    const automationTable =
      fact.database === 'legacy' &&
      fact.domain === 'automation' &&
      fact.factKind === 'table' &&
      fact.tableName === 'Crontabs' &&
      fact.decisionRequirement === 'required';
    const runHistory = fact.domain === 'run_history';
    const secretConfig = fact.domain === 'secret_and_config';
    if (automationTable) adoptedAutomationTables += 1;
    if (runHistory && fact.database === 'legacy') legacyRunHistoryFacts += 1;
    if (runHistory && fact.database === 'target') targetRunHistoryFacts += 1;
    if (secretConfig) secretConfigFacts += 1;
    const legacy = fact.database === 'legacy';
    decisions.push({
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-review-decision',
      database: fact.database,
      domain: fact.domain,
      factKind: fact.factKind,
      ordinal: fact.ordinal,
      factDigest: fact.factDigest,
      disposition: automationTable
        ? 'adopt_legacy'
        : secretConfig
        ? 'manual_external'
        : runHistory && legacy
        ? 'retain_both'
        : legacy
        ? 'exclude_legacy'
        : 'retain_target',
      reason: automationTable
        ? 'prefer_legacy'
        : secretConfig
        ? 'external_recovery_required'
        : runHistory && legacy
        ? 'preserve_both'
        : legacy
        ? 'legacy_excluded'
        : 'preserve_target',
    });
  }
  if (
    adoptedAutomationTables !== 1 ||
    legacyRunHistoryFacts < 1 ||
    targetRunHistoryFacts < 1 ||
    secretConfigFacts < 1
  ) {
    fail(
      'completion fixture requires Automation, Secret/Config, and dual Run History authority',
    );
  }
  const records = [
    {
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-review-decision-header',
      diagnosticsContractVersion: 1,
      reviewId: summary.review.reviewId,
      profile: summary.profile,
      planDigest: summary.plan.planDigest,
      preparationDigest: summary.review.preparationDigest,
    },
    ...decisions,
  ];
  const filePath = writeExclusive(output, records);
  return Object.freeze({
    mode: 'completion-review',
    filePath,
    decisionCount: decisions.length,
    adoptedAutomationTables,
    legacyRunHistoryFacts,
    targetRunHistoryFacts,
    secretConfigFacts,
  });
}

function automationFixture(root, output) {
  const summary = validateSummary(root, 'automation_decision_required');
  const automation = summary.automation;
  const decision = summary.decision;
  if (
    !UUID_V4.test(automation?.automationId || '') ||
    !UUID_V7.test(decision?.decisionId || '') ||
    !DIGEST.test(automation?.automationPlanDigest || '') ||
    automation.rowCount !== 1 ||
    automation.eligibleCount !== 1 ||
    automation.conflictCount !== 0
  ) {
    fail('fixture requires one conflict-free eligible Automation row');
  }
  const directory = path.join(root, 'automation', automation.automationId);
  const receipt = readJson(
    path.join(directory, 'receipt.json'),
    'Automation plan receipt',
  );
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.schema !==
      'qinglong3-local-reconciliation-automation-plan-receipt' ||
    receipt?.automationId !== automation.automationId ||
    receipt?.automationPlanDigest !== automation.automationPlanDigest ||
    receipt?.rowCount !== 1 ||
    receipt?.eligibleCount !== 1 ||
    receipt?.manualCount !== 0 ||
    receipt?.conflictCount !== 0 ||
    !DIGEST.test(receipt.legacyInventoryDigest || '')
  ) {
    fail('Automation plan receipt is not fixture-eligible');
  }
  const planPath = canonicalFile(
    path.join(directory, 'plan.ndjson'),
    8 * 1024 * 1024,
    'Automation row plan',
  );
  let records;
  try {
    records = fs
      .readFileSync(planPath, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
  } catch {
    return fail('Automation row plan must be canonical NDJSON');
  }
  const rows = records.filter(
    (record) =>
      record?.kind === 'qinglong3-local-reconciliation-automation-plan-row',
  );
  if (
    rows.length !== 1 ||
    rows[0].schemaVersion !== 1 ||
    rows[0].requirement !== 'review_adopt' ||
    rows[0].target?.state !== 'absent' ||
    !Number.isSafeInteger(rows[0].rowOrdinal) ||
    rows[0].rowOrdinal < 1 ||
    !DIGEST.test(rows[0].sourceDigest || '')
  ) {
    fail('Automation row plan contains a non-lossless or conflicting row');
  }
  const outputRecords = [
    {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-review-file-header',
      decisionId: decision.decisionId,
      profile: summary.profile,
      planDigest: automation.automationPlanDigest,
      inventoryDigest: receipt.legacyInventoryDigest,
    },
    {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-review-file-row',
      decision: {
        rowOrdinal: rows[0].rowOrdinal,
        sourceDigest: rows[0].sourceDigest,
        disposition: 'adopt',
        reason: 'reviewed_lossless',
      },
    },
  ];
  const filePath = writeExclusive(output, outputRecords);
  return Object.freeze({
    mode: 'automation',
    filePath,
    decisionCount: 1,
    automationPlanDigest: automation.automationPlanDigest,
  });
}

function secretConfigFixture(root, output) {
  const summary = validateSummary(root, 'secret_config_decision_required');
  const secretConfig = summary.secretConfig;
  const decision = summary.secretConfigDecision;
  if (
    !UUID_V4.test(secretConfig?.secretConfigId || '') ||
    !UUID_V7.test(decision?.decisionId || '') ||
    !DIGEST.test(secretConfig?.secretConfigPlanDigest || '') ||
    !DIGEST.test(decision?.preparationDigest || '') ||
    !Number.isSafeInteger(secretConfig?.eligibleBindingCount) ||
    !Number.isSafeInteger(secretConfig?.eligiblePreservationCount) ||
    secretConfig.eligibleBindingCount + secretConfig.eligiblePreservationCount <
      1 ||
    secretConfig.targetConflictCount !== 0 ||
    secretConfig.unadaptedLegacyConfigCount !== 0
  ) {
    fail('fixture requires one ready conflict-free Secret/Config plan');
  }
  const directory = path.join(
    root,
    'secret-config',
    secretConfig.secretConfigId,
  );
  const receipt = readJson(
    path.join(directory, 'receipt.json'),
    'Secret/Config plan receipt',
  );
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.schema !==
      'qinglong3-local-reconciliation-secret-config-plan-receipt' ||
    receipt?.state !== 'reconciliation_secret_config_planned' ||
    receipt?.secretConfigId !== secretConfig.secretConfigId ||
    receipt?.secretConfigPlanDigest !== secretConfig.secretConfigPlanDigest ||
    receipt?.outcome !== 'ready' ||
    receipt?.eligibleBindingCount !== secretConfig.eligibleBindingCount ||
    receipt?.eligiblePreservationCount !==
      secretConfig.eligiblePreservationCount ||
    receipt?.targetConflictCount !== 0 ||
    receipt?.unadaptedLegacyConfigCount !== 0
  ) {
    fail('Secret/Config plan receipt is not fixture-eligible');
  }
  const records = readNdjson(
    path.join(directory, 'plan.ndjson'),
    8 * 1024 * 1024,
    'Secret/Config row plan',
  );
  const candidates = records.filter(
    (record) =>
      record?.kind ===
      'qinglong3-local-reconciliation-secret-config-plan-candidate',
  );
  if (
    candidates.length !==
    secretConfig.eligibleBindingCount + secretConfig.eligiblePreservationCount
  ) {
    fail('Secret/Config row plan candidate count is incompatible');
  }
  const decisions = candidates.map((candidate) => {
    if (
      candidate?.schemaVersion !== 1 ||
      !Number.isSafeInteger(candidate.candidateOrdinal) ||
      candidate.candidateOrdinal < 1 ||
      !DIGEST.test(candidate.candidateDigest || '') ||
      !['review_apply_binding', 'review_preserve_disabled'].includes(
        candidate.requirement,
      ) ||
      candidate.target?.state !== 'absent'
    ) {
      fail('Secret/Config row plan contains a conflicting candidate');
    }
    const active = candidate.requirement === 'review_apply_binding';
    return {
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-secret-config-decision',
      candidateOrdinal: candidate.candidateOrdinal,
      candidateDigest: candidate.candidateDigest,
      disposition: active ? 'apply_active_binding' : 'preserve_disabled',
      reason: active
        ? 'reviewed_active_binding'
        : 'reviewed_disabled_preservation',
    };
  });
  const outputRecords = [
    {
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-secret-config-decision-header',
      decisionContractVersion: 1,
      decisionId: decision.decisionId,
      profile: summary.profile,
      secretConfigPlanDigest: secretConfig.secretConfigPlanDigest,
      preparationDigest: decision.preparationDigest,
    },
    ...decisions,
  ];
  const filePath = writeExclusive(output, outputRecords);
  return Object.freeze({
    mode: 'secret-config',
    filePath,
    decisionCount: decisions.length,
    secretConfigPlanDigest: secretConfig.secretConfigPlanDigest,
  });
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1]))
      fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  if (
    !['review', 'completion-review', 'automation', 'secret-config'].includes(
      values.mode,
    ) ||
    JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(['mode', 'output', 'reconciliation-root'])
  ) {
    fail('fixture arguments are invalid');
  }
  return Object.freeze({
    mode: values.mode,
    reconciliationRoot: fixtureRoot(values['reconciliation-root']),
    output: path.resolve(values.output),
  });
}

function runCli(argv) {
  const options = parseArguments(argv);
  const fixtures = {
    review: reviewFixture,
    'completion-review': completionReviewFixture,
    automation: automationFixture,
    'secret-config': secretConfigFixture,
  };
  const report = fixtures[options.mode](
    options.reconciliationRoot,
    options.output,
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'decision fixture failed'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  automationFixture,
  completionReviewFixture,
  diagnosticFacts,
  parseArguments,
  reviewFixture,
  runCli,
  secretConfigFixture,
});
