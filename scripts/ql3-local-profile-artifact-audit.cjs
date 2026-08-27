#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pruneRuntimeArtifact } = require('./ql3-prune-runtime-artifact.cjs');

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_FILES = 512;
const DEFAULT_MAX_ADOPTED_ARTIFACT_FILES = 576;
const DEFAULT_MAX_APPLICATION_ARTIFACT_FILES = 640;
const DEFAULT_MAX_APPLICATION_AI_ARTIFACT_FILES = 768;
const DEFAULT_MAX_APPLICATION_API_ARTIFACT_FILES = 640;
const DEFAULT_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ADOPTED_ARTIFACT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_APPLICATION_ARTIFACT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_APPLICATION_AI_ARTIFACT_BYTES = 6 * 1024 * 1024;
const DEFAULT_MAX_APPLICATION_API_ARTIFACT_BYTES = 6 * 1024 * 1024;
const MIN_APPLICATION_AI_ARTIFACT_HEADROOM_BYTES = 64 * 1024;
const DEFAULT_MAX_MCP_ARTIFACT_FILES = 1536;
const DEFAULT_MAX_MCP_ARTIFACT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RSS_DELTA_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_MCP_RSS_DELTA_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_APPLICATION_RSS_DELTA_BYTES = 28 * 1024 * 1024;
const PACKAGE_CHAIN = Object.freeze([
  Object.freeze({
    name: '@qinglong/runtime-core',
    directory: 'ql3-runtime-core',
  }),
  Object.freeze({
    name: '@qinglong/local-sqlite',
    directory: 'ql3-local-sqlite',
  }),
]);
const BASE_EXTERNAL_PACKAGE_NAMES = Object.freeze(['semver']);

function fail(message) {
  throw new Error(`QingLong local Profile artifact audit failed: ${message}`);
}

function boundedPositiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    fail(`${label} is invalid`);
  }
  return normalized;
}

function outputDirectoryArgument(value) {
  if (value === undefined) return undefined;
  if (
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 4_096 ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    fail(
      'output directory must be a normalized bounded absolute non-root path',
    );
  }
  if (fs.existsSync(value)) {
    fail('output directory must not already exist');
  }
  const parent = path.dirname(value);
  const stat = fs.lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent
  ) {
    fail('output directory parent must be a canonical real directory');
  }
  return value;
}

function parseArguments(argv) {
  const profile = argv[0];
  if (
    profile !== 'edge' &&
    profile !== 'standalone' &&
    profile !== 'edge-adopted' &&
    profile !== 'standalone-adopted' &&
    profile !== 'edge-application' &&
    profile !== 'standalone-application' &&
    profile !== 'edge-ai' &&
    profile !== 'standalone-ai' &&
    profile !== 'edge-application-ai' &&
    profile !== 'standalone-application-ai' &&
    profile !== 'edge-application-api' &&
    profile !== 'standalone-application-api' &&
    profile !== 'edge-mcp' &&
    profile !== 'standalone-mcp'
  ) {
    fail(
      'Profile must be edge, standalone, an adopted/application variant, an AI/API variant, or an MCP variant',
    );
  }
  const values = {};
  for (const argument of argv.slice(1)) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) {
      fail(`unsupported argument ${argument}`);
    }
    values[match[1]] = match[2];
  }
  const supported = new Set([
    'max-artifact-files',
    'max-artifact-bytes',
    'max-rss-delta-bytes',
    'output-directory',
  ]);
  for (const name of Object.keys(values)) {
    if (!supported.has(name)) fail(`unsupported argument --${name}`);
  }
  return Object.freeze({
    profile,
    runtimeProfile: profile.startsWith('edge') ? 'edge' : 'standalone',
    adopted: profile.includes('-adopted') || profile.includes('-application'),
    application: profile.includes('-application'),
    ai: profile.endsWith('-ai'),
    api: profile.endsWith('-api'),
    mcp: profile.endsWith('-mcp'),
    maxArtifactFiles: boundedPositiveInteger(
      values['max-artifact-files'],
      profile.endsWith('-mcp')
        ? DEFAULT_MAX_MCP_ARTIFACT_FILES
        : profile.endsWith('-api')
        ? DEFAULT_MAX_APPLICATION_API_ARTIFACT_FILES
        : profile.includes('-application') && profile.endsWith('-ai')
        ? DEFAULT_MAX_APPLICATION_AI_ARTIFACT_FILES
        : profile.endsWith('-application') || profile.endsWith('-ai')
        ? DEFAULT_MAX_APPLICATION_ARTIFACT_FILES
        : profile.includes('-adopted')
        ? DEFAULT_MAX_ADOPTED_ARTIFACT_FILES
        : DEFAULT_MAX_ARTIFACT_FILES,
      'artifact file budget',
    ),
    maxArtifactBytes: boundedPositiveInteger(
      values['max-artifact-bytes'],
      profile.endsWith('-mcp')
        ? DEFAULT_MAX_MCP_ARTIFACT_BYTES
        : profile.endsWith('-api')
        ? DEFAULT_MAX_APPLICATION_API_ARTIFACT_BYTES
        : profile.includes('-application') && profile.endsWith('-ai')
        ? DEFAULT_MAX_APPLICATION_AI_ARTIFACT_BYTES
        : profile.endsWith('-application') || profile.endsWith('-ai')
        ? DEFAULT_MAX_APPLICATION_ARTIFACT_BYTES
        : profile.includes('-adopted')
        ? DEFAULT_MAX_ADOPTED_ARTIFACT_BYTES
        : DEFAULT_MAX_ARTIFACT_BYTES,
      'artifact byte budget',
    ),
    maxRssDeltaBytes: boundedPositiveInteger(
      values['max-rss-delta-bytes'],
      profile.endsWith('-mcp')
        ? DEFAULT_MAX_MCP_RSS_DELTA_BYTES
        : profile.includes('-application')
        ? DEFAULT_MAX_APPLICATION_RSS_DELTA_BYTES
        : DEFAULT_MAX_RSS_DELTA_BYTES,
      'RSS delta budget',
    ),
    minimumArtifactHeadroomBytes:
      profile.includes('-application') && profile.endsWith('-ai')
        ? MIN_APPLICATION_AI_ARTIFACT_HEADROOM_BYTES
        : 0,
    outputDirectory: outputDirectoryArgument(values['output-directory']),
  });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 4096);
    fail(`${command} ${args.join(' ')} exited ${result.status}: ${detail}`);
  }
  return result.stdout.trim();
}

function directoryUsage(directory, maxFiles) {
  let bytes = 0;
  let files = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) fail('artifact contains a symbolic link');
      if (stat.isDirectory()) {
        pending.push(entryPath);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
      } else {
        fail('artifact contains an unsupported filesystem entry');
      }
      if (files > maxFiles) {
        fail(`artifact uses more than ${maxFiles} files`);
      }
    }
  }
  return { bytes, files };
}

function installedPackages(nodeModulesDirectory) {
  const packages = [];
  for (const entry of fs.readdirSync(nodeModulesDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!entry.name.startsWith('@')) {
      packages.push(entry.name);
      continue;
    }
    for (const scoped of fs.readdirSync(
      path.join(nodeModulesDirectory, entry.name),
      { withFileTypes: true },
    )) {
      if (scoped.isDirectory()) packages.push(`${entry.name}/${scoped.name}`);
    }
  }
  return packages.sort();
}

function auditImportClosure(
  artifactDirectory,
  packageNames,
  { allowSemver = false } = {},
) {
  const script = `
    const before = process.memoryUsage().rss;
    for (const packageName of ${JSON.stringify(packageNames)}) {
      require(packageName);
    }
    const after = process.memoryUsage().rss;
    process.stdout.write(JSON.stringify({
      before,
      after,
      loaded: Object.keys(require.cache),
    }));
  `;
  const result = JSON.parse(
    run(process.execPath, ['-e', script], artifactDirectory),
  );
  if (
    !Number.isSafeInteger(result.before) ||
    !Number.isSafeInteger(result.after) ||
    !Array.isArray(result.loaded)
  ) {
    fail('import closure report is invalid');
  }
  const forbidden = result.loaded.filter(
    (filePath) =>
      (!allowSemver && /node_modules[\\/]semver(?:[\\/]|$)/i.test(filePath)) ||
      /(?:node_modules[\\/](?:croner|pg|drizzle-orm|sequelize|sqlite3)(?:[\\/]|$)|node_modules[\\/]@qinglong[\\/]cluster-|local-sqlite[\\/]dist[\\/]migration\.js$|local-sqlite[\\/]dist[\\/]migrations[\\/])/i.test(
        filePath,
      ),
  );
  if (forbidden.length > 0)
    fail('runtime import closure contains forbidden modules');
  return Object.freeze({
    loadedModuleCount: result.loaded.length,
    rssDeltaBytes: Math.max(0, result.after - result.before),
  });
}

function auditApplicationExecutable(artifactDirectory) {
  const catalogExport =
    '@qinglong/local-application/plugin-package-recovery-catalog';
  const packageDirectory = path.join(
    artifactDirectory,
    'node_modules',
    '@qinglong',
    'local-application',
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
  );
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    !manifest.bin ||
    typeof manifest.bin !== 'object' ||
    Array.isArray(manifest.bin) ||
    manifest.bin['ql3-local-application'] !== 'dist/cli.js'
  ) {
    fail('local application executable manifest is invalid');
  }
  const executablePath = path.join(packageDirectory, 'dist', 'cli.js');
  const executableStat = fs.lstatSync(executablePath);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
    fail('local application executable is not a regular file');
  }
  const output = run(
    process.execPath,
    [executablePath, '--help'],
    artifactDirectory,
  );
  if (
    output !==
    'Usage: ql3-local-application --config /absolute/private-config.json'
  ) {
    fail('local application executable help output is invalid');
  }
  const catalogOutput = run(
    process.execPath,
    [
      '-e',
      `const value = require(${JSON.stringify(catalogExport)});
       if (typeof value.createLocalPluginPackageRecoveryCatalogStageProvider !== 'function') {
         process.exitCode = 1;
       }`,
    ],
    artifactDirectory,
  );
  if (catalogOutput !== '') {
    fail('local Plugin Package recovery catalog import emitted output');
  }
}

function auditLocalApiExecutable(artifactDirectory) {
  const packageDirectory = path.join(
    artifactDirectory,
    'node_modules',
    '@qinglong',
    'local-api',
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
  );
  if (manifest.bin?.['ql3-local-api'] !== 'dist/cli.js') {
    fail('local API executable manifest is invalid');
  }
  const output = run(
    process.execPath,
    [path.join(packageDirectory, 'dist', 'cli.js'), '--help'],
    artifactDirectory,
  );
  if (
    output !== 'Usage: ql3-local-api --config /absolute/private-config.json'
  ) {
    fail('local API executable help output is invalid');
  }
  const consoleDirectory = path.join(packageDirectory, 'assets', 'console');
  const expectedAssets = ['console.css', 'console.js', 'index.html'];
  const actualAssets = fs.readdirSync(consoleDirectory).sort();
  if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)) {
    fail(
      `local Console asset closure is invalid: ${JSON.stringify(actualAssets)}`,
    );
  }
  let totalBytes = 0;
  const contents = {};
  for (const name of expectedAssets) {
    const assetPath = path.join(consoleDirectory, name);
    const stat = fs.lstatSync(assetPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 100 ||
      stat.size > 96 * 1024
    ) {
      fail(`local Console asset is invalid: ${name}`);
    }
    totalBytes += stat.size;
    contents[name] = fs.readFileSync(assetPath, 'utf8');
  }
  if (
    totalBytes > 192 * 1024 ||
    !contents['index.html'].includes('href="/console.css"') ||
    !contents['index.html'].includes('src="/console.js"') ||
    /<(?:script|style)(?:\s|>)[^>]*>\s*[^<\s]/u.test(contents['index.html']) ||
    /\b(?:localStorage|sessionStorage|innerHTML|eval)\b/u.test(
      contents['console.js'],
    ) ||
    /https?:\/\//u.test(contents['index.html']) ||
    /https?:\/\//u.test(contents['console.css']) ||
    /https?:\/\//u.test(contents['console.js'])
  ) {
    fail('local Console offline or credential-custody contract is invalid');
  }
}

function packageRootFromEntry(entryPath, packageName) {
  let current = path.dirname(entryPath);
  while (current !== path.dirname(current)) {
    const manifestPath = path.join(current, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === packageName) return current;
    }
    current = path.dirname(current);
  }
  fail(`cannot resolve package root for ${packageName}`);
}

function mcpExternalPackageDirectories(root) {
  const mcpPackageDirectory = path.join(
    root,
    'packages',
    'ql3-local-mcp-server',
  );
  const serverRoot = fs.realpathSync(
    path.join(
      mcpPackageDirectory,
      'node_modules',
      '@modelcontextprotocol',
      'server',
    ),
  );
  const dependencyResolutionRoot = path.dirname(path.dirname(serverRoot));
  return Object.freeze({
    '@modelcontextprotocol/server': serverRoot,
    '@modelcontextprotocol/core': packageRootFromEntry(
      require.resolve('@modelcontextprotocol/core', {
        paths: [dependencyResolutionRoot],
      }),
      '@modelcontextprotocol/core',
    ),
    zod: packageRootFromEntry(
      require.resolve('zod', { paths: [dependencyResolutionRoot] }),
      'zod',
    ),
  });
}

function pruneMcpExternalDevelopmentFiles(nodeModulesDirectory) {
  let files = 0;
  let bytes = 0;
  for (const packageName of [
    '@modelcontextprotocol/core',
    '@modelcontextprotocol/server',
    'zod',
  ]) {
    const packageDirectory = path.join(nodeModulesDirectory, packageName);
    const pending = [packageDirectory];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (!entry.isFile()) fail('MCP dependency contains unsupported data');
        if (
          entry.name.endsWith('.map') ||
          entry.name.endsWith('.d.ts') ||
          entry.name.endsWith('.d.cts') ||
          entry.name.endsWith('.d.mts') ||
          entry.name.toLowerCase() === 'readme.md'
        ) {
          const stat = fs.lstatSync(entryPath);
          fs.unlinkSync(entryPath);
          files += 1;
          bytes += stat.size;
        }
      }
    }
  }
  return Object.freeze({ files, bytes });
}

function auditMcpExecutable(artifactDirectory) {
  const packageDirectory = path.join(
    artifactDirectory,
    'node_modules',
    '@qinglong',
    'local-mcp-server',
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
  );
  if (manifest.bin?.['ql3-mcp'] !== 'dist/cli.js') {
    fail('local MCP executable manifest is invalid');
  }
  const output = run(
    process.execPath,
    [path.join(packageDirectory, 'dist', 'cli.js'), '--help'],
    artifactDirectory,
  );
  if (output !== 'Usage: ql3-mcp --config /absolute/private-config.json') {
    fail('local MCP executable help output is invalid');
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (process.versions.node.split('.')[0] !== '24') {
    fail('artifact audit requires Node 24');
  }
  const root = path.resolve(__dirname, '..');
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `ql3-${options.profile}-artifact-`),
  );
  try {
    const packsDirectory = path.join(temporaryRoot, 'packs');
    const artifactDirectory = path.join(temporaryRoot, 'artifact');
    const cacheDirectory = path.join(temporaryRoot, 'npm-cache');
    fs.mkdirSync(packsDirectory, { recursive: true });
    fs.mkdirSync(artifactDirectory, { recursive: true });

    const packageChain = [...PACKAGE_CHAIN];
    if (options.adopted) {
      packageChain.push(
        Object.freeze({
          name: '@qinglong/local-admin',
          directory: 'ql3-local-admin',
        }),
        Object.freeze({
          name: '@qinglong/local-secret',
          directory: 'ql3-local-secret',
        }),
      );
    }
    if (options.application) {
      packageChain.push(
        Object.freeze({
          name: '@qinglong/local-command-file',
          directory: 'ql3-local-command-file',
        }),
        Object.freeze({
          name: '@qinglong/local-process',
          directory: 'ql3-local-process',
        }),
        Object.freeze({
          name: '@qinglong/local-execution',
          directory: 'ql3-local-execution',
        }),
      );
    }
    if (options.ai) {
      packageChain.push(
        Object.freeze({
          name: '@qinglong/ai',
          directory: 'ql3-ai',
        }),
      );
    }
    if (options.mcp) {
      packageChain.push(
        Object.freeze({
          name: '@qinglong/local-command-file',
          directory: 'ql3-local-command-file',
        }),
        Object.freeze({
          name: '@qinglong/local-owner-console',
          directory: 'ql3-local-owner-console',
        }),
        Object.freeze({
          name: '@qinglong/local-mcp-server',
          directory: 'ql3-local-mcp-server',
        }),
      );
    }
    const entrySpecifiers = [
      options.api
        ? '@qinglong/local-api'
        : options.mcp
        ? '@qinglong/local-mcp-server'
        : options.application && options.ai
        ? '@qinglong/local-application/ai-feature'
        : options.application
        ? '@qinglong/local-application'
        : options.adopted
        ? `@qinglong/local-admin/adopted-profile/${options.runtimeProfile}`
        : `@qinglong/local-sqlite/profile/${options.runtimeProfile}`,
      ...(options.ai && !options.application ? ['@qinglong/ai/profile'] : []),
      ...(options.application
        ? [
            '@qinglong/local-application/process',
            '@qinglong/local-application/plugin-package-recovery-catalog',
          ]
        : []),
      ...(options.api
        ? ['@qinglong/local-api/config', '@qinglong/local-api/process']
        : []),
      ...(options.mcp
        ? [
            '@qinglong/local-mcp-server/config',
            '@qinglong/local-mcp-server/process',
          ]
        : []),
    ];
    const externalPackageNames = [
      ...BASE_EXTERNAL_PACKAGE_NAMES,
      ...(options.application ? ['croner'] : []),
      ...(options.mcp
        ? ['@modelcontextprotocol/server', '@modelcontextprotocol/core', 'zod']
        : []),
    ];
    if (options.application) {
      packageChain.push(
        Object.freeze({
          name: '@qinglong/local-application',
          directory: 'ql3-local-application',
        }),
      );
    }
    if (options.api) {
      packageChain.push(
        Object.freeze({
          name: '@qinglong/local-owner-console',
          directory: 'ql3-local-owner-console',
        }),
        Object.freeze({
          name: '@qinglong/local-api',
          directory: 'ql3-local-api',
        }),
      );
    }
    const archives = [];
    for (const packageDefinition of packageChain) {
      const packageDirectory = path.join(
        root,
        'packages',
        packageDefinition.directory,
      );
      run('pnpm', ['run', 'build'], packageDirectory);
      const archive = run(
        'pnpm',
        ['pack', '--pack-destination', packsDirectory],
        packageDirectory,
      )
        .split(/\r?\n/)
        .at(-1);
      if (!archive || !path.isAbsolute(archive) || !fs.existsSync(archive)) {
        fail(`pack output for ${packageDefinition.name} is invalid`);
      }
      archives.push(archive);
    }
    const mcpExternalDirectories = options.mcp
      ? mcpExternalPackageDirectories(root)
      : {};
    for (const packageName of externalPackageNames) {
      const packageDirectory =
        mcpExternalDirectories[packageName] ??
        path.dirname(
          require.resolve(`${packageName}/package.json`, {
            paths: [
              path.join(
                root,
                'packages',
                packageName === 'croner'
                  ? 'ql3-local-execution'
                  : 'ql3-runtime-core',
              ),
            ],
          }),
        );
      const archive = run(
        'pnpm',
        ['pack', '--pack-destination', packsDirectory],
        packageDirectory,
      )
        .split(/\r?\n/)
        .at(-1);
      if (!archive || !path.isAbsolute(archive) || !fs.existsSync(archive)) {
        fail(`pack output for ${packageName} is invalid`);
      }
      archives.push(archive);
    }

    run(
      'npm',
      [
        'install',
        '--prefix',
        artifactDirectory,
        '--cache',
        cacheDirectory,
        '--omit=dev',
        '--ignore-scripts',
        '--no-bin-links',
        '--package-lock=false',
        '--offline',
        '--no-audit',
        '--no-fund',
        ...archives,
      ],
      root,
    );

    const expectedPackages = [
      ...packageChain.map(({ name }) => name),
      ...externalPackageNames,
    ].sort();
    const actualPackages = installedPackages(
      path.join(artifactDirectory, 'node_modules'),
    );
    if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages)) {
      fail(
        `production package closure is invalid: ${actualPackages.join(',')}`,
      );
    }
    const prunedRuntimeArtifact = pruneRuntimeArtifact(
      path.join(artifactDirectory, 'node_modules', '@qinglong'),
      {
        entrySpecifiers,
        excludedInternalPackages:
          options.application && !options.ai ? ['@qinglong/ai'] : [],
        retainedJavaScriptFiles: options.api
          ? ['local-api/assets/console/console.js']
          : [],
      },
    );
    const prunedMcpExternalDevelopment = options.mcp
      ? pruneMcpExternalDevelopmentFiles(
          path.join(artifactDirectory, 'node_modules'),
        )
      : Object.freeze({ files: 0, bytes: 0 });
    if (options.application) {
      auditApplicationExecutable(artifactDirectory);
    }
    if (options.api) {
      auditLocalApiExecutable(artifactDirectory);
    }
    if (options.mcp) {
      auditMcpExecutable(artifactDirectory);
    }
    const usage = directoryUsage(artifactDirectory, options.maxArtifactFiles);
    if (usage.bytes > options.maxArtifactBytes) {
      fail(
        `artifact uses ${usage.bytes} bytes, budget is ${options.maxArtifactBytes}`,
      );
    }
    const artifactHeadroomBytes = options.maxArtifactBytes - usage.bytes;
    if (artifactHeadroomBytes < options.minimumArtifactHeadroomBytes) {
      fail(
        `artifact headroom is ${artifactHeadroomBytes} bytes, minimum is ${options.minimumArtifactHeadroomBytes}`,
      );
    }
    const closure = auditImportClosure(artifactDirectory, entrySpecifiers, {
      allowSemver: options.mcp,
    });
    if (closure.rssDeltaBytes > options.maxRssDeltaBytes) {
      fail(
        `import RSS delta is ${closure.rssDeltaBytes} bytes, budget is ${options.maxRssDeltaBytes}`,
      );
    }
    if (options.outputDirectory !== undefined) {
      fs.cpSync(artifactDirectory, options.outputDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        profile: options.profile,
        packages: actualPackages,
        artifactBytes: usage.bytes,
        artifactFiles: usage.files,
        maxArtifactFiles: options.maxArtifactFiles,
        maxArtifactBytes: options.maxArtifactBytes,
        artifactHeadroomBytes,
        minimumArtifactHeadroomBytes: options.minimumArtifactHeadroomBytes,
        prunedRuntimeDevelopmentFiles: prunedRuntimeArtifact.development.files,
        prunedRuntimeDevelopmentBytes: prunedRuntimeArtifact.development.bytes,
        runtimeJavaScriptFilesBefore:
          prunedRuntimeArtifact.runtimeJavaScript.filesBefore,
        runtimeJavaScriptFilesAfter:
          prunedRuntimeArtifact.runtimeJavaScript.filesAfter,
        prunedRuntimeJavaScriptFiles:
          prunedRuntimeArtifact.runtimeJavaScript.filesRemoved,
        prunedRuntimeJavaScriptBytes:
          prunedRuntimeArtifact.runtimeJavaScript.bytesRemoved,
        strippedSourceMapDirectiveFiles:
          prunedRuntimeArtifact.sourceMapDirectives.files,
        strippedSourceMapDirectiveBytes:
          prunedRuntimeArtifact.sourceMapDirectives.bytes,
        compactedPackageManifestFiles:
          prunedRuntimeArtifact.packageManifests.compactedFiles,
        compactedPackageManifestBytes:
          prunedRuntimeArtifact.packageManifests.compactedBytes,
        projectedRuntimeManifestFiles:
          prunedRuntimeArtifact.packageManifests.projectedFiles,
        projectedRuntimeManifestBytes:
          prunedRuntimeArtifact.packageManifests.projectedBytes,
        runtimeExportKeysBefore:
          prunedRuntimeArtifact.packageManifests.runtimeExports.keysBefore,
        runtimeExportKeysAfter:
          prunedRuntimeArtifact.packageManifests.runtimeExports.keysAfter,
        runtimeExportKeysRemoved:
          prunedRuntimeArtifact.packageManifests.runtimeExports.keysRemoved,
        projectedRuntimeExportBytes:
          prunedRuntimeArtifact.packageManifests.runtimeExports.bytes,
        excludedRuntimeInternalSpecifiers:
          prunedRuntimeArtifact.packageManifests.runtimeExports
            .excludedSpecifiers,
        prunedRuntimeArtifactBytes: prunedRuntimeArtifact.savedBytes,
        prunedMcpExternalDevelopmentFiles: prunedMcpExternalDevelopment.files,
        prunedMcpExternalDevelopmentBytes: prunedMcpExternalDevelopment.bytes,
        loadedModuleCount: closure.loadedModuleCount,
        rssDeltaBytes: closure.rssDeltaBytes,
        maxRssDeltaBytes: options.maxRssDeltaBytes,
        compatible: true,
      })}\n`,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
