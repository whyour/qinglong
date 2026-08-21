#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const MAX_QL3_PACKAGE_IMPORTERS = 18;
const QL3_SELF_BUILD_SCRIPT = 'tsc -p tsconfig.json';
const QL3_PACKAGE_CLOSURE_BUILD_SCRIPT =
  'node ../../scripts/ql3-build-package-closure.cjs';

const FORBIDDEN_ROOT_PACKAGES = Object.freeze([
  '@qinglong/edge',
  '@qinglong/edge-adopted',
  '@qinglong/ai',
  '@qinglong/cluster-control',
  '@qinglong/cluster-admin',
  '@qinglong/cluster-postgres',
  '@qinglong/local-admin',
  '@qinglong/local-application',
  '@qinglong/local-command-file',
  '@qinglong/local-mcp-server',
  '@qinglong/local-adopted-profile',
  '@qinglong/local-cutover',
  '@qinglong/local-execution',
  '@qinglong/local-identity',
  '@qinglong/local-owner-bootstrap',
  '@qinglong/local-owner-ceremony',
  '@qinglong/local-owner-cli',
  '@qinglong/local-owner-console',
  '@qinglong/local-owner-credential-recovery',
  '@qinglong/local-owner-gc-cli',
  '@qinglong/local-owner-keyring',
  '@qinglong/local-owner-maintenance',
  '@qinglong/local-profile',
  '@qinglong/local-process',
  '@qinglong/local-secret',
  '@qinglong/local-secret-admin',
  '@qinglong/local-sqlite',
  '@qinglong/runtime-core',
  '@qinglong/standalone',
  '@qinglong/standalone-adopted',
  '@qinglong/worker-runtime',
  '@aws-sdk/client-s3',
  '@kubernetes/client-node',
  '@types/pg',
  'drizzle-kit',
  'drizzle-orm',
  'pg',
  'pg-native',
]);
const EXPECTED_PACKAGE_DEPENDENCIES = Object.freeze({
  'packages/ql3-ai': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@qinglong/local-sqlite': 'workspace:*',
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-command-file': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-api': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/local-application': 'workspace:*',
      '@qinglong/local-command-file': 'workspace:*',
      '@qinglong/local-owner-console': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@qinglong/local-sqlite': 'workspace:*',
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-mcp-server': Object.freeze({
    dependencies: Object.freeze({
      '@modelcontextprotocol/server': '2.0.0',
      '@qinglong/local-command-file': 'workspace:*',
      '@qinglong/local-owner-console': 'workspace:*',
      '@qinglong/local-sqlite': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-runtime-core': Object.freeze({
    dependencies: Object.freeze({
      semver: '7.7.4',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-sqlite': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      'drizzle-kit': '1.0.0-rc.4',
      'drizzle-orm': '1.0.0-rc.4',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-owner-console': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/local-sqlite': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-owner-cli': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/ai': 'workspace:*',
      '@qinglong/local-admin': 'workspace:*',
      '@qinglong/local-command-file': 'workspace:*',
      '@qinglong/local-owner-console': 'workspace:*',
      '@qinglong/local-secret': 'workspace:*',
      '@qinglong/local-sqlite': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-owner-maintenance': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/local-command-file': 'workspace:*',
      '@qinglong/local-owner-console': 'workspace:*',
      '@qinglong/local-sqlite': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@qinglong/ai': 'workspace:*',
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-secret': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@qinglong/local-sqlite': 'workspace:*',
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-admin': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/local-secret': 'workspace:*',
      '@qinglong/local-sqlite': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-application': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/local-admin': 'workspace:*',
      '@qinglong/local-command-file': 'workspace:*',
      '@qinglong/local-execution': 'workspace:*',
      '@qinglong/local-process': 'workspace:*',
      '@qinglong/local-secret': 'workspace:*',
      '@qinglong/local-sqlite': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@qinglong/ai': 'workspace:*',
      '@qinglong/local-owner-cli': 'workspace:*',
      '@qinglong/local-owner-console': 'workspace:*',
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-execution': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/local-command-file': 'workspace:*',
      '@qinglong/local-process': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
      croner: '7.0.8',
    }),
    devDependencies: Object.freeze({
      '@qinglong/local-sqlite': 'workspace:*',
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-local-process': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/runtime-core': 'workspace:*',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-cluster-postgres': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/runtime-core': 'workspace:*',
      'drizzle-orm': '0.45.2',
      pg: '8.22.0',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      '@types/pg': '8.20.0',
      'drizzle-kit': '0.31.10',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-cluster-control': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/cluster-postgres': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
      '@aws-sdk/client-s3': '3.1093.0',
      croner: '7.0.8',
    }),
    devDependencies: Object.freeze({
      '@qinglong/ai': 'workspace:*',
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
    peerDependencies: Object.freeze({
      '@qinglong/ai': 'workspace:*',
    }),
  }),
  'packages/ql3-cluster-admin': Object.freeze({
    dependencies: Object.freeze({
      '@modelcontextprotocol/server': '2.0.0',
      '@qinglong/ai': 'workspace:*',
      '@qinglong/cluster-postgres': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
      '@kubernetes/client-node': '1.4.0',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      typescript: '5.9.3',
    }),
  }),
  'packages/ql3-worker-runtime': Object.freeze({
    dependencies: Object.freeze({
      '@qinglong/local-process': 'workspace:*',
      '@qinglong/runtime-core': 'workspace:*',
      '@peculiar/x509': '2.0.0',
      'proper-lockfile': '4.1.2',
      'reflect-metadata': '0.2.2',
    }),
    devDependencies: Object.freeze({
      '@types/node': '24.13.3',
      '@types/proper-lockfile': '4.1.4',
      typescript: '5.9.3',
    }),
  }),
});
const EXPECTED_WORKSPACE_RESOLUTIONS = Object.freeze({
  'packages/ql3-local-api:@qinglong/local-application':
    'link:../ql3-local-application',
  'packages/ql3-local-api:@qinglong/local-command-file':
    'link:../ql3-local-command-file',
  'packages/ql3-local-api:@qinglong/local-owner-console':
    'link:../ql3-local-owner-console',
  'packages/ql3-local-api:@qinglong/runtime-core': 'link:../ql3-runtime-core',
  'packages/ql3-local-api:@qinglong/local-sqlite': 'link:../ql3-local-sqlite',
  'packages/ql3-local-mcp-server:@qinglong/local-command-file':
    'link:../ql3-local-command-file',
  'packages/ql3-local-mcp-server:@qinglong/local-owner-console':
    'link:../ql3-local-owner-console',
  'packages/ql3-local-mcp-server:@qinglong/local-sqlite':
    'link:../ql3-local-sqlite',
  'packages/ql3-local-mcp-server:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-ai:@qinglong/local-sqlite': 'link:../ql3-local-sqlite',
  'packages/ql3-ai:@qinglong/runtime-core': 'link:../ql3-runtime-core',
  'packages/ql3-worker-runtime:@qinglong/local-process':
    'link:../ql3-local-process',
  'packages/ql3-worker-runtime:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-local-sqlite:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-local-owner-console:@qinglong/local-sqlite':
    'link:../ql3-local-sqlite',
  'packages/ql3-local-owner-console:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-local-owner-cli:@qinglong/local-command-file':
    'link:../ql3-local-command-file',
  'packages/ql3-local-owner-cli:@qinglong/ai': 'link:../ql3-ai',
  'packages/ql3-local-owner-cli:@qinglong/local-admin':
    'link:../ql3-local-admin',
  'packages/ql3-local-owner-cli:@qinglong/local-secret':
    'link:../ql3-local-secret',
  'packages/ql3-local-owner-cli:@qinglong/local-owner-console':
    'link:../ql3-local-owner-console',
  'packages/ql3-local-owner-cli:@qinglong/local-sqlite':
    'link:../ql3-local-sqlite',
  'packages/ql3-local-owner-cli:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-local-owner-maintenance:@qinglong/local-owner-console':
    'link:../ql3-local-owner-console',
  'packages/ql3-local-owner-maintenance:@qinglong/local-command-file':
    'link:../ql3-local-command-file',
  'packages/ql3-local-owner-maintenance:@qinglong/local-sqlite':
    'link:../ql3-local-sqlite',
  'packages/ql3-local-owner-maintenance:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-local-owner-maintenance:@qinglong/ai': 'link:../ql3-ai',
  'packages/ql3-local-secret:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-local-secret:@qinglong/local-sqlite':
    'link:../ql3-local-sqlite',
  'packages/ql3-local-admin:@qinglong/local-sqlite': 'link:../ql3-local-sqlite',
  'packages/ql3-local-admin:@qinglong/local-secret': 'link:../ql3-local-secret',
  'packages/ql3-local-admin:@qinglong/runtime-core': 'link:../ql3-runtime-core',
  'packages/ql3-local-application:@qinglong/local-command-file':
    'link:../ql3-local-command-file',
  'packages/ql3-local-application:@qinglong/local-execution':
    'link:../ql3-local-execution',
  'packages/ql3-local-application:@qinglong/local-process':
    'link:../ql3-local-process',
  'packages/ql3-local-application:@qinglong/local-secret':
    'link:../ql3-local-secret',
  'packages/ql3-local-application:@qinglong/local-admin':
    'link:../ql3-local-admin',
  'packages/ql3-local-application:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-local-application:@qinglong/local-sqlite':
    'link:../ql3-local-sqlite',
  'packages/ql3-local-application:@qinglong/ai': 'link:../ql3-ai',
  'packages/ql3-local-application:@qinglong/local-owner-cli':
    'link:../ql3-local-owner-cli',
  'packages/ql3-local-application:@qinglong/local-owner-console':
    'link:../ql3-local-owner-console',
  'packages/ql3-local-execution:@qinglong/local-process':
    'link:../ql3-local-process',
  'packages/ql3-local-execution:@qinglong/local-command-file':
    'link:../ql3-local-command-file',
  'packages/ql3-local-execution:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-local-execution:@qinglong/local-sqlite':
    'link:../ql3-local-sqlite',
  'packages/ql3-local-process:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-local-command-file:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-cluster-postgres:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-cluster-control:@qinglong/cluster-postgres':
    'link:../ql3-cluster-postgres',
  'packages/ql3-cluster-control:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
  'packages/ql3-cluster-control:@qinglong/ai': 'link:../ql3-ai',
  'packages/ql3-cluster-admin:@qinglong/cluster-postgres':
    'link:../ql3-cluster-postgres',
  'packages/ql3-cluster-admin:@qinglong/ai': 'link:../ql3-ai',
  'packages/ql3-cluster-admin:@qinglong/runtime-core':
    'link:../ql3-runtime-core',
});
const FORBIDDEN_SOURCE_IMPORTS = Object.freeze({
  'packages/ql3-local-api': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/ai',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-admin',
    '@qinglong/local-execution',
    '@qinglong/local-mcp-server',
    '@qinglong/local-owner-cli',
    '@qinglong/local-owner-maintenance',
    '@qinglong/local-process',
    '@qinglong/local-secret',
    '@qinglong/local-sqlite',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    '@aws-sdk/client-s3',
    '@kubernetes/client-node',
    'croner',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-mcp-server': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/ai',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-admin',
    '@qinglong/local-application',
    '@qinglong/local-execution',
    '@qinglong/local-owner-cli',
    '@qinglong/local-owner-maintenance',
    '@qinglong/local-process',
    '@qinglong/local-secret',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    '@aws-sdk/client-s3',
    '@kubernetes/client-node',
    'croner',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-ai': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/edge-adopted',
    '@qinglong/local-admin',
    '@qinglong/local-adopted-profile',
    '@qinglong/local-application',
    '@qinglong/local-command-file',
    '@qinglong/local-cutover',
    '@qinglong/local-execution',
    '@qinglong/local-identity',
    '@qinglong/local-owner-cli',
    '@qinglong/local-owner-console',
    '@qinglong/local-owner-keyring',
    '@qinglong/local-owner-maintenance',
    '@qinglong/local-process',
    '@qinglong/local-profile',
    '@qinglong/local-secret',
    '@qinglong/local-secret-admin',
    '@qinglong/local-sqlite',
    '@qinglong/standalone',
    '@qinglong/standalone-adopted',
    '@qinglong/worker-runtime',
    '@aws-sdk/client-s3',
    '@kubernetes/client-node',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-command-file': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-admin',
    '@qinglong/local-adopted-profile',
    '@qinglong/local-application',
    '@qinglong/local-cutover',
    '@qinglong/local-dispatch',
    '@qinglong/local-execution',
    '@qinglong/local-execution-control',
    '@qinglong/local-identity',
    '@qinglong/local-owner-bootstrap',
    '@qinglong/local-owner-cli',
    '@qinglong/local-owner-console',
    '@qinglong/local-owner-credential-recovery',
    '@qinglong/local-owner-gc-cli',
    '@qinglong/local-owner-keyring',
    '@qinglong/local-owner-maintenance',
    '@qinglong/local-profile',
    '@qinglong/local-process',
    '@qinglong/local-run-recovery',
    '@qinglong/local-secret',
    '@qinglong/local-secret-admin',
    '@qinglong/local-sqlite',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-runtime-core': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-sqlite': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-profile',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-identity': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-admin',
    '@qinglong/local-adopted-profile',
    '@qinglong/local-application',
    '@qinglong/local-cutover',
    '@qinglong/local-dispatch',
    '@qinglong/local-execution',
    '@qinglong/local-execution-control',
    '@qinglong/local-profile',
    '@qinglong/local-process',
    '@qinglong/local-run-recovery',
    '@qinglong/local-secret',
    '@qinglong/local-secret-admin',
    '@qinglong/local-sqlite',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-owner-console': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-admin',
    '@qinglong/local-adopted-profile',
    '@qinglong/local-application',
    '@qinglong/local-cutover',
    '@qinglong/local-dispatch',
    '@qinglong/local-execution',
    '@qinglong/local-execution-control',
    '@qinglong/local-profile',
    '@qinglong/local-process',
    '@qinglong/local-run-recovery',
    '@qinglong/local-secret',
    '@qinglong/local-secret-admin',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-owner-cli': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-adopted-profile',
    '@qinglong/local-application',
    '@qinglong/local-cutover',
    '@qinglong/local-dispatch',
    '@qinglong/local-execution',
    '@qinglong/local-execution-control',
    '@qinglong/local-owner-bootstrap',
    '@qinglong/local-owner-credential-recovery',
    '@qinglong/local-owner-gc-cli',
    '@qinglong/local-owner-maintenance',
    '@qinglong/local-profile',
    '@qinglong/local-process',
    '@qinglong/local-run-recovery',
    '@qinglong/local-secret',
    '@qinglong/local-secret-admin',
    '@qinglong/runtime-core',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-owner-maintenance': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-admin',
    '@qinglong/local-adopted-profile',
    '@qinglong/local-application',
    '@qinglong/local-cutover',
    '@qinglong/local-dispatch',
    '@qinglong/local-execution',
    '@qinglong/local-execution-control',
    '@qinglong/local-identity',
    '@qinglong/local-owner-bootstrap',
    '@qinglong/local-owner-cli',
    '@qinglong/local-owner-credential-recovery',
    '@qinglong/local-owner-gc-cli',
    '@qinglong/local-profile',
    '@qinglong/local-process',
    '@qinglong/local-run-recovery',
    '@qinglong/local-secret',
    '@qinglong/local-secret-admin',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-secret': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-admin',
    '@qinglong/local-adopted-profile',
    '@qinglong/local-application',
    '@qinglong/local-cutover',
    '@qinglong/local-dispatch',
    '@qinglong/local-execution',
    '@qinglong/local-execution-control',
    '@qinglong/local-profile',
    '@qinglong/local-process',
    '@qinglong/local-run-recovery',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-secret-admin': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-admin',
    '@qinglong/local-adopted-profile',
    '@qinglong/local-application',
    '@qinglong/local-cutover',
    '@qinglong/local-dispatch',
    '@qinglong/local-execution',
    '@qinglong/local-execution-control',
    '@qinglong/local-profile',
    '@qinglong/local-process',
    '@qinglong/local-run-recovery',
    '@qinglong/local-sqlite',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-admin': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-profile',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-application': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/edge-adopted',
    '@qinglong/local-cutover',
    '@qinglong/local-profile',
    '@qinglong/local-sqlite',
    '@qinglong/standalone',
    '@qinglong/standalone-adopted',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-execution': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/edge-adopted',
    '@qinglong/local-admin',
    '@qinglong/local-adopted-profile',
    '@qinglong/local-application',
    '@qinglong/local-cutover',
    '@qinglong/local-dispatch',
    '@qinglong/local-execution-control',
    '@qinglong/local-profile',
    '@qinglong/local-run-recovery',
    '@qinglong/local-sqlite',
    '@qinglong/standalone',
    '@qinglong/standalone-adopted',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-local-process': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    '@qinglong/edge',
    '@qinglong/local-admin',
    '@qinglong/local-adopted-profile',
    '@qinglong/local-application',
    '@qinglong/local-cutover',
    '@qinglong/local-dispatch',
    '@qinglong/local-execution',
    '@qinglong/local-execution-control',
    '@qinglong/local-profile',
    '@qinglong/local-run-recovery',
    '@qinglong/local-sqlite',
    '@qinglong/standalone',
    '@qinglong/worker-runtime',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-cluster-postgres': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-control',
    'express',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-cluster-control': Object.freeze([
    '@whyour/qinglong',
    'express',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-cluster-admin': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-control',
    'express',
    'sequelize',
    'sqlite3',
  ]),
  'packages/ql3-worker-runtime': Object.freeze([
    '@whyour/qinglong',
    '@qinglong/cluster-admin',
    '@qinglong/cluster-control',
    '@qinglong/cluster-postgres',
    'drizzle-orm',
    'express',
    'pg',
    'sequelize',
    'sqlite3',
  ]),
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function dependencyNames(importer) {
  return ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap(
    (section) => Object.keys(importer?.[section] ?? {}),
  );
}

function listTypeScriptSourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(absolutePath);
      }
    }
  }
  return files.sort();
}

function listQingLong3PackageImporters(root) {
  const packagesDirectory = path.join(root, 'packages');
  const importers = fs
    .readdirSync(packagesDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith('ql3-') &&
        fs.existsSync(path.join(packagesDirectory, entry.name, 'package.json')),
    )
    .map((entry) => `packages/${entry.name}`)
    .sort();
  if (importers.length > MAX_QL3_PACKAGE_IMPORTERS) {
    throw new Error('QingLong 3.0 package importer budget exceeded');
  }
  return importers;
}

function auditRegisteredPackageImporters(root, findings) {
  for (const packagePath of listQingLong3PackageImporters(root)) {
    if (!(packagePath in EXPECTED_PACKAGE_DEPENDENCIES)) {
      findings.push({
        code: 'UNREVIEWED_QL3_PACKAGE_IMPORTER',
        packagePath,
      });
    }
  }
}

function auditSourceImports(root, packagePath, findings) {
  const packageDirectory = path.join(root, packagePath);
  const sourceFiles = listTypeScriptSourceFiles(
    path.join(packageDirectory, 'src'),
  );
  const forbidden = FORBIDDEN_SOURCE_IMPORTS[packagePath] ?? [];
  for (const filePath of sourceFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    const imports = source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
    );
    for (const match of imports) {
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(filePath), specifier);
        const relative = path.relative(packageDirectory, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
          findings.push({
            code: 'PACKAGE_SOURCE_BOUNDARY_ESCAPE',
            packagePath,
            file: path.relative(root, filePath),
            specifier,
          });
        } else if (packagePath === 'packages/ql3-local-sqlite') {
          const sourceArea = path
            .relative(packageDirectory, filePath)
            .split(path.sep)[1];
          const targetArea = relative.split(path.sep)[1];
          const targetRelative = relative.split(path.sep).join('/');
          if (
            sourceArea === 'profile' &&
            targetArea !== 'profile' &&
            targetRelative !== 'src/runtime/runtimeDatabase'
          ) {
            findings.push({
              code: 'FORBIDDEN_LOCAL_PROFILE_SQLITE_AREA_IMPORT',
              packagePath,
              file: path.relative(root, filePath),
              specifier,
            });
          }
        } else if (packagePath === 'packages/ql3-local-admin') {
          const sourceArea = path
            .relative(packageDirectory, filePath)
            .split(path.sep)[1];
          const targetArea = relative.split(path.sep)[1];
          const targetRelative = relative.split(path.sep).join('/');
          if (
            sourceArea === 'adopted-profile' &&
            targetArea !== 'adopted-profile' &&
            !['src/runtime', 'src/runtime.js'].includes(targetRelative)
          ) {
            findings.push({
              code: 'FORBIDDEN_ADOPTED_PROFILE_ADMIN_AREA_IMPORT',
              packagePath,
              file: path.relative(root, filePath),
              specifier,
            });
          }
        } else if (packagePath === 'packages/ql3-local-execution') {
          const sourceArea = path
            .relative(packageDirectory, filePath)
            .split(path.sep)[1];
          const targetArea = relative.split(path.sep)[1];
          const targetRelative = relative.split(path.sep).join('/');
          const allowedCrossAreaImports = Object.freeze({
            control: Object.freeze([]),
            dispatch: Object.freeze(['execution']),
            execution: Object.freeze([]),
            recovery: Object.freeze(['control']),
            scheduler: Object.freeze(['dispatch']),
          });
          const reviewedSharedPorts = Object.freeze([
            'src/execution/workflowTaskExecution',
          ]);
          if (
            sourceArea !== targetArea &&
            !reviewedSharedPorts.includes(targetRelative) &&
            !allowedCrossAreaImports[sourceArea]?.includes(targetArea)
          ) {
            findings.push({
              code: 'FORBIDDEN_LOCAL_EXECUTION_CROSS_AREA_IMPORT',
              packagePath,
              file: path.relative(root, filePath),
              specifier,
            });
          }
        } else if (packagePath === 'packages/ql3-local-owner-console') {
          const sourceArea = path
            .relative(packageDirectory, filePath)
            .split(path.sep)[1];
          const targetArea = relative.split(path.sep)[1];
          const targetRelative = relative.split(path.sep).join('/');
          const ceremonyAreas = Object.freeze([
            'bootstrap',
            'credential-recovery',
          ]);
          const reviewedCeremonyConsumers = Object.freeze([
            'src/application-runtime/localOwnerConsole.ts',
            'src/delivery/secret-delivery/ceremonyContracts.ts',
          ]);
          const sourceRelative = path
            .relative(packageDirectory, filePath)
            .split(path.sep)
            .join('/');
          const identityTarget =
            targetRelative === 'src/authentication/identityAuthentication';
          if (
            (ceremonyAreas.includes(sourceArea) &&
              sourceArea !== targetArea &&
              !(sourceArea === 'bootstrap' && identityTarget)) ||
            (ceremonyAreas.includes(targetArea) &&
              sourceArea !== targetArea &&
              !reviewedCeremonyConsumers.includes(sourceRelative))
          ) {
            findings.push({
              code: 'FORBIDDEN_LOCAL_OWNER_CEREMONY_CROSS_AREA_IMPORT',
              packagePath,
              file: path.relative(root, filePath),
              specifier,
            });
          }
          if (
            identityTarget &&
            ![
              'src/authentication/authenticatedCommand.ts',
              'src/bootstrap/index.ts',
            ].includes(sourceRelative)
          ) {
            findings.push({
              code: 'FORBIDDEN_LOCAL_IDENTITY_AUTHORITY_IMPORT',
              packagePath,
              file: path.relative(root, filePath),
              specifier,
            });
          }
        }
        continue;
      }
      if (
        packagePath !== 'packages/ql3-local-mcp-server' &&
        (specifier === '@qinglong/local-mcp-server' ||
          specifier.startsWith('@qinglong/local-mcp-server/'))
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_MCP_SERVER_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-mcp-server' &&
        (specifier.startsWith('@modelcontextprotocol/') ||
          specifier.startsWith('@qinglong/')) &&
        ![
          '@modelcontextprotocol/server',
          '@modelcontextprotocol/server/stdio',
          '@qinglong/local-command-file',
          '@qinglong/local-command-file/artifact-read',
          '@qinglong/local-owner-console/authenticated-command',
          '@qinglong/local-sqlite/mcp-read-database',
          '@qinglong/runtime-core/approval-discovery',
          '@qinglong/runtime-core/approved-action',
          '@qinglong/runtime-core/bounded-run-event-list-projection',
          '@qinglong/runtime-core/bounded-run-list-projection',
          '@qinglong/runtime-core/bounded-run-step-list-projection',
          '@qinglong/runtime-core/builtin-run-compare-projection',
          '@qinglong/runtime-core/builtin-run-log-excerpt-projection',
          '@qinglong/runtime-core/builtin-task-run-outcome-compare-projection',
          '@qinglong/runtime-core/builtin-run-read-projection',
          '@qinglong/runtime-core/bounded-task-read-projection',
          '@qinglong/runtime-core/bounded-task-list-projection',
          '@qinglong/runtime-core/project-run-list',
          '@qinglong/runtime-core/task-run-outcome-window',
          '@qinglong/runtime-core/project-policy',
          '@qinglong/runtime-core/run-attempt-log-read',
          '@qinglong/runtime-core/run',
          '@qinglong/runtime-core/run-repository',
          '@qinglong/runtime-core/security',
          '@qinglong/runtime-core/security-audit',
          '@qinglong/runtime-core/step-run',
          '@qinglong/runtime-core/task-definition',
          '@qinglong/runtime-core/tool-registry',
          '@qinglong/runtime-core/trigger',
        ].includes(specifier)
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_MCP_SERVER_AUTHORITY_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-command-file' &&
        (specifier === '@qinglong/runtime-core' ||
          specifier.startsWith('@qinglong/runtime-core/')) &&
        specifier !== '@qinglong/runtime-core/run-attempt-log-read'
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_FILE_AUTHORITY_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === 'croner' &&
        !(
          (packagePath === 'packages/ql3-local-execution' &&
            path.relative(packageDirectory, filePath) ===
              'src/scheduler/croner.ts') ||
          (packagePath === 'packages/ql3-cluster-control' &&
            path.relative(packageDirectory, filePath) ===
              'src/scheduling/cronerSchedule.ts')
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_CRONER_PROVIDER_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === 'semver' &&
        !(
          packagePath === 'packages/ql3-runtime-core' &&
          path.relative(packageDirectory, filePath) ===
            'src/versioning/pinnedSemver.ts'
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_SEMVER_PROVIDER_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@aws-sdk/client-s3' &&
        !(
          packagePath === 'packages/ql3-cluster-control' &&
          path.relative(packageDirectory, filePath) ===
            'src/artifact/s3ArtifactStore.ts'
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_S3_CLIENT_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath !== 'packages/ql3-cluster-admin' &&
        specifier ===
          '@qinglong/cluster-admin/plugin-package-management-transport'
      ) {
        findings.push({
          code: 'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_TRANSPORT_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath !== 'packages/ql3-cluster-admin' &&
        specifier ===
          '@qinglong/cluster-admin/plugin-package-identity-assertion'
      ) {
        findings.push({
          code: 'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_ASSERTION_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath !== 'packages/ql3-cluster-admin' &&
        [
          '@qinglong/cluster-admin/plugin-package-identity-keyset',
          '@qinglong/cluster-admin/plugin-package-management-http',
          '@qinglong/cluster-admin/plugin-package-management-process',
        ].includes(specifier)
      ) {
        findings.push({
          code: 'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_PROCESS_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-cluster-control' &&
        (specifier === '@qinglong/ai' || specifier.startsWith('@qinglong/ai/'))
      ) {
        const clusterAiImports = Object.freeze({
          'src/aiCli.ts': Object.freeze(['@qinglong/ai/profile']),
          'src/application-runtime/aiProductionApplication.ts': Object.freeze([
            '@qinglong/ai/durable-model-invocation',
            '@qinglong/ai/failure-diagnosis-application',
            '@qinglong/ai/failure-diagnosis-cancellation',
            '@qinglong/ai/failure-diagnosis-model-execution',
            '@qinglong/ai/plugin-package-prompt-output-projected-keyring',
            '@qinglong/ai/postgres-model-provider-credential-storage',
            '@qinglong/ai/postgres-plugin-package-prompt-application',
            '@qinglong/ai/profile',
            '@qinglong/ai/projected-model-gateway-authority',
            '@qinglong/ai/projected-model-provider-secret-material',
            '@qinglong/ai/provider-credential',
          ]),
          'src/application-runtime/copilot/failureDiagnosisComposition.ts':
            Object.freeze([
              '@qinglong/ai/failure-diagnosis-application',
              '@qinglong/ai/failure-diagnosis-execution-admission',
              '@qinglong/ai/failure-diagnosis-model-execution',
              '@qinglong/ai/failure-diagnosis-pre-model-terminalization',
              '@qinglong/ai/failure-diagnosis-tool-execution',
              '@qinglong/ai/postgres-failure-diagnosis-admission-storage',
              '@qinglong/ai/postgres-failure-diagnosis-model-execution-storage',
              '@qinglong/ai/postgres-failure-diagnosis-tool-execution-storage',
              '@qinglong/ai/profile',
            ]),
          'src/application-runtime/copilot/failureDiagnosisReadComposition.ts':
            Object.freeze([
              '@qinglong/ai/failure-diagnosis-pre-model-terminalization',
              '@qinglong/ai/failure-diagnosis-read-model',
              '@qinglong/ai/postgres-failure-diagnosis-admission-storage',
              '@qinglong/ai/postgres-failure-diagnosis-model-execution-storage',
            ]),
          'src/application-runtime/copilot/failureDiagnosisCancellationComposition.ts':
            Object.freeze([
              '@qinglong/ai/failure-diagnosis-cancellation',
              '@qinglong/ai/failure-diagnosis-pre-model-terminalization',
              '@qinglong/ai/postgres-failure-diagnosis-admission-storage',
            ]),
          'src/copilot/failure-diagnosis/failureDiagnosisCancellationRoute.ts':
            Object.freeze(['@qinglong/ai/failure-diagnosis-cancellation']),
        });
        const sourceRelative = path.relative(packageDirectory, filePath);
        if (!clusterAiImports[sourceRelative]?.includes(specifier)) {
          findings.push({
            code: 'FORBIDDEN_CLUSTER_CONTROL_AI_ENTRYPOINT',
            packagePath,
            file: path.relative(root, filePath),
            specifier,
          });
        }
        continue;
      }
      if (
        packagePath === 'packages/ql3-cluster-admin' &&
        (specifier === '@qinglong/ai' || specifier.startsWith('@qinglong/ai/'))
      ) {
        const clusterAdminAiImports = Object.freeze({
          'src/modelInvocationMigrationCli.ts': Object.freeze([
            '@qinglong/ai/model-invocation-migration',
          ]),
          'src/model-provider-credential/modelProviderCredentialManagement.ts':
            Object.freeze([
              '@qinglong/ai/model-provider-credential-administration',
              '@qinglong/ai/model-provider-credential-catalog',
              '@qinglong/ai/model-provider-credential-test-connection',
              '@qinglong/ai/postgres-model-provider-credential-management-audit-query',
              '@qinglong/ai/postgres-model-provider-credential-test-connection',
              '@qinglong/ai/provider-credential',
            ]),
          'src/model-provider-credential/modelProviderCredentialManagementClient.ts':
            Object.freeze([
              '@qinglong/ai/model-provider-credential-test-connection',
            ]),
          'src/model-provider-credential/modelProviderCredentialManagementProcess.ts':
            Object.freeze([
              '@qinglong/ai/model-provider-credential-test-connection',
              '@qinglong/ai/postgres-model-provider-credential-management-audit-query',
              '@qinglong/ai/postgres-model-provider-credential-management-identity-ledger',
              '@qinglong/ai/postgres-model-provider-credential-test-connection',
              '@qinglong/ai/postgres-model-provider-credential-storage',
            ]),
          'src/model-provider-credential/modelProviderCredentialManagementTransport.ts':
            Object.freeze([
              '@qinglong/ai/model-provider-credential-test-connection',
            ]),
          'src/model-provider-credential/modelProviderCredentialTestExecutor.ts':
            Object.freeze([
              '@qinglong/ai/model-provider-credential-test-connection',
              '@qinglong/ai/openai-compatible',
              '@qinglong/ai/postgres-model-provider-credential-test-connection',
              '@qinglong/ai/provider-credential',
            ]),
          'src/model-provider-credential/modelProviderCredentialTestExecutorProcess.ts':
            Object.freeze([
              '@qinglong/ai/model-provider-credential-test-connection',
              '@qinglong/ai/postgres-model-provider-credential-storage',
              '@qinglong/ai/postgres-model-provider-credential-test-connection',
              '@qinglong/ai/projected-model-provider-secret-material',
            ]),
          'src/prompt-output/retention/promptOutputGcCli.ts': Object.freeze([
            '@qinglong/ai/plugin-package-prompt-output-retention',
          ]),
          'src/prompt-output/retention/promptOutputGcProcess.ts': Object.freeze(
            [
              '@qinglong/ai/plugin-package-prompt-output-retention',
              '@qinglong/ai/postgres-plugin-package-prompt-output-retention-storage',
            ],
          ),
          'src/prompt-output/external-recovery/promptOutputExternalRecoveryInput.ts':
            Object.freeze([
              '@qinglong/ai/plugin-package-prompt-output-artifact',
              '@qinglong/ai/plugin-package-prompt-output-external-custody',
              '@qinglong/ai/plugin-package-prompt-output-external-custody-bundle',
              '@qinglong/ai/plugin-package-prompt-output-external-recovery-authorization',
            ]),
          'src/prompt-output/external-recovery/promptOutputExternalRecoveryVerifier.ts':
            Object.freeze([
              '@qinglong/ai/plugin-package-prompt-output-external-recovery-authorization',
            ]),
          'src/prompt-output/key-management/promptOutputKeyRetirementProcess.ts':
            Object.freeze([
              '@qinglong/ai/plugin-package-prompt-output-key-retirement',
              '@qinglong/ai/postgres-plugin-package-prompt-output-key-retirement-storage',
              '@qinglong/ai/postgres-plugin-package-prompt-output-retention-storage',
            ]),
          'src/prompt-output/key-management/promptOutputKeyRotationProcess.ts':
            Object.freeze([
              '@qinglong/ai/plugin-package-prompt-output-key-rotation',
              '@qinglong/ai/postgres-plugin-package-prompt-output-key-rotation-storage',
              '@qinglong/ai/postgres-plugin-package-prompt-output-retention-storage',
            ]),
          'src/prompt-output/key-management/promptOutputKubernetesSecretKeyring.ts':
            Object.freeze([
              '@qinglong/ai/plugin-package-prompt-output-key-retirement',
              '@qinglong/ai/plugin-package-prompt-output-keyring-manifest',
            ]),
        });
        const sourceRelative = path.relative(packageDirectory, filePath);
        if (!clusterAdminAiImports[sourceRelative]?.includes(specifier)) {
          findings.push({
            code: 'FORBIDDEN_CLUSTER_ADMIN_AI_ENTRYPOINT',
            packagePath,
            file: path.relative(root, filePath),
            specifier,
          });
        }
        continue;
      }
      if (
        packagePath === 'packages/ql3-cluster-admin' &&
        path.relative(packageDirectory, filePath) ===
          'src/plugin-package/management/pluginPackageManagementTransport.ts'
      ) {
        const allowedRuntimeCoreImports = Object.freeze([
          '@qinglong/runtime-core/approved-action',
          '@qinglong/runtime-core/plugin-package-install',
          '@qinglong/runtime-core/plugin-package-lifecycle-plan',
          '@qinglong/runtime-core/plugin-package-management',
          '@qinglong/runtime-core/plugin-package-proposal',
          '@qinglong/runtime-core/plugin-package-secret-binding',
          '@qinglong/runtime-core/plugin-package-secret-binding-approval-plan',
          '@qinglong/runtime-core/plugin-package-secret-binding-transition-approval-plan',
          '@qinglong/runtime-core/security',
        ]);
        if (
          specifier === '@kubernetes/client-node' ||
          specifier === 'drizzle-orm' ||
          specifier.startsWith('drizzle-orm/') ||
          specifier === 'pg' ||
          specifier.startsWith('pg/') ||
          specifier === 'node:http' ||
          specifier === 'node:https' ||
          specifier === 'node:net' ||
          specifier === 'node:tls' ||
          specifier === '@qinglong/cluster-postgres' ||
          specifier.startsWith('@qinglong/cluster-postgres/')
        ) {
          findings.push({
            code: 'FORBIDDEN_CLUSTER_PACKAGE_TRANSPORT_INFRA_IMPORT',
            packagePath,
            file: path.relative(root, filePath),
            specifier,
          });
          continue;
        }
        if (
          (specifier === '@qinglong/runtime-core' ||
            specifier.startsWith('@qinglong/runtime-core/')) &&
          !allowedRuntimeCoreImports.includes(specifier)
        ) {
          findings.push({
            code: 'FORBIDDEN_CLUSTER_PACKAGE_TRANSPORT_CORE_IMPORT',
            packagePath,
            file: path.relative(root, filePath),
            specifier,
          });
          continue;
        }
      }
      if (
        packagePath === 'packages/ql3-cluster-admin' &&
        path.relative(packageDirectory, filePath) ===
          'src/management-support/pluginPackageIdentityAssertion.ts'
      ) {
        if (
          specifier === '@kubernetes/client-node' ||
          specifier === 'drizzle-orm' ||
          specifier.startsWith('drizzle-orm/') ||
          specifier === 'pg' ||
          specifier.startsWith('pg/') ||
          specifier === 'node:http' ||
          specifier === 'node:https' ||
          specifier === 'node:net' ||
          specifier === 'node:tls' ||
          specifier === '@qinglong/cluster-postgres' ||
          specifier.startsWith('@qinglong/cluster-postgres/')
        ) {
          findings.push({
            code: 'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_INFRA_IMPORT',
            packagePath,
            file: path.relative(root, filePath),
            specifier,
          });
          continue;
        }
        if (
          (specifier === '@qinglong/runtime-core' ||
            specifier.startsWith('@qinglong/runtime-core/')) &&
          specifier !== '@qinglong/runtime-core/security'
        ) {
          findings.push({
            code: 'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_CORE_IMPORT',
            packagePath,
            file: path.relative(root, filePath),
            specifier,
          });
          continue;
        }
      }
      if (
        packagePath === 'packages/ql3-cluster-admin' &&
        path.relative(packageDirectory, filePath) ===
          'src/management-support/pluginPackageIdentityKeyset.ts' &&
        (specifier === '@kubernetes/client-node' ||
          specifier === 'drizzle-orm' ||
          specifier.startsWith('drizzle-orm/') ||
          specifier === 'pg' ||
          specifier.startsWith('pg/') ||
          specifier === 'node:http' ||
          specifier === 'node:https' ||
          specifier === 'node:net' ||
          specifier === 'node:tls' ||
          specifier === '@qinglong/runtime-core' ||
          specifier.startsWith('@qinglong/runtime-core/') ||
          specifier === '@qinglong/cluster-postgres' ||
          specifier.startsWith('@qinglong/cluster-postgres/'))
      ) {
        findings.push({
          code: 'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_KEYSET_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-cluster-admin' &&
        path.relative(packageDirectory, filePath) ===
          'src/management-support/pluginPackageManagementHttp.ts'
      ) {
        if (
          specifier === '@kubernetes/client-node' ||
          specifier === 'drizzle-orm' ||
          specifier.startsWith('drizzle-orm/') ||
          specifier === 'pg' ||
          specifier.startsWith('pg/') ||
          specifier === '@qinglong/cluster-postgres' ||
          specifier.startsWith('@qinglong/cluster-postgres/')
        ) {
          findings.push({
            code: 'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_HTTP_INFRA_IMPORT',
            packagePath,
            file: path.relative(root, filePath),
            specifier,
          });
          continue;
        }
        if (
          (specifier === '@qinglong/runtime-core' ||
            specifier.startsWith('@qinglong/runtime-core/')) &&
          specifier !== '@qinglong/runtime-core/plugin-package-management'
        ) {
          findings.push({
            code: 'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_HTTP_CORE_IMPORT',
            packagePath,
            file: path.relative(root, filePath),
            specifier,
          });
          continue;
        }
      }
      if (
        packagePath === 'packages/ql3-cluster-admin' &&
        path.relative(packageDirectory, filePath) ===
          'src/plugin-package/management/pluginPackageManagementProcess.ts' &&
        (specifier === '@kubernetes/client-node' ||
          specifier === 'drizzle-orm' ||
          specifier.startsWith('drizzle-orm/') ||
          specifier === 'pg' ||
          specifier.startsWith('pg/') ||
          specifier === '@qinglong/cluster-postgres' ||
          (specifier.startsWith('@qinglong/cluster-postgres/') &&
            specifier !== '@qinglong/cluster-postgres/package-manager'))
      ) {
        findings.push({
          code: 'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_PROCESS_INFRA_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-cluster-admin' &&
        path.relative(packageDirectory, filePath) ===
          'src/plugin-package/management/pluginPackageManagement.ts' &&
        [
          '@qinglong/cluster-postgres/approved-action-execution',
          '@qinglong/cluster-postgres/plugin-package-install',
        ].includes(specifier)
      ) {
        findings.push({
          code: 'FORBIDDEN_CLUSTER_PACKAGE_MANAGER_EXECUTOR_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@qinglong/local-dispatch' ||
        specifier.startsWith('@qinglong/local-dispatch/') ||
        specifier === '@qinglong/local-execution-control' ||
        specifier.startsWith('@qinglong/local-execution-control/') ||
        specifier === '@qinglong/local-run-recovery' ||
        specifier.startsWith('@qinglong/local-run-recovery/')
      ) {
        findings.push({
          code: 'DEPRECATED_LOCAL_EXECUTION_PACKAGE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        (specifier === '@qinglong/local-execution' ||
          specifier.startsWith('@qinglong/local-execution/')) &&
        (packagePath !== 'packages/ql3-local-application' ||
          ![
            '@qinglong/local-execution/artifact-read',
            '@qinglong/local-execution/control',
            '@qinglong/local-execution/dispatch',
            '@qinglong/local-execution/execution',
            '@qinglong/local-execution/recovery',
            '@qinglong/local-execution/scheduler',
          ].includes(specifier))
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_EXECUTION_ENTRYPOINT_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@qinglong/local-cutover' ||
        specifier.startsWith('@qinglong/local-cutover/')
      ) {
        findings.push({
          code: 'DELETED_LOCAL_CUTOVER_PACKAGE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@qinglong/local-secret-admin' ||
        specifier.startsWith('@qinglong/local-secret-admin/')
      ) {
        findings.push({
          code: 'DELETED_LOCAL_SECRET_ADMIN_PACKAGE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        !(
          packagePath === 'packages/ql3-local-owner-cli' &&
          path.relative(packageDirectory, filePath) ===
            'src/security-management/secretCommand.ts'
        ) &&
        specifier === '@qinglong/local-admin/secret-administration'
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_SECRET_ADMIN_AUTHORITY_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        !(
          packagePath === 'packages/ql3-local-owner-cli' &&
          path.relative(packageDirectory, filePath) ===
            'src/security-management/projectPolicyCommand.ts'
        ) &&
        (specifier === '@qinglong/local-admin/project-policy-administration' ||
          specifier === '@qinglong/local-sqlite/project-policy-administration')
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_PROJECT_POLICY_ADMINISTRATION_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@qinglong/local-owner-bootstrap' ||
        specifier.startsWith('@qinglong/local-owner-bootstrap/') ||
        specifier === '@qinglong/local-owner-credential-recovery' ||
        specifier.startsWith('@qinglong/local-owner-credential-recovery/') ||
        specifier === '@qinglong/local-owner-ceremony' ||
        specifier.startsWith('@qinglong/local-owner-ceremony/')
      ) {
        findings.push({
          code: 'DEPRECATED_LOCAL_OWNER_CEREMONY_PACKAGE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@qinglong/local-owner-gc-cli' ||
        specifier.startsWith('@qinglong/local-owner-gc-cli/')
      ) {
        findings.push({
          code: 'DEPRECATED_LOCAL_OWNER_GC_CLI_PACKAGE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@qinglong/local-owner-keyring' ||
        specifier.startsWith('@qinglong/local-owner-keyring/')
      ) {
        findings.push({
          code: 'DELETED_LOCAL_OWNER_KEYRING_PACKAGE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath !== 'packages/ql3-local-owner-maintenance' &&
        (specifier === '@qinglong/local-owner-maintenance' ||
          specifier.startsWith('@qinglong/local-owner-maintenance/'))
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_OWNER_MAINTENANCE_AUTHORITY_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-maintenance' &&
        ![
          'src/prompt-output-maintenance/promptOutputGc.ts',
          'src/prompt-output-maintenance/promptOutputKeyRetirement.ts',
        ].includes(path.relative(packageDirectory, filePath)) &&
        (specifier === '@qinglong/ai' || specifier.startsWith('@qinglong/ai/'))
      ) {
        findings.push({
          code: 'FORBIDDEN_PROMPT_OUTPUT_GC_AI_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-maintenance' &&
        ![
          'src/security-maintenance/acknowledgementGc.ts',
          'src/security-maintenance/pepperGc.ts',
        ].includes(path.relative(packageDirectory, filePath)) &&
        (specifier === '@qinglong/local-owner-console' ||
          specifier.startsWith('@qinglong/local-owner-console/'))
      ) {
        findings.push({
          code: 'FORBIDDEN_PEPPER_GC_OWNER_CONSOLE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        (packagePath !== 'packages/ql3-local-owner-maintenance' ||
          path.relative(packageDirectory, filePath) !==
            'src/security-maintenance/pepperGc.ts') &&
        specifier === '@qinglong/local-owner-console/pepper-custody/destructive'
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_OWNER_PEPPER_DESTRUCTIVE_ENTRYPOINT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        (packagePath !== 'packages/ql3-local-owner-maintenance' ||
          path.relative(packageDirectory, filePath) !==
            'src/security-maintenance/pepperGc.ts') &&
        specifier === '@qinglong/local-sqlite/pepper-gc'
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_SQLITE_PEPPER_GC_ENTRYPOINT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        (packagePath !== 'packages/ql3-local-owner-maintenance' ||
          path.relative(packageDirectory, filePath) !==
            'src/security-maintenance/acknowledgementGc.ts') &&
        specifier === '@qinglong/local-sqlite/acknowledgement-gc'
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_SQLITE_ACKNOWLEDGEMENT_GC_ENTRYPOINT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        [
          '@qinglong/local-admin',
          '@qinglong/local-identity',
          '@qinglong/local-owner-console',
          '@qinglong/local-sqlite',
        ].some(
          (packageName) =>
            specifier === packageName ||
            specifier.startsWith(`${packageName}/`),
        ) &&
        !(
          [
            'src/run-management/runRetryCommand.ts',
            'src/run-management/runStopCommand.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
          [
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
            '@qinglong/local-sqlite/run-management',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/lifecycle/adoption.ts' &&
          [
            '@qinglong/local-admin',
            '@qinglong/local-admin/decision-issuer',
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/bootstrap',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/lifecycle/sqlite-adoption/command.ts' &&
          specifier === '@qinglong/local-admin'
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/lifecycle/data-directory-adoption/staging.ts' &&
          specifier === '@qinglong/local-admin/runtime'
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageCommand.ts' &&
          [
            '@qinglong/local-admin/package-lifecycle',
            '@qinglong/local-admin/package-management',
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/plugin-package-install',
            '@qinglong/local-sqlite/package-management',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageCatalogCommand.ts' &&
          [
            '@qinglong/local-admin/package-recovery-catalog',
            '@qinglong/local-admin/package-publisher-trust',
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
            '@qinglong/local-sqlite/plugin-package-install',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackagePublisherTrustCommand.ts' &&
          [
            '@qinglong/local-admin/package-publisher-trust',
            '@qinglong/local-admin/package-recovery-catalog',
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/ai-management/modelPriceCatalogCommand.ts' &&
          [
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/ai-management/modelProviderCredentialCommand.ts' &&
          [
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
            '@qinglong/local-sqlite/project-policy',
          ].includes(specifier)
        ) &&
        ![
          {
            file: 'src/plugin-package/plugin-package-prompt-command/contractAuthority.ts',
            specifiers: [
              '@qinglong/local-owner-console/authenticated-command',
              '@qinglong/local-sqlite/optional-feature-runtime',
            ],
          },
          {
            file: 'src/plugin-package/plugin-package-prompt-command/authorizationAuthority.ts',
            specifiers: ['@qinglong/local-sqlite/optional-feature-runtime'],
          },
          {
            file: 'src/plugin-package/plugin-package-prompt-command/supportAuthority.ts',
            specifiers: ['@qinglong/local-sqlite/optional-feature-runtime'],
          },
          {
            file: 'src/plugin-package/plugin-package-prompt-command/runnerAuthority.ts',
            specifiers: [
              '@qinglong/local-owner-console/authenticated-command',
              '@qinglong/local-sqlite/optional-feature-runtime',
            ],
          },
        ].some(
          ({ file, specifiers }) =>
            path.relative(packageDirectory, filePath) === file &&
            specifiers.includes(specifier),
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/approval-management/approvalCommand.ts' &&
          [
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
            '@qinglong/local-sqlite/approval-decision-database',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/ai-management/aiFeatureCommand.ts' &&
          [
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/security-management/secretCommand.ts' &&
          [
            '@qinglong/local-admin/secret-administration',
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
            '@qinglong/local-sqlite/secret-administration',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/security-management/projectPolicyCommand.ts' &&
          [
            '@qinglong/local-admin/project-policy-administration',
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
            '@qinglong/local-sqlite/project-policy-administration',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/security-management/securityAuditQueryCommand.ts' &&
          [
            '@qinglong/local-admin/security-audit-query',
            '@qinglong/local-admin/security-audit-retention',
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
            '@qinglong/local-sqlite/security-audit-query',
          ].includes(specifier)
        ) &&
        !(
          [
            'src/security-management/identity-credential-command/contractAuthority.ts',
            'src/security-management/identity-credential-command/executionAuthority.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
          [
            '@qinglong/local-admin/identity-credential-administration',
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-owner-console/credential-administration-delivery',
            '@qinglong/local-owner-console/pepper-custody',
            '@qinglong/local-sqlite/authenticated-management',
            '@qinglong/local-sqlite/identity-credential-administration',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/automation-management/taskDefinitionCommand.ts' &&
          [
            '@qinglong/local-admin/task-definition-administration',
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
            '@qinglong/local-sqlite/task-definition-administration',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageCommand.ts' &&
          specifier === '@qinglong/local-admin/package-secret-binding'
        ) &&
        ![
          {
            file: 'src/plugin-package/plugin-package-workflow-command/contractAuthority.ts',
            specifiers: [
              '@qinglong/local-admin/plugin-package-workflow-administration',
              '@qinglong/local-owner-console/authenticated-command',
              '@qinglong/local-sqlite/plugin-package-workflow-administration',
            ],
          },
          {
            file: 'src/plugin-package/plugin-package-workflow-command/supportAuthority.ts',
            specifiers: [
              '@qinglong/local-admin/plugin-package-workflow-administration',
              '@qinglong/local-owner-console/authenticated-command',
              '@qinglong/local-sqlite/authenticated-management',
              '@qinglong/local-sqlite/plugin-package-workflow-administration',
            ],
          },
          {
            file: 'src/plugin-package/plugin-package-workflow-command/runnerAuthority.ts',
            specifiers: [
              '@qinglong/local-admin/plugin-package-workflow-administration',
              '@qinglong/local-owner-console/authenticated-command',
              '@qinglong/local-sqlite/plugin-package-workflow-administration',
            ],
          },
        ].some(
          ({ file, specifiers }) =>
            path.relative(packageDirectory, filePath) === file &&
            specifiers.includes(specifier),
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/automation-management/triggerCommand.ts' &&
          [
            '@qinglong/local-admin/trigger-administration',
            '@qinglong/local-owner-console/authenticated-command',
            '@qinglong/local-sqlite/authenticated-management',
            '@qinglong/local-sqlite/trigger-administration',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/application-command/localOwnerCommand.ts' &&
          specifier === '@qinglong/local-owner-console'
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/lifecycle/localSetup.ts' &&
          [
            '@qinglong/local-owner-console/pepper-custody',
            '@qinglong/local-sqlite/bootstrap',
            '@qinglong/local-sqlite/migration',
          ].includes(specifier)
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/deployment/compose/composePreflight.ts' &&
          specifier === '@qinglong/local-sqlite/readiness-inspection'
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/lifecycle/localReadiness.ts' &&
          specifier === '@qinglong/local-sqlite/readiness-inspection'
        ) &&
        !(
          [
            'src/deployment/compose/composeApply.ts',
            'src/deployment/compose/composeEvidenceCollection.ts',
            'src/deployment/compose/composeRestore.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
          specifier === '@qinglong/local-sqlite/rollout-safety'
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@qinglong/local-identity' ||
        specifier.startsWith('@qinglong/local-identity/')
      ) {
        findings.push({
          code: 'DELETED_LOCAL_IDENTITY_PACKAGE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@qinglong/local-profile' ||
        specifier.startsWith('@qinglong/local-profile/')
      ) {
        findings.push({
          code: 'DELETED_LOCAL_PROFILE_PACKAGE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@qinglong/local-adopted-profile' ||
        specifier.startsWith('@qinglong/local-adopted-profile/')
      ) {
        findings.push({
          code: 'DELETED_LOCAL_ADOPTED_PROFILE_PACKAGE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        specifier === '@qinglong/local-owner-console/identity-authentication' &&
        !(
          packagePath === 'packages/ql3-local-api' &&
          path.relative(packageDirectory, filePath) ===
            'src/authentication/credentialAuthenticator.ts'
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_IDENTITY_AUTHORITY_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-sqlite' &&
        (specifier === 'drizzle-orm' || specifier.startsWith('drizzle-orm/')) &&
        path.relative(packageDirectory, filePath) !== 'src/storage/schema.ts'
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_SQLITE_RUNTIME_DRIZZLE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-admin' &&
        (specifier === '@qinglong/local-command-file' ||
          specifier.startsWith('@qinglong/local-command-file/') ||
          specifier === '@qinglong/local-owner-console' ||
          specifier.startsWith('@qinglong/local-owner-console/'))
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_PACKAGE_COMMAND_AUTHORITY_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-admin' &&
        (specifier === '@qinglong/local-sqlite' ||
          specifier.startsWith('@qinglong/local-sqlite/')) &&
        specifier !== '@qinglong/local-sqlite/migration' &&
        specifier !== '@qinglong/local-sqlite/runtime' &&
        !(
          (path.relative(packageDirectory, filePath) ===
            'src/legacy-adoption/legacyCrontabPublisher.ts' &&
            specifier === '@qinglong/local-sqlite/adoption') ||
          (path.relative(packageDirectory, filePath) ===
            'src/adopted-profile/localAdoptedProfile.ts' &&
            specifier === '@qinglong/local-sqlite/profile') ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageApprovedAction.ts' &&
            [
              '@qinglong/local-sqlite/approved-action-execution',
              '@qinglong/local-sqlite/operation-authority',
              '@qinglong/local-sqlite/plugin-package-install',
              '@qinglong/local-sqlite/plugin-package-proposal',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageManagement.ts' &&
            [
              '@qinglong/local-sqlite/approved-action',
              '@qinglong/local-sqlite/operation-authority',
              '@qinglong/local-sqlite/plugin-package-proposal',
              '@qinglong/local-sqlite/project-policy',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageLifecycle.ts' &&
            [
              '@qinglong/local-sqlite/approved-action',
              '@qinglong/local-sqlite/operation-authority',
              '@qinglong/local-sqlite/plugin-package-lifecycle',
              '@qinglong/local-sqlite/project-policy',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageSecretBinding.ts' &&
            specifier ===
              '@qinglong/local-sqlite/plugin-package-secret-binding-administration')
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_ADMIN_SQLITE_ENTRYPOINT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-admin' &&
        (specifier === '@qinglong/runtime-core' ||
          specifier.startsWith('@qinglong/runtime-core/')) &&
        !(
          (path.relative(packageDirectory, filePath) ===
            'src/legacy-adoption/legacyCrontabAdoption.ts' &&
            [
              '@qinglong/runtime-core/task-spec-semantic',
              '@qinglong/runtime-core/task-definition',
              '@qinglong/runtime-core/trigger',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/legacy-adoption/legacyCrontabDecisionReceipt.ts' &&
            specifier === '@qinglong/runtime-core/security') ||
          (path.relative(packageDirectory, filePath) ===
            'src/legacy-adoption/legacyCrontabDecisionAuthorizationFile.ts' &&
            specifier === '@qinglong/runtime-core/local-secret') ||
          (path.relative(packageDirectory, filePath) ===
            'src/legacy-adoption/legacyCrontabDecisionIssuerKeyring.ts' &&
            specifier === '@qinglong/runtime-core/local-secret') ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageStaging.ts' &&
            [
              '@qinglong/runtime-core/plugin-package',
              '@qinglong/runtime-core/plugin-package-bundle',
              '@qinglong/runtime-core/plugin-package-install',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageRecoveryCatalog.ts' &&
            [
              '@qinglong/runtime-core/plugin-package',
              '@qinglong/runtime-core/plugin-package-bundle',
              '@qinglong/runtime-core/plugin-package-install',
            ].includes(specifier)) ||
          ([
            'src/plugin-package/pluginPackagePublisherTrust.ts',
            'src/plugin-package/publisher-trust/codec.ts',
            'src/plugin-package/publisher-trust/contracts.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
            specifier === '@qinglong/runtime-core/plugin-package-bundle') ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageActivation.ts' &&
            [
              '@qinglong/runtime-core/plugin-package-activation',
              '@qinglong/runtime-core/plugin-package-install',
              '@qinglong/runtime-core/plugin-package-resource-generation',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageResourceMaterialization.ts' &&
            [
              '@qinglong/runtime-core/plugin-package-bundle',
              '@qinglong/runtime-core/plugin-package-resource-generation',
              '@qinglong/runtime-core/plugin-package-resource-materialization',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageInstallation.ts' &&
            [
              '@qinglong/runtime-core/plugin-package',
              '@qinglong/runtime-core/plugin-package-activation',
              '@qinglong/runtime-core/plugin-package-bundle',
              '@qinglong/runtime-core/plugin-package-install',
              '@qinglong/runtime-core/plugin-package-installation',
              '@qinglong/runtime-core/plugin-package-admission',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageApprovedAction.ts' &&
            [
              '@qinglong/runtime-core/approved-action-dispatcher',
              '@qinglong/runtime-core/plugin-package-approved-action',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageManagement.ts' &&
            [
              '@qinglong/runtime-core/approved-action-dispatcher',
              '@qinglong/runtime-core/plugin-package-management',
              '@qinglong/runtime-core/project-policy',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/pluginPackageLifecycle.ts' &&
            [
              '@qinglong/runtime-core/approved-action',
              '@qinglong/runtime-core/plugin-package-lifecycle',
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/legacy-adoption/legacyCrontabPublisher.ts' &&
            [
              '@qinglong/runtime-core/local-secret',
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/security-administration/projectPolicyAdministration.ts' &&
            [
              '@qinglong/runtime-core/local-project-policy-administration',
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/security-administration/securityAuditQuery.ts' &&
            [
              '@qinglong/runtime-core/local-security-audit-query',
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
              '@qinglong/runtime-core/security-audit-query',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/security-administration/securityAuditRetention.ts' &&
            [
              '@qinglong/runtime-core/local-security-audit-retention',
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/security-administration/secretAdministration.ts' &&
            [
              '@qinglong/runtime-core/local-secret',
              '@qinglong/runtime-core/local-secret-administration',
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/security-administration/identityCredentialAdministration.ts' &&
            [
              '@qinglong/runtime-core/api-credential-administration',
              '@qinglong/runtime-core/api-credential',
              '@qinglong/runtime-core/identity-administration',
              '@qinglong/runtime-core/local-identity-credential-administration',
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/automation-administration/taskDefinitionAdministration.ts' &&
            [
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
              '@qinglong/runtime-core/task-definition',
              '@qinglong/runtime-core/task-definition-administration',
            ].includes(specifier)) ||
          ([
            'src/plugin-package/pluginPackageWorkflowAdministration.ts',
            'src/plugin-package/workflow/pluginPackageWorkflowAdministration.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
            [
              '@qinglong/runtime-core/plugin-package-automation-publication',
              '@qinglong/runtime-core/plugin-package-resource-materialization',
              '@qinglong/runtime-core/plugin-package-workflow-administration',
              '@qinglong/runtime-core/plugin-package-workflow-execution-plan',
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
              '@qinglong/runtime-core/task-spec-semantic',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/automation-administration/triggerAdministration.ts' &&
            [
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
              '@qinglong/runtime-core/trigger',
              '@qinglong/runtime-core/trigger-administration',
            ].includes(specifier))
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-cluster-control' &&
        (specifier === '@qinglong/cluster-postgres' ||
          specifier.startsWith('@qinglong/cluster-postgres/')) &&
        !(
          specifier === '@qinglong/cluster-postgres/runtime' ||
          (path.relative(packageDirectory, filePath) ===
            'src/application-runtime/aiProductionApplication.ts' &&
            specifier === '@qinglong/cluster-postgres/project-policy') ||
          (path.relative(packageDirectory, filePath) ===
            'src/application-runtime/clusterControlRuntime.ts' &&
            [
              '@qinglong/cluster-postgres/plugin-package-automation-publication',
              '@qinglong/cluster-postgres/plugin-package-materialized-revision',
              '@qinglong/cluster-postgres/plugin-package-workflow-administration',
              '@qinglong/cluster-postgres/plugin-package-workflow-frontier',
              '@qinglong/cluster-postgres/plugin-package-workflow-task-attempt-admission',
              '@qinglong/cluster-postgres/task-start',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/worker-ingress/productionWorkerIngress.ts' &&
            specifier === '@qinglong/cluster-postgres/worker-ingress')
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_CLUSTER_CONTROL_POSTGRES_ENTRYPOINT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-cluster-admin' &&
        (specifier === '@qinglong/cluster-postgres' ||
          specifier.startsWith('@qinglong/cluster-postgres/')) &&
        !(
          [
            '@qinglong/cluster-postgres/admin',
            '@qinglong/cluster-postgres/plugin-package-install',
          ].includes(specifier) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/executor/pluginPackageApprovedAction.ts' &&
            [
              '@qinglong/cluster-postgres/approved-action-execution',
              '@qinglong/cluster-postgres/package-executor',
              '@qinglong/cluster-postgres/plugin-package-proposal',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/management/pluginPackageManagement.ts' &&
            [
              '@qinglong/cluster-postgres/approved-action',
              '@qinglong/cluster-postgres/package-manager',
              '@qinglong/cluster-postgres/plugin-package-proposal',
              '@qinglong/cluster-postgres/project-policy',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/lifecycle/pluginPackageLifecycleManagement.ts' &&
            [
              '@qinglong/cluster-postgres/approved-action',
              '@qinglong/cluster-postgres/package-manager',
              '@qinglong/cluster-postgres/project-policy',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/lifecycle/pluginPackageLifecycleExecutor.ts' &&
            [
              '@qinglong/cluster-postgres/approved-action',
              '@qinglong/cluster-postgres/package-executor',
              '@qinglong/cluster-postgres/project-policy',
            ].includes(specifier)) ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/publisher/pluginPackagePublisherTrustManagement.ts' &&
            [
              '@qinglong/cluster-postgres/approved-action',
              '@qinglong/cluster-postgres/package-manager',
              '@qinglong/cluster-postgres/project-policy',
            ].includes(specifier)) ||
          ([
            'src/plugin-package/publisher/pluginPackagePublisherRevocationApprovalConsumer.ts',
            'src/plugin-package/publisher/pluginPackagePublisherTrustTransitionApprovalConsumer.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
            [
              '@qinglong/cluster-postgres/approved-action',
              '@qinglong/cluster-postgres/package-executor',
              '@qinglong/cluster-postgres/project-policy',
            ].includes(specifier)) ||
          ([
            'src/plugin-package/executor/pluginPackageExecutorProcess.ts',
            'src/plugin-package/lifecycle/pluginPackageQuarantine.ts',
            'src/plugin-package/recovery/pluginPackageRecovery.ts',
            'src/plugin-package/recovery/pluginPackageRecoveryProcess.ts',
            'src/plugin-package/publisher/pluginPackagePublisherProvenanceRecovery.ts',
            'src/plugin-package/publisher/pluginPackagePublisherRevocation.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
            specifier === '@qinglong/cluster-postgres/package-executor') ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/management/pluginPackageManagementProcess.ts' &&
            specifier === '@qinglong/cluster-postgres/package-manager') ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/secret-binding/pluginPackageSecretBindingManagement.ts' &&
            specifier === '@qinglong/cluster-postgres/package-manager') ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/secret-binding/pluginPackageSecretBindingApprovalConsumer.ts' &&
            specifier === '@qinglong/cluster-postgres/package-executor') ||
          (path.relative(packageDirectory, filePath) ===
            'src/plugin-package/secret-binding/pluginPackageSecretBindingTransitionManagement.ts' &&
            specifier === '@qinglong/cluster-postgres/package-manager') ||
          ([
            'src/plugin-package/secret-binding/pluginPackageSecretBindingTransitionApprovalConsumer.ts',
            'src/plugin-package/secret-binding/pluginPackageSecretBindingTransitionApprovedAction.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
            specifier === '@qinglong/cluster-postgres/package-executor') ||
          ([
            'src/worker-credential/management-server/workerCredentialManagement.ts',
            'src/worker-credential/management-server/workerCredentialManagementProcess.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
            specifier ===
              '@qinglong/cluster-postgres/worker-credential-manager') ||
          ([
            'src/worker-credential/workerCredentialManagementExecutor.ts',
            'src/worker-credential/workerCredentialExecutorProcess.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
            specifier ===
              '@qinglong/cluster-postgres/worker-credential-executor') ||
          (path.relative(packageDirectory, filePath) ===
            'src/automation-management/automationManagementProcess.ts' &&
            specifier === '@qinglong/cluster-postgres/automation-manager') ||
          (path.relative(packageDirectory, filePath) ===
            'src/model-provider-credential/modelProviderCredentialManagementProcess.ts' &&
            specifier === '@qinglong/cluster-postgres/ai-credential-manager') ||
          (path.relative(packageDirectory, filePath) ===
            'src/model-provider-credential/modelProviderCredentialTestExecutorProcess.ts' &&
            specifier === '@qinglong/cluster-postgres/ai-credential-tester') ||
          (path.relative(packageDirectory, filePath) ===
            'src/modelInvocationMigrationCli.ts' &&
            specifier === '@qinglong/cluster-postgres/migration-process') ||
          (path.relative(packageDirectory, filePath) ===
            'src/approval-management/approvalDecisionManagement.ts' &&
            [
              '@qinglong/cluster-postgres/approved-action',
              '@qinglong/cluster-postgres/project-policy',
            ].includes(specifier)) ||
          ([
            'src/approval-management/approvalManagement.ts',
            'src/approval-management/approvalManagementProcess.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
            specifier === '@qinglong/cluster-postgres/approval-manager') ||
          ([
            'src/run-management/runManagement.ts',
            'src/run-management/runManagementProcess.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
            specifier === '@qinglong/cluster-postgres/run-manager') ||
          ([
            'src/prompt-output/retention/promptOutputGcCli.ts',
            'src/prompt-output/retention/promptOutputGcProcess.ts',
            'src/prompt-output/key-management/promptOutputKeyRetirementCli.ts',
            'src/prompt-output/key-management/promptOutputKeyRetirementProcess.ts',
            'src/prompt-output/key-management/promptOutputKeyRotationProcess.ts',
            'src/prompt-output/key-management/promptOutputPostgresMaintenanceConnection.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
            specifier === '@qinglong/cluster-postgres/ai-maintenance')
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-application' &&
        (specifier === '@qinglong/local-admin' ||
          specifier.startsWith('@qinglong/local-admin/')) &&
        ![
          '@qinglong/local-admin/package-activation',
          '@qinglong/local-admin/package-resource-materialization',
        ].includes(specifier) &&
        !(
          [
            'src/application-runtime/contract.ts',
            'src/application-runtime/storageActivation.ts',
            'src/production-process/processApplication.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
          specifier === '@qinglong/local-admin/adopted-profile'
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/production-process/pluginPackageRecoveryCatalog.ts' &&
          [
            '@qinglong/local-admin/package-installation',
            '@qinglong/local-admin/package-publisher-trust',
          ].includes(specifier)
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_APPLICATION_ADMIN_ENTRYPOINT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-application' &&
        (specifier === '@qinglong/runtime-core' ||
          specifier.startsWith('@qinglong/runtime-core/')) &&
        ![
          '@qinglong/runtime-core/plugin-package-install',
          '@qinglong/runtime-core/plugin-package-installation',
          '@qinglong/runtime-core/plugin-package-recovery',
          '@qinglong/runtime-core/plugin-package-task-publication',
          '@qinglong/runtime-core/project-tool-definition-snapshot',
          '@qinglong/runtime-core/run-attempt-log-read',
          '@qinglong/runtime-core/run-attempt-log-retention',
          '@qinglong/runtime-core/task-spec-semantic',
        ].includes(specifier) &&
        !(
          [
            'src/application-runtime/contract.ts',
            'src/application-runtime/pluginPackageStartup.ts',
            'src/application-runtime/startupErrors.ts',
          ].includes(path.relative(packageDirectory, filePath)) &&
          specifier ===
            '@qinglong/runtime-core/plugin-package-automation-publication'
        ) &&
        !(
          path.relative(packageDirectory, filePath) ===
            'src/production-process/pluginPackageRecoveryCatalog.ts' &&
          [
            '@qinglong/runtime-core/plugin-package',
            '@qinglong/runtime-core/plugin-package-bundle',
          ].includes(specifier)
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_LOCAL_APPLICATION_RUNTIME_CORE_ENTRYPOINT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-application' &&
        (specifier === '@qinglong/ai' || specifier.startsWith('@qinglong/ai/'))
      ) {
        if (
          path.relative(packageDirectory, filePath) ===
            'src/application-runtime/aiFeatureApplication.ts' &&
          [
            '@qinglong/ai/local-feature-activation',
            '@qinglong/ai/local-model-invocation-storage',
            '@qinglong/ai/local-plugin-package-prompt-admission-storage',
            '@qinglong/ai/local-plugin-package-prompt-execution-output-reference-storage',
            '@qinglong/ai/local-plugin-package-prompt-output-artifact-storage',
            '@qinglong/ai/local-price-catalog-storage',
            '@qinglong/ai/plugin-package-prompt-output-artifact',
            '@qinglong/ai/plugin-package-prompt-output-completion',
            '@qinglong/ai/plugin-package-prompt-execution-output-read',
            '@qinglong/ai/plugin-package-prompt-output-read',
            '@qinglong/ai/plugin-package-prompt-executor',
            '@qinglong/ai/profile',
          ].includes(specifier)
        ) {
          continue;
        }
        findings.push({
          code: 'FORBIDDEN_LOCAL_APPLICATION_AI_ENTRYPOINT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-application' &&
        path.relative(packageDirectory, filePath) ===
          'src/application-runtime/aiFeatureApplication.ts' &&
        specifier === '@qinglong/local-sqlite/optional-feature-runtime'
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/lifecycle/localSetup.ts' &&
        [
          '@qinglong/local-owner-console/pepper-custody',
          '@qinglong/local-secret',
          '@qinglong/local-sqlite/bootstrap',
          '@qinglong/local-sqlite/migration',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-application' &&
        [
          'src/application-runtime/contract.ts',
          'src/application-runtime/storageActivation.ts',
          'src/production-process/processApplication.ts',
        ].includes(path.relative(packageDirectory, filePath)) &&
        specifier === '@qinglong/local-sqlite/profile'
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/run-management/runRetryCommand.ts' &&
        [
          '@qinglong/runtime-core/project-policy',
          '@qinglong/runtime-core/run-manual-retry',
          '@qinglong/runtime-core/security-audit',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/run-management/runStopCommand.ts' &&
        [
          '@qinglong/runtime-core/project-policy',
          '@qinglong/runtime-core/run-cancellation',
          '@qinglong/runtime-core/security-audit',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/approval-management/approvalCommand.ts' &&
        [
          '@qinglong/runtime-core/approval-decision',
          '@qinglong/runtime-core/approval-inspection',
          '@qinglong/runtime-core/approved-action',
          '@qinglong/runtime-core/approval-discovery',
          '@qinglong/runtime-core/project-policy',
          '@qinglong/runtime-core/security-audit',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/plugin-package/pluginPackageCommand.ts' &&
        [
          '@qinglong/runtime-core/approved-action',
          '@qinglong/runtime-core/approved-action-dispatcher',
          '@qinglong/runtime-core/plugin-package-install',
          '@qinglong/runtime-core/plugin-package-lifecycle',
          '@qinglong/runtime-core/plugin-package-proposal',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        [
          {
            file: 'src/plugin-package/plugin-package-prompt-command/codecAuthority.ts',
            specifiers: ['@qinglong/local-command-file'],
          },
          {
            file: 'src/plugin-package/plugin-package-prompt-command/contractAuthority.ts',
            specifiers: [
              '@qinglong/local-owner-console/authenticated-command',
              '@qinglong/local-sqlite/optional-feature-runtime',
            ],
          },
          {
            file: 'src/plugin-package/plugin-package-prompt-command/authorizationAuthority.ts',
            specifiers: [
              '@qinglong/local-sqlite/optional-feature-runtime',
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security',
              '@qinglong/runtime-core/security-audit',
            ],
          },
          {
            file: 'src/plugin-package/plugin-package-prompt-command/supportAuthority.ts',
            specifiers: [
              '@qinglong/local-secret',
              '@qinglong/local-sqlite/optional-feature-runtime',
            ],
          },
          {
            file: 'src/plugin-package/plugin-package-prompt-command/runnerAuthority.ts',
            specifiers: [
              '@qinglong/local-owner-console/authenticated-command',
              '@qinglong/local-sqlite/optional-feature-runtime',
              '@qinglong/runtime-core/project-policy',
              '@qinglong/runtime-core/security-audit',
            ],
          },
        ].some(
          ({ file, specifiers }) =>
            path.relative(packageDirectory, filePath) === file &&
            specifiers.includes(specifier),
        )
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/ai-management/modelProviderCredentialCommand.ts' &&
        [
          '@qinglong/ai/local-feature-activation',
          '@qinglong/ai/local-model-provider-credential-storage',
          '@qinglong/ai/model-provider-credential-administration',
          '@qinglong/ai/model-provider-credential-catalog',
          '@qinglong/ai/provider-credential',
          '@qinglong/local-command-file',
          '@qinglong/local-owner-console/authenticated-command',
          '@qinglong/local-sqlite/authenticated-management',
          '@qinglong/local-sqlite/project-policy',
          '@qinglong/runtime-core/project-policy',
          '@qinglong/runtime-core/security',
          '@qinglong/runtime-core/security-audit',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/automation-management/triggerCommand.ts' &&
        [
          '@qinglong/local-admin/trigger-administration',
          '@qinglong/local-command-file',
          '@qinglong/local-owner-console/authenticated-command',
          '@qinglong/local-sqlite/authenticated-management',
          '@qinglong/local-sqlite/trigger-administration',
          '@qinglong/runtime-core/security-audit',
          '@qinglong/runtime-core/trigger',
          '@qinglong/runtime-core/trigger-administration',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/security-management/identity-credential-command/contractAuthority.ts' &&
        [
          '@qinglong/local-admin/identity-credential-administration',
          '@qinglong/local-owner-console/authenticated-command',
          '@qinglong/local-owner-console/credential-administration-delivery',
          '@qinglong/local-owner-console/pepper-custody',
          '@qinglong/local-sqlite/identity-credential-administration',
          '@qinglong/runtime-core/security',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/security-management/identity-credential-command/codecAuthority.ts' &&
        [
          '@qinglong/local-command-file',
          '@qinglong/runtime-core/api-credential',
          '@qinglong/runtime-core/project-policy',
          '@qinglong/runtime-core/security',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/security-management/identity-credential-command/executionAuthority.ts' &&
        [
          '@qinglong/local-admin/identity-credential-administration',
          '@qinglong/local-owner-console/authenticated-command',
          '@qinglong/local-owner-console/credential-administration-delivery',
          '@qinglong/local-owner-console/pepper-custody',
          '@qinglong/local-sqlite/authenticated-management',
          '@qinglong/local-sqlite/identity-credential-administration',
          '@qinglong/runtime-core/api-credential-administration',
          '@qinglong/runtime-core/api-credential',
          '@qinglong/runtime-core/api-credential-token',
          '@qinglong/runtime-core/identity-administration',
          '@qinglong/runtime-core/local-identity-credential-administration',
          '@qinglong/runtime-core/security',
          '@qinglong/runtime-core/security-audit',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/security-management/secretCommand.ts' &&
        [
          '@qinglong/local-admin/secret-administration',
          '@qinglong/local-command-file',
          '@qinglong/local-secret',
          '@qinglong/runtime-core/local-secret',
          '@qinglong/runtime-core/local-secret-administration',
          '@qinglong/runtime-core/security-audit',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/security-management/securityAuditQueryCommand.ts' &&
        [
          '@qinglong/local-admin/security-audit-query',
          '@qinglong/local-admin/security-audit-retention',
          '@qinglong/local-command-file',
          '@qinglong/local-owner-console/authenticated-command',
          '@qinglong/local-sqlite/authenticated-management',
          '@qinglong/local-sqlite/security-audit-query',
          '@qinglong/runtime-core/local-security-audit-query',
          '@qinglong/runtime-core/local-security-audit-retention',
          '@qinglong/runtime-core/project-policy',
          '@qinglong/runtime-core/security-audit',
          '@qinglong/runtime-core/security-audit-query',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/security-management/projectPolicyCommand.ts' &&
        [
          '@qinglong/local-admin/project-policy-administration',
          '@qinglong/local-command-file',
          '@qinglong/local-owner-console/authenticated-command',
          '@qinglong/local-sqlite/authenticated-management',
          '@qinglong/local-sqlite/project-policy-administration',
          '@qinglong/runtime-core/local-project-policy-administration',
          '@qinglong/runtime-core/project-policy',
          '@qinglong/runtime-core/security',
          '@qinglong/runtime-core/security-audit',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/automation-management/taskDefinitionCommand.ts' &&
        [
          '@qinglong/local-admin/task-definition-administration',
          '@qinglong/local-command-file',
          '@qinglong/local-owner-console/authenticated-command',
          '@qinglong/local-sqlite/authenticated-management',
          '@qinglong/local-sqlite/task-definition-administration',
          '@qinglong/runtime-core/security-audit',
          '@qinglong/runtime-core/task-definition',
          '@qinglong/runtime-core/task-definition-administration',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        [
          {
            file: 'src/plugin-package/plugin-package-workflow-command/codecAuthority.ts',
            specifiers: ['@qinglong/local-command-file'],
          },
          {
            file: 'src/plugin-package/plugin-package-workflow-command/contractAuthority.ts',
            specifiers: [
              '@qinglong/local-admin/plugin-package-workflow-administration',
              '@qinglong/local-owner-console/authenticated-command',
              '@qinglong/local-sqlite/plugin-package-workflow-administration',
              '@qinglong/runtime-core/plugin-package-workflow-administration',
            ],
          },
          {
            file: 'src/plugin-package/plugin-package-workflow-command/supportAuthority.ts',
            specifiers: [
              '@qinglong/local-admin/plugin-package-workflow-administration',
              '@qinglong/local-owner-console/authenticated-command',
              '@qinglong/local-sqlite/authenticated-management',
              '@qinglong/local-sqlite/plugin-package-workflow-administration',
              '@qinglong/runtime-core/plugin-package-workflow-administration',
              '@qinglong/runtime-core/plugin-package-workflow-execution-plan',
              '@qinglong/runtime-core/security-audit',
            ],
          },
          {
            file: 'src/plugin-package/plugin-package-workflow-command/runnerAuthority.ts',
            specifiers: [
              '@qinglong/local-admin/plugin-package-workflow-administration',
              '@qinglong/local-owner-console/authenticated-command',
              '@qinglong/local-sqlite/plugin-package-workflow-administration',
            ],
          },
        ].some(
          ({ file, specifiers }) =>
            path.relative(packageDirectory, filePath) === file &&
            specifiers.includes(specifier),
        )
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/plugin-package/pluginPackageCommand.ts' &&
        [
          '@qinglong/local-admin/package-secret-binding',
          '@qinglong/runtime-core/plugin-package-secret-binding-plan',
          '@qinglong/runtime-core/plugin-package-secret-binding-transition-plan',
        ].includes(specifier)
      ) {
        continue;
      }
      if (
        packagePath === 'packages/ql3-local-owner-cli' &&
        path.relative(packageDirectory, filePath) ===
          'src/plugin-package/pluginPackagePublisherTrustCommand.ts' &&
        specifier === '@qinglong/runtime-core/plugin-package-quarantine'
      ) {
        continue;
      }
      if (
        path.isAbsolute(specifier) ||
        forbidden.some(
          (packageName) =>
            specifier === packageName ||
            specifier.startsWith(`${packageName}/`),
        )
      ) {
        findings.push({
          code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
          packagePath,
          file: path.relative(root, filePath),
          specifier,
        });
      }
    }
  }
  return sourceFiles.length;
}

function auditExpectedDependencies(packagePath, manifest, importer, findings) {
  const expectedSections = EXPECTED_PACKAGE_DEPENDENCIES[packagePath];
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const expected = expectedSections[section] ?? {};
    const manifestDependencies = manifest[section] ?? {};
    const lockedDependencies = importer?.[section] ?? {};
    for (const packageName of Object.keys(manifestDependencies)) {
      if (!(packageName in expected)) {
        findings.push({
          code: 'UNEXPECTED_PACKAGE_DEPENDENCY',
          packagePath,
          section,
          packageName,
        });
      }
    }
    if (section === 'peerDependencies') {
      for (const [packageName, version] of Object.entries(expected)) {
        if (manifestDependencies[packageName] !== version) {
          findings.push({
            code: 'PACKAGE_MANIFEST_VERSION_MISMATCH',
            packagePath,
            section,
            packageName,
            expected: version,
            actual: manifestDependencies[packageName] ?? null,
          });
        }
      }
      continue;
    }
    for (const packageName of Object.keys(lockedDependencies)) {
      if (!(packageName in expected)) {
        findings.push({
          code: 'UNEXPECTED_LOCK_IMPORTER_DEPENDENCY',
          packagePath,
          section,
          packageName,
        });
      }
    }
    for (const [packageName, version] of Object.entries(expected)) {
      if (manifestDependencies[packageName] !== version) {
        findings.push({
          code: 'PACKAGE_MANIFEST_VERSION_MISMATCH',
          packagePath,
          section,
          packageName,
          expected: version,
          actual: manifestDependencies[packageName] ?? null,
        });
      }
      if (lockedDependencies[packageName]?.specifier !== version) {
        findings.push({
          code: 'PACKAGE_LOCK_SPECIFIER_MISMATCH',
          packagePath,
          section,
          packageName,
          expected: version,
          actual: lockedDependencies[packageName]?.specifier ?? null,
        });
      }
      const resolved = lockedDependencies[packageName]?.version;
      const expectedResolution = version.startsWith('workspace:')
        ? EXPECTED_WORKSPACE_RESOLUTIONS[`${packagePath}:${packageName}`]
        : version;
      if (
        typeof resolved !== 'string' ||
        (resolved !== expectedResolution &&
          !resolved.startsWith(`${expectedResolution}(`))
      ) {
        findings.push({
          code: 'PACKAGE_LOCK_VERSION_MISMATCH',
          packagePath,
          section,
          packageName,
          expected: expectedResolution,
          actual: resolved ?? null,
        });
      }
    }
  }
}

function auditPackageScripts(packagePath, manifest, findings) {
  const scripts = manifest.scripts ?? {};
  if (scripts.build !== QL3_SELF_BUILD_SCRIPT) {
    findings.push({
      code: 'QL3_PACKAGE_BUILD_NOT_SELF_ONLY',
      packagePath,
      actual: scripts.build ?? null,
    });
  }
  for (const lifecycle of ['prebuild', 'precheck']) {
    if (lifecycle in scripts) {
      findings.push({
        code: 'QL3_PACKAGE_RECURSIVE_LIFECYCLE',
        packagePath,
        lifecycle,
      });
    }
  }
  if (
    scripts.check !==
    `${QL3_PACKAGE_CLOSURE_BUILD_SCRIPT} && tsc -p tsconfig.json --noEmit`
  ) {
    findings.push({
      code: 'QL3_PACKAGE_CHECK_WITHOUT_CLOSURE_BUILD',
      packagePath,
      actual: scripts.check ?? null,
    });
  }
  for (const lifecycle of ['test', 'test:integration', 'schema:check']) {
    if (
      lifecycle in scripts &&
      !scripts[lifecycle].startsWith(
        `${QL3_PACKAGE_CLOSURE_BUILD_SCRIPT} && node --test `,
      )
    ) {
      findings.push({
        code: 'QL3_PACKAGE_TEST_WITHOUT_CLOSURE_BUILD',
        packagePath,
        lifecycle,
        actual: scripts[lifecycle],
      });
    }
  }
  for (const [lifecycle, command] of Object.entries(scripts)) {
    if (command.includes('pnpm --filter')) {
      findings.push({
        code: 'QL3_PACKAGE_HANDWRITTEN_RECURSIVE_BUILD',
        packagePath,
        lifecycle,
      });
    }
  }
}

function auditPackageFiles(packagePath, manifest, findings) {
  const expected = ['dist/**/*.js', 'dist/**/*.d.ts'];
  if (packagePath === 'packages/ql3-cluster-admin') {
    expected.push('assets/copilot-console/*');
  }
  if (packagePath === 'packages/ql3-local-process') expected.push('assets');
  if (packagePath === 'packages/ql3-local-sqlite') expected.push('drizzle');
  if (JSON.stringify(manifest.files) !== JSON.stringify(expected)) {
    findings.push({
      code: 'QL3_PACKAGE_PRODUCTION_FILES_INVALID',
      packagePath,
      expected,
      actual: manifest.files ?? null,
    });
  }
}

function main() {
  const root = path.resolve(__dirname, '..');
  const clusterDirectory = path.join(root, 'packages/ql3-cluster-postgres');
  const localProfileDirectories = [
    path.join(root, 'packages/ql3-local-sqlite'),
    path.join(root, 'packages/ql3-local-admin'),
  ];
  const rootManifest = readJson(path.join(root, 'package.json'));
  const lock = yaml.load(
    fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'),
  );
  const rootImporter = lock.importers?.['.'];
  const findings = [];
  const sourceFilesAudited = {};

  auditRegisteredPackageImporters(root, findings);

  for (const packageName of dependencyNames(rootImporter)) {
    if (FORBIDDEN_ROOT_PACKAGES.includes(packageName)) {
      findings.push({
        code: 'FORBIDDEN_ROOT_IMPORTER_DEPENDENCY',
        packageName,
      });
    }
  }
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const packageName of Object.keys(rootManifest[section] ?? {})) {
      if (FORBIDDEN_ROOT_PACKAGES.includes(packageName)) {
        findings.push({
          code: 'FORBIDDEN_ROOT_MANIFEST_DEPENDENCY',
          packageName,
          section,
        });
      }
    }
  }

  for (const packagePath of Object.keys(EXPECTED_PACKAGE_DEPENDENCIES)) {
    const manifest = readJson(path.join(root, packagePath, 'package.json'));
    auditExpectedDependencies(
      packagePath,
      manifest,
      lock.importers?.[packagePath],
      findings,
    );
    auditPackageScripts(packagePath, manifest, findings);
    auditPackageFiles(packagePath, manifest, findings);
    sourceFilesAudited[packagePath] = auditSourceImports(
      root,
      packagePath,
      findings,
    );
  }

  const packageKeys = Object.keys(lock.packages ?? {});
  if (packageKeys.some((key) => /^\/pg-native(?:@|\/)/.test(key))) {
    findings.push({ code: 'PG_NATIVE_INSTALLED' });
  }
  const drizzleKeys = packageKeys.filter((key) =>
    key.startsWith('/drizzle-orm@0.45.2'),
  );
  if (
    drizzleKeys.length !== 1 ||
    drizzleKeys.some((key) => /(?:better-)?sqlite|sql\.js/.test(key))
  ) {
    findings.push({
      code: 'DRIZZLE_POSTGRES_PEER_ISOLATION_FAILED',
      drizzleKeys,
    });
  }

  for (const packageName of ['pg', 'drizzle-orm']) {
    try {
      require.resolve(packageName, { paths: [clusterDirectory] });
    } catch {
      findings.push({ code: 'CLUSTER_PACKAGE_NOT_INSTALLED', packageName });
    }
  }
  for (const profileDirectory of localProfileDirectories) {
    for (const packageName of [
      'pg',
      'drizzle-orm',
      '@qinglong/cluster-control',
      '@qinglong/cluster-postgres',
    ]) {
      if (
        path.basename(profileDirectory) === 'ql3-local-sqlite' &&
        packageName === 'drizzle-orm'
      ) {
        continue;
      }
      try {
        require.resolve(packageName, { paths: [profileDirectory] });
        findings.push({
          code: 'LOCAL_PROFILE_FORBIDDEN_PACKAGE_RESOLVABLE',
          profileDirectory: path.relative(root, profileDirectory),
          packageName,
        });
      } catch (error) {
        if (error?.code !== 'MODULE_NOT_FOUND') throw error;
      }
    }
  }
  try {
    require.resolve('pg-native', { paths: [clusterDirectory] });
    findings.push({ code: 'PG_NATIVE_RESOLVABLE' });
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  }

  const report = {
    schemaVersion: 1,
    rootImporter: '.',
    packageImporters: Object.keys(EXPECTED_PACKAGE_DEPENDENCIES),
    sourceFilesAudited,
    exactVersions: EXPECTED_PACKAGE_DEPENDENCIES,
    drizzleLockKeys: drizzleKeys,
    findings,
    compatible: findings.length === 0,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = {
  auditPackageFiles,
  auditPackageScripts,
  auditRegisteredPackageImporters,
  auditSourceImports,
  listQingLong3PackageImporters,
  listTypeScriptSourceFiles,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
