'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  auditClusterImageSbom,
  componentRef,
  createClusterImageSbom,
} = require('../../scripts/ql3-cluster-image-sbom.cjs');

const root = path.resolve(__dirname, '../..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('generates the exact reviewed cluster image runtime closure', () => {
  const document = createClusterImageSbom({ root });
  const report = auditClusterImageSbom(document, { root });

  assert.deepEqual(report, {
    image: 'control',
    root: 'pkg:npm/%40qinglong/cluster-control-image-dependencies@3.0.0-alpha.0',
    components: 46,
    externalComponents: 43,
    internalComponents: 3,
    dependencyNodes: 47,
    inventoryVerified: false,
  });
  assert.equal(
    document.components.some((component) => component.name === 'pg-protocol'),
    true,
  );
  assert.equal(
    document.components.some((component) => component.name === 'typescript'),
    false,
  );
});

test('generates the optional Cluster AI image runtime closure', () => {
  const document = createClusterImageSbom({ root, image: 'control-ai' });
  const report = auditClusterImageSbom(document, {
    root,
    image: 'control-ai',
  });

  assert.deepEqual(report, {
    image: 'control-ai',
    root: 'pkg:npm/%40qinglong/cluster-control-image-dependencies@3.0.0-alpha.0',
    components: 47,
    externalComponents: 43,
    internalComponents: 4,
    dependencyNodes: 48,
    inventoryVerified: false,
  });
  assert.equal(
    document.components.some((component) => component.name === '@qinglong/ai'),
    true,
  );
});

test('generates the independent reviewed cluster-admin image closure', () => {
  const document = createClusterImageSbom({ root, image: 'admin' });
  const report = auditClusterImageSbom(document, {
    root,
    image: 'admin',
  });

  assert.deepEqual(report, {
    image: 'admin',
    root: 'pkg:npm/%40qinglong/cluster-admin-image-dependencies@3.0.0-alpha.0',
    components: 91,
    externalComponents: 87,
    internalComponents: 4,
    dependencyNodes: 92,
    inventoryVerified: false,
  });
  assert.equal(
    document.components.some(
      (component) => component.name === '@kubernetes/client-node',
    ),
    true,
  );
  assert.equal(
    document.components.some(
      (component) => component.name === '@modelcontextprotocol/server',
    ),
    true,
  );
  assert.equal(
    document.components.some(
      (component) => component.name === '@aws-sdk/client-s3',
    ),
    false,
  );
});

test('generates the AI-excluded local application image closure', () => {
  const document = createClusterImageSbom({ root, image: 'local' });
  const report = auditClusterImageSbom(document, {
    root,
    image: 'local',
  });

  assert.deepEqual(report, {
    image: 'local',
    root: 'pkg:npm/%40qinglong/local-application-image@3.0.0-alpha.0',
    components: 10,
    externalComponents: 2,
    internalComponents: 8,
    dependencyNodes: 11,
    inventoryVerified: false,
  });
  assert.deepEqual(
    document.components
      .filter((component) =>
        ['@qinglong/ai', 'drizzle-orm', 'typescript'].includes(component.name),
      )
      .map((component) => component.name),
    [],
  );
});

test('rejects a control SBOM presented as cluster-admin evidence', () => {
  const document = createClusterImageSbom({ root });
  assert.throws(
    () =>
      auditClusterImageSbom(document, {
        root,
        image: 'admin',
      }),
    /selected image profile|image manifest/,
  );
});

test('rejects widened metadata and root component drift', () => {
  const widened = createClusterImageSbom({ root });
  widened.metadata.generatedBy = 'unreviewed';
  assert.throws(
    () => auditClusterImageSbom(widened, { root }),
    /root component/,
  );

  const drifted = createClusterImageSbom({ root });
  drifted.metadata.component.purl = 'pkg:npm/unrelated@1.0.0';
  assert.throws(
    () => auditClusterImageSbom(drifted, { root }),
    /root component/,
  );
});

test('rejects a missing internal dependency edge', () => {
  const document = createClusterImageSbom({ root });
  const controlRef = componentRef('@qinglong/cluster-control', '3.0.0-alpha.0');
  const edge = document.dependencies.find((entry) => entry.ref === controlRef);
  edge.dependsOn = edge.dependsOn.slice(1);

  assert.throws(
    () => auditClusterImageSbom(document, { root }),
    /dependency edges.*reviewed runtime closure/,
  );
});

test('rejects an unexpected development component', () => {
  const document = createClusterImageSbom({ root });
  document.components.push({
    type: 'library',
    'bom-ref': componentRef('typescript', '5.9.3'),
    name: 'typescript',
    version: '5.9.3',
    purl: componentRef('typescript', '5.9.3'),
  });

  assert.throws(
    () => auditClusterImageSbom(document, { root }),
    /development component leaked/,
  );
});

test('rejects tampered locked component metadata', () => {
  const document = createClusterImageSbom({ root });
  const pg = document.components.find((component) => component.name === 'pg');
  pg.version = '8.21.0';

  assert.throws(
    () => auditClusterImageSbom(document, { root }),
    /component metadata differs/,
  );
});

test('rejects a missing or unreviewed runtime license', () => {
  const missing = createClusterImageSbom({ root, image: 'local' });
  delete missing.components[0].licenses;
  assert.throws(
    () => auditClusterImageSbom(missing, { root, image: 'local' }),
    /unreviewed license/,
  );

  const unreviewed = createClusterImageSbom({ root, image: 'local' });
  unreviewed.components[0].licenses = [{ license: { id: 'GPL-3.0-only' } }];
  assert.throws(
    () => auditClusterImageSbom(unreviewed, { root, image: 'local' }),
    /unreviewed license/,
  );
});

test('verifies a bounded package inventory against the SBOM', (t) => {
  const document = createClusterImageSbom({ root });
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-image-inventory-'),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  for (const component of document.components) {
    const packageDirectory = component.name.startsWith('@')
      ? path.join(temporaryRoot, ...component.name.split('/'))
      : path.join(temporaryRoot, component.name);
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: component.name,
        version: component.version,
      }),
    );
  }

  assert.equal(
    auditClusterImageSbom(document, {
      root,
      inventoryRoot: temporaryRoot,
    }).inventoryVerified,
    true,
  );

  const unexpected = path.join(temporaryRoot, 'unexpected');
  fs.mkdirSync(unexpected);
  fs.writeFileSync(
    path.join(unexpected, 'package.json'),
    JSON.stringify({ name: 'unexpected', version: '1.0.0' }),
  );
  assert.throws(
    () =>
      auditClusterImageSbom(clone(document), {
        root,
        inventoryRoot: temporaryRoot,
      }),
    /runtime image package inventory differs/,
  );
});
