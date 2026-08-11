#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function fail(message) {
  throw new Error(message);
}

function startTicks() {
  const contents = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const commandEnd = contents.lastIndexOf(') ');
  const fields = contents
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const value = fields[19];
  if (!value || !/^[1-9][0-9]{0,19}$/.test(value)) {
    fail('process start ticks are unavailable');
  }
  return value;
}

function main() {
  const configPath = process.argv[2];
  if (!configPath || !configPath.startsWith('/')) {
    fail('absolute application config path is required');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const payload = {
    schemaVersion: 1,
    schema: 'qinglong/local-application-startup-receipt@v1',
    instanceId: config.instanceId,
    profile: config.profile,
    aiStatus: 'deployment_excluded',
    bootId: fs
      .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
      .trim()
      .toLowerCase(),
    activeBootAgeMs: Math.round(
      Number(fs.readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/u)[0]) *
        1000,
    ),
    processId: process.pid,
    processStartTicks: startTicks(),
    nodeExecutable: fs.realpathSync(process.execPath),
    nodeVersion: process.version,
  };
  const sha256 = crypto
    .createHash('sha256')
    .update('qinglong.local-application-startup-receipt.v1\0', 'utf8')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  const receiptPath = `${configPath}.active.json`;
  const stagePath = `${receiptPath}.${process.pid}.stage`;
  fs.writeFileSync(stagePath, `${JSON.stringify({ ...payload, sha256 })}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(stagePath, receiptPath);
  const handle = setInterval(() => {}, 60_000);
  const stop = (signal) => {
    const shutdownPayload = {
      schemaVersion: 1,
      schema: 'qinglong/local-application-shutdown-receipt@v1',
      instanceId: config.instanceId,
      profile: config.profile,
      signal,
      stopResult: 'stopped',
      startupReceiptDigest: sha256,
      bootId: payload.bootId,
      stoppedBootAgeMs: Math.round(
        Number(
          fs.readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/u)[0],
        ) * 1000,
      ),
      processId: process.pid,
      processStartTicks: payload.processStartTicks,
      nodeExecutable: payload.nodeExecutable,
      nodeVersion: payload.nodeVersion,
    };
    const shutdownSha256 = crypto
      .createHash('sha256')
      .update('qinglong.local-application-shutdown-receipt.v1\0', 'utf8')
      .update(JSON.stringify(shutdownPayload), 'utf8')
      .digest('hex');
    const shutdownPath = `${configPath}.stopped.json`;
    const shutdownStage = `${shutdownPath}.${process.pid}.stage`;
    fs.writeFileSync(
      shutdownStage,
      `${JSON.stringify({ ...shutdownPayload, sha256: shutdownSha256 })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    fs.renameSync(shutdownStage, shutdownPath);
    clearInterval(handle);
    process.exitCode = 0;
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.name ?? 'Error'}\n`);
  process.exitCode = 1;
}
