#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const rootManifest = path.join(__dirname, '..', 'package.json');
const rootPackage = JSON.parse(fs.readFileSync(rootManifest));
const rootRequire = createRequire(rootManifest);
const sqliteManifest = rootRequire.resolve('sqlite3/package.json');
const sqlitePackage = JSON.parse(fs.readFileSync(sqliteManifest));
if (sqlitePackage.name !== '@whyour/sqlite3' || rootPackage.dependencies.sqlite3 !== `npm:${sqlitePackage.name}@${sqlitePackage.version}`) throw new Error('Unexpected bundled SQLite identity');
const forceSource = /^(true|1)$/i.test(String(process.env.npm_config_build_from_source || process.env.NPM_CONFIG_BUILD_FROM_SOURCE || ''));
let needsInstall = forceSource;
try { rootRequire('sqlite3'); }
catch (error) {
  if (!/Cannot find module|Could not locate the bindings file|dlopen|invalid ELF|not a valid Win32|wrong architecture/.test(String(error))) throw error;
  needsInstall = true;
}
if (needsInstall) {
  const sqliteRequire = createRequire(sqliteManifest);
  const installer = sqliteRequire.resolve('@mapbox/node-pre-gyp/bin/node-pre-gyp');
  const nodeGyp = sqliteRequire.resolve('node-gyp/bin/node-gyp.js');
  const installed = spawnSync(process.execPath, [installer, 'install', '--fallback-to-build'], { cwd: path.dirname(sqliteManifest), stdio: 'inherit', env: { ...process.env, npm_config_node_gyp: nodeGyp } });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) process.exit(installed.status || 1);
  rootRequire('sqlite3');
}
const binding = Object.keys(require.cache).find((file) => file.endsWith('.node') && file.startsWith(`${path.dirname(sqliteManifest)}${path.sep}`));
if (!binding) throw new Error('SQLite native binding did not load');
const sha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(binding)).digest('hex');
console.log(JSON.stringify({ bundledSqlite: sqlitePackage.version, platform: process.platform, arch: process.arch, forceSource, installation: forceSource ? 'source-built' : needsInstall ? 'installer-ran' : 'existing-binding', binding: path.relative(path.join(__dirname, '..'), binding), bindingSHA256: sha256 }));
