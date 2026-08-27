const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  pruneRuntimeArtifact,
} = require('../../scripts/ql3-prune-runtime-artifact.cjs');

function fixture() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-runtime-artifact-pruner-'),
  );
  const root = path.join(temporaryRoot, 'node_modules', '@qinglong');
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    close() {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

function writePackage(root, directory, name) {
  const packageRoot = path.join(root, directory);
  const dist = path.join(packageRoot, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const manifest = {
    name,
    version: '3.0.0-alpha.0',
    main: 'dist/index.js',
    exports: { '.': './dist/index.js' },
  };
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { dist, manifest, packageRoot };
}

test('prunes only deployment waste while preserving runtime package semantics', () => {
  const current = fixture();
  try {
    const runtime = writePackage(
      current.root,
      'runtime-core',
      '@qinglong/runtime-core',
    );
    runtime.manifest.types = 'dist/index.d.ts';
    runtime.manifest.typesVersions = {
      '*': { '*': ['dist/index.d.ts'] },
    };
    runtime.manifest.files = ['dist/**/*.js', 'dist/**/*.d.ts'];
    runtime.manifest.scripts = { build: 'tsc -p tsconfig.json' };
    runtime.manifest.dependencies = { semver: '7.7.4' };
    runtime.manifest.devDependencies = { typescript: '5.9.3' };
    runtime.manifest.exports = {
      '.': {
        types: './dist/index.d.ts',
        require: './dist/index.js',
        default: './dist/index.js',
      },
    };
    fs.writeFileSync(
      path.join(runtime.packageRoot, 'package.json'),
      `${JSON.stringify(runtime.manifest, null, 2)}\n`,
    );
    const application = writePackage(
      current.root,
      'local-application',
      '@qinglong/local-application',
    );
    application.manifest.bin = {
      'ql3-local-application': 'dist/cli.js',
    };
    fs.writeFileSync(
      path.join(application.packageRoot, 'package.json'),
      `${JSON.stringify(application.manifest, null, 2)}\n`,
    );
    const executable = path.join(application.dist, 'cli.js');
    fs.writeFileSync(
      path.join(application.dist, 'index.js'),
      "'use strict';\n",
    );
    fs.writeFileSync(
      executable,
      "#!/usr/bin/env node\n'use strict';\n//# sourceMappingURL=cli.js.map\n",
      { mode: 0o755 },
    );
    const retained = path.join(runtime.dist, 'index.js');
    fs.writeFileSync(
      retained,
      "'use strict';\n//# sourceMappingURL=not-terminal.js.map\nmodule.exports = {};\n",
    );
    fs.writeFileSync(path.join(runtime.dist, 'index.d.ts'), 'export {};\n');
    fs.writeFileSync(path.join(runtime.dist, 'index.js.map'), '{}\n');

    const report = pruneRuntimeArtifact(current.root, {
      entrySpecifiers: [
        '@qinglong/runtime-core',
        '@qinglong/local-application',
      ],
    });

    assert.deepEqual(report.development, { files: 2, bytes: 14 });
    assert.equal(report.sourceMapDirectives.files, 1);
    assert.equal(report.packageManifests.files, 2);
    assert.equal(report.packageManifests.compactedFiles, 2);
    assert.equal(report.packageManifests.compactedBytes > 0, true);
    assert.equal(report.packageManifests.projectedFiles, 1);
    assert.equal(report.packageManifests.projectedBytes > 0, true);
    assert.equal(report.savedBytes > report.development.bytes, true);
    assert.equal(fs.existsSync(path.join(runtime.dist, 'index.d.ts')), false);
    assert.equal(fs.existsSync(path.join(runtime.dist, 'index.js.map')), false);
    assert.equal(
      fs.readFileSync(executable, 'utf8'),
      "#!/usr/bin/env node\n'use strict';\n",
    );
    assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
    assert.match(fs.readFileSync(retained, 'utf8'), /not-terminal\.js\.map/);
    const runtimeManifest = JSON.parse(
      fs.readFileSync(path.join(runtime.packageRoot, 'package.json'), 'utf8'),
    );
    assert.deepEqual(runtimeManifest.exports, {
      '.': {
        require: './dist/index.js',
        default: './dist/index.js',
      },
    });
    assert.deepEqual(runtimeManifest.dependencies, { semver: '7.7.4' });
    for (const developmentField of [
      'devDependencies',
      'files',
      'scripts',
      'types',
      'typesVersions',
    ]) {
      assert.equal(developmentField in runtimeManifest, false);
    }
    assert.equal(
      fs.readFileSync(path.join(runtime.packageRoot, 'package.json'), 'utf8'),
      `${JSON.stringify(runtimeManifest)}\n`,
    );
  } finally {
    current.close();
  }
});

test('projects runtime exports from static imports and explicit Profile entries', () => {
  const current = fixture();
  try {
    const runtime = writePackage(
      current.root,
      'runtime-core',
      '@qinglong/runtime-core',
    );
    runtime.manifest.exports = {
      '.': './dist/index.js',
      './used': './dist/used.js',
      './lazy': './dist/lazy.js',
      './unused': './dist/unused.js',
    };
    fs.writeFileSync(
      path.join(runtime.packageRoot, 'package.json'),
      `${JSON.stringify(runtime.manifest, null, 2)}\n`,
    );
    for (const name of ['index', 'used', 'lazy', 'unused']) {
      fs.writeFileSync(
        path.join(runtime.dist, `${name}.js`),
        "'use strict';\n",
      );
    }

    const application = writePackage(
      current.root,
      'local-application',
      '@qinglong/local-application',
    );
    application.manifest.exports = {
      '.': './dist/index.js',
      './process': './dist/process.js',
      './unused': './dist/unused.js',
    };
    fs.writeFileSync(
      path.join(application.packageRoot, 'package.json'),
      `${JSON.stringify(application.manifest, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(application.dist, 'index.js'),
      [
        "'use strict';",
        "require('@qinglong/runtime-core/used');",
        "require.resolve('@qinglong/runtime-core/used');",
        "const load = () => import('@qinglong/runtime-core/lazy');",
        'module.exports = { load };',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(application.dist, 'process.js'),
      "'use strict';\nmodule.exports = {};\n",
    );
    fs.writeFileSync(
      path.join(application.dist, 'unused.js'),
      "'use strict';\n",
    );

    const report = pruneRuntimeArtifact(current.root, {
      entrySpecifiers: [
        '@qinglong/local-application',
        '@qinglong/local-application/process',
      ],
    });

    const projectedRuntime = JSON.parse(
      fs.readFileSync(path.join(runtime.packageRoot, 'package.json'), 'utf8'),
    );
    const projectedApplication = JSON.parse(
      fs.readFileSync(
        path.join(application.packageRoot, 'package.json'),
        'utf8',
      ),
    );
    assert.deepEqual(Object.keys(projectedRuntime.exports), [
      './used',
      './lazy',
    ]);
    assert.deepEqual(Object.keys(projectedApplication.exports), [
      '.',
      './process',
    ]);
    assert.deepEqual(report.packageManifests.runtimeExports, {
      keysBefore: 7,
      keysAfter: 4,
      keysRemoved: 3,
      bytes: report.packageManifests.runtimeExports.bytes,
      excludedSpecifiers: 0,
    });
    assert.equal(report.packageManifests.runtimeExports.bytes > 0, true);
    assert.equal(fs.existsSync(path.join(runtime.dist, 'unused.js')), false);
    assert.equal('main' in projectedRuntime, false);
    assert.deepEqual(report.runtimeJavaScript, {
      filesBefore: 7,
      filesAfter: 4,
      filesRemoved: 3,
      bytesRemoved: report.runtimeJavaScript.bytesRemoved,
    });
    assert.equal(report.runtimeJavaScript.bytesRemoved > 0, true);
  } finally {
    current.close();
  }
});

test('allows only explicitly excluded and declared optional feature imports', () => {
  const current = fixture();
  try {
    const application = writePackage(
      current.root,
      'local-application',
      '@qinglong/local-application',
    );
    application.manifest.devDependencies = {
      '@qinglong/ai': application.manifest.version,
    };
    fs.writeFileSync(
      path.join(application.packageRoot, 'package.json'),
      `${JSON.stringify(application.manifest, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(application.dist, 'index.js'),
      "'use strict';\nconst load = () => import('@qinglong/ai/profile');\nmodule.exports = { load };\n",
    );

    assert.throws(
      () =>
        pruneRuntimeArtifact(current.root, {
          entrySpecifiers: ['@qinglong/local-application'],
        }),
      /is not installed/,
    );
    const report = pruneRuntimeArtifact(current.root, {
      entrySpecifiers: ['@qinglong/local-application'],
      excludedInternalPackages: ['@qinglong/ai'],
    });
    assert.equal(report.packageManifests.runtimeExports.excludedSpecifiers, 1);
  } finally {
    current.close();
  }
});

test('rejects dynamic internal specifiers before pruning any file', () => {
  const current = fixture();
  try {
    const runtime = writePackage(
      current.root,
      'runtime-core',
      '@qinglong/runtime-core',
    );
    fs.writeFileSync(path.join(runtime.dist, 'index.js'), "'use strict';\n");
    const map = path.join(runtime.dist, 'index.js.map');
    fs.writeFileSync(map, '{}\n');
    const application = writePackage(
      current.root,
      'local-application',
      '@qinglong/local-application',
    );
    fs.writeFileSync(
      path.join(application.dist, 'index.js'),
      "'use strict';\nconst name = 'runtime-core';\nrequire('@qinglong/' + name);\n",
    );

    assert.throws(
      () =>
        pruneRuntimeArtifact(current.root, {
          entrySpecifiers: ['@qinglong/local-application'],
        }),
      /non-literal module load/,
    );
    assert.equal(fs.existsSync(map), true);
  } finally {
    current.close();
  }
});

test('rejects unknown entries and missing retained targets before mutation', () => {
  const current = fixture();
  try {
    const application = writePackage(
      current.root,
      'local-application',
      '@qinglong/local-application',
    );
    const map = path.join(application.dist, 'index.js.map');
    fs.writeFileSync(map, '{}\n');

    assert.throws(
      () =>
        pruneRuntimeArtifact(current.root, {
          entrySpecifiers: ['@qinglong/not-installed'],
        }),
      /is not installed/,
    );
    assert.equal(fs.existsSync(map), true);
    assert.throws(
      () =>
        pruneRuntimeArtifact(current.root, {
          entrySpecifiers: ['@qinglong/local-application'],
        }),
      /runtime export target is missing/,
    );
    assert.equal(fs.existsSync(map), true);
  } finally {
    current.close();
  }
});

test('retains relative, dynamic, cyclic, bin, migration and asset closure', () => {
  const current = fixture();
  try {
    const runtime = writePackage(
      current.root,
      'runtime-core',
      '@qinglong/runtime-core',
    );
    runtime.manifest.exports = {
      '.': './dist/index.js',
      './used': './dist/used.js',
      './unused': './dist/unused.js',
    };
    fs.writeFileSync(
      path.join(runtime.packageRoot, 'package.json'),
      `${JSON.stringify(runtime.manifest, null, 2)}\n`,
    );
    for (const name of ['index', 'used', 'unused']) {
      fs.writeFileSync(
        path.join(runtime.dist, `${name}.js`),
        "'use strict';\n",
      );
    }

    const application = writePackage(
      current.root,
      'local-application',
      '@qinglong/local-application',
    );
    application.manifest.bin = { ql3: 'dist/cli.js' };
    fs.writeFileSync(
      path.join(application.packageRoot, 'package.json'),
      `${JSON.stringify(application.manifest, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(application.dist, 'index.js'),
      [
        "'use strict';",
        "require('./cycle-a');",
        "require('@qinglong/runtime-core/used');",
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(application.dist, 'cycle-a.js'),
      "'use strict';\nconst load = () => import('./cycle-b.js');\nmodule.exports = { load };\n",
    );
    fs.writeFileSync(
      path.join(application.dist, 'cycle-b.js'),
      "'use strict';\nrequire('./cycle-a');\n",
    );
    fs.writeFileSync(
      path.join(application.dist, 'cli.js'),
      "#!/usr/bin/env node\n'use strict';\nrequire('./bin-support');\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(application.dist, 'bin-support.js'),
      "'use strict';\n",
    );
    fs.writeFileSync(
      path.join(application.dist, 'unused.js'),
      "'use strict';\n",
    );
    const migrationDirectory = path.join(application.dist, 'migration');
    fs.mkdirSync(migrationDirectory);
    fs.writeFileSync(
      path.join(migrationDirectory, 'ledger.js'),
      "'use strict';\n",
    );
    const assetDirectory = path.join(application.dist, 'assets');
    fs.mkdirSync(assetDirectory);
    fs.writeFileSync(path.join(assetDirectory, 'schema.json'), '{}\n');
    const consoleDirectory = path.join(application.packageRoot, 'assets');
    fs.mkdirSync(consoleDirectory);
    fs.writeFileSync(
      path.join(consoleDirectory, 'console.js'),
      "'use strict';\ndocument.title = 'QingLong';\n",
    );

    const report = pruneRuntimeArtifact(current.root, {
      entrySpecifiers: ['@qinglong/local-application'],
      retainedJavaScriptFiles: ['local-application/assets/console.js'],
    });

    for (const relative of [
      'index.js',
      'cycle-a.js',
      'cycle-b.js',
      'cli.js',
      'bin-support.js',
      'migration/ledger.js',
      'assets/schema.json',
      '../assets/console.js',
    ]) {
      assert.equal(fs.existsSync(path.join(application.dist, relative)), true);
    }
    assert.equal(
      fs.existsSync(path.join(application.dist, 'unused.js')),
      false,
    );
    assert.equal(fs.existsSync(path.join(runtime.dist, 'used.js')), true);
    assert.equal(fs.existsSync(path.join(runtime.dist, 'index.js')), false);
    assert.equal(fs.existsSync(path.join(runtime.dist, 'unused.js')), false);
    const runtimeManifest = JSON.parse(
      fs.readFileSync(path.join(runtime.packageRoot, 'package.json'), 'utf8'),
    );
    assert.deepEqual(runtimeManifest.exports, {
      './used': './dist/used.js',
    });
    assert.equal('main' in runtimeManifest, false);
    assert.equal(report.runtimeJavaScript.filesRemoved, 3);
    assert.equal(report.runtimeJavaScript.bytesRemoved > 0, true);
  } finally {
    current.close();
  }
});

test('retains main closure for a package without exports', () => {
  const current = fixture();
  try {
    const leaf = writePackage(current.root, 'leaf', '@qinglong/leaf');
    delete leaf.manifest.exports;
    fs.writeFileSync(
      path.join(leaf.packageRoot, 'package.json'),
      `${JSON.stringify(leaf.manifest, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(leaf.dist, 'index.js'),
      "'use strict';\nrequire('./support');\n",
    );
    fs.writeFileSync(path.join(leaf.dist, 'support.js'), "'use strict';\n");
    fs.writeFileSync(path.join(leaf.dist, 'unused.js'), "'use strict';\n");

    pruneRuntimeArtifact(current.root, {
      entrySpecifiers: ['@qinglong/leaf'],
    });

    assert.equal(fs.existsSync(path.join(leaf.dist, 'index.js')), true);
    assert.equal(fs.existsSync(path.join(leaf.dist, 'support.js')), true);
    assert.equal(fs.existsSync(path.join(leaf.dist, 'unused.js')), false);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(leaf.packageRoot, 'package.json'), 'utf8'),
      ).main,
      'dist/index.js',
    );
  } finally {
    current.close();
  }
});

test('rejects escaping and missing relative targets before mutation', () => {
  const current = fixture();
  try {
    const application = writePackage(
      current.root,
      'local-application',
      '@qinglong/local-application',
    );
    const entry = path.join(application.dist, 'index.js');
    const map = path.join(application.dist, 'index.js.map');
    fs.writeFileSync(entry, "'use strict';\nrequire('../../outside');\n");
    fs.writeFileSync(map, '{}\n');

    assert.throws(
      () =>
        pruneRuntimeArtifact(current.root, {
          entrySpecifiers: ['@qinglong/local-application'],
        }),
      /escapes its package/,
    );
    assert.equal(fs.existsSync(map), true);
    fs.writeFileSync(entry, "'use strict';\nrequire('./missing');\n");
    assert.throws(
      () =>
        pruneRuntimeArtifact(current.root, {
          entrySpecifiers: ['@qinglong/local-application'],
        }),
      /target is missing/,
    );
    assert.equal(fs.existsSync(map), true);
  } finally {
    current.close();
  }
});

test('rejects invalid or missing explicit JavaScript assets before mutation', () => {
  const current = fixture();
  try {
    const application = writePackage(
      current.root,
      'local-application',
      '@qinglong/local-application',
    );
    const entry = path.join(application.dist, 'index.js');
    const map = path.join(application.dist, 'index.js.map');
    fs.writeFileSync(entry, "'use strict';\n");
    fs.writeFileSync(map, '{}\n');

    for (const retainedJavaScriptFiles of [
      ['../outside.js'],
      ['local-application/assets/missing.js'],
      ['local-application/dist/index.js', 'local-application/dist/index.js'],
    ]) {
      assert.throws(
        () =>
          pruneRuntimeArtifact(current.root, {
            entrySpecifiers: ['@qinglong/local-application'],
            retainedJavaScriptFiles,
          }),
        /retained JavaScript file/u,
      );
      assert.equal(fs.existsSync(map), true);
    }
  } finally {
    current.close();
  }
});

test('rejects symbolic links before making partial changes', () => {
  const current = fixture();
  try {
    const runtime = writePackage(
      current.root,
      'runtime-core',
      '@qinglong/runtime-core',
    );
    const map = path.join(runtime.dist, 'index.js.map');
    fs.writeFileSync(map, '{}\n');
    fs.symlinkSync(map, path.join(runtime.dist, 'linked.map'));

    assert.throws(
      () => pruneRuntimeArtifact(current.root),
      /runtime package contains a symbolic link/,
    );
    assert.equal(fs.existsSync(map), true);
  } finally {
    current.close();
  }
});

test('validates package manifests before deleting development files', () => {
  const current = fixture();
  try {
    const runtime = writePackage(
      current.root,
      'runtime-core',
      '@qinglong/runtime-core',
    );
    const map = path.join(runtime.dist, 'index.js.map');
    fs.writeFileSync(map, '{}\n');
    fs.writeFileSync(path.join(runtime.packageRoot, 'package.json'), '{');

    assert.throws(() => pruneRuntimeArtifact(current.root), SyntaxError);
    assert.equal(fs.existsSync(map), true);
  } finally {
    current.close();
  }
});
