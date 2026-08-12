#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');

function imageIdDigest(image) {
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  return image.Id;
}

function localManifest(rendered, imageName, localImage) {
  const occurrences = rendered.split(imageName).length - 1;
  assert.ok(occurrences >= 1, 'reviewed image reference is missing');
  return rendered
    .replaceAll(imageName, localImage)
    .replaceAll('imagePullPolicy: IfNotPresent', 'imagePullPolicy: Never');
}

function applySecret(fixture, name, type, stringData) {
  fixture.apply({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace: 'qinglong3-system',
      labels: { 'cnpg.io/reload': 'true' },
    },
    immutable: false,
    type,
    stringData,
  });
}

function psql(fixture, podName, sql) {
  return fixture.kubectl(
    [
      '-n',
      'qinglong3-system',
      'exec',
      podName,
      '-c',
      'postgres',
      '--',
      'psql',
      '--username=postgres',
      '--dbname=qinglong',
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
      '--command',
      sql,
    ],
    { capture: true, quiet: true },
  ).stdout;
}

function currentPrimaryPod(fixture) {
  const primaryName = fixture.kubectlJson([
    '-n',
    'qinglong3-system',
    'get',
    'cluster',
    'ql3-postgres',
  ]).status.currentPrimary;
  assert.match(primaryName || '', /^ql3-postgres-[1-9][0-9]*$/);
  const pods = fixture.kubectlJson([
    '-n',
    'qinglong3-system',
    'get',
    'pods',
    '-l',
    'cnpg.io/cluster=ql3-postgres',
  ]).items;
  const primary = pods.find((pod) => pod.metadata.name === primaryName);
  assert.ok(primary, 'CloudNativePG primary Pod not found');
  return primary;
}

module.exports = {
  applySecret,
  currentPrimaryPod,
  imageIdDigest,
  localManifest,
  psql,
};
