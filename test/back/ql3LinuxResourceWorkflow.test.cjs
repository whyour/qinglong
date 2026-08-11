const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const workflowPath = path.resolve(
  __dirname,
  '../../.github/workflows/ql3-ci.yml',
);

test('runs each Linux resource tier on native x64 and arm64 Node 24 runners', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const resourceJob = workflow.match(
    /  linux-resource-envelopes:\n([\s\S]*?)\n  linux-resource-release-evidence:/,
  )?.[1];
  assert.ok(resourceJob, 'linux-resource-envelopes job is missing');
  assert.match(resourceJob, /runner: ubuntu-24\.04\n\s+arch: x64/);
  assert.match(resourceJob, /runner: ubuntu-24\.04-arm\n\s+arch: arm64/);
  assert.match(resourceJob, /node-version: '24\.18\.0'/);
  assert.match(resourceJob, /Verify native runner architecture/);
  for (const tier of [
    'router-stress-ci',
    'edge-release-ci',
    'cluster-control-ci',
  ]) {
    assert.equal(
      resourceJob.match(new RegExp(`--tier=${tier}`, 'g'))?.length,
      1,
      `${tier} must run exactly once per native matrix entry`,
    );
  }
});

test('keeps all resource containers fail-closed and exactly bounded', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const resourceJob = workflow.match(
    /  linux-resource-envelopes:\n([\s\S]*?)\n  linux-resource-release-evidence:/,
  )?.[1];
  assert.ok(resourceJob);
  assert.equal(resourceJob.match(/docker run --rm --read-only/g)?.length, 3);
  assert.equal(
    resourceJob.match(/--security-opt no-new-privileges/g)?.length,
    3,
  );
  assert.equal(resourceJob.match(/--user 65532:65532/g)?.length, 3);
  assert.equal(
    resourceJob.match(/--expected-arch=\$\{\{ matrix\.arch \}\}/g)?.length,
    3,
  );
  for (const expected of [
    '--memory=128m\n          --memory-swap=128m\n          --cpus=0.5\n          --pids-limit=64',
    '--memory=256m\n          --memory-swap=256m\n          --cpus=1\n          --pids-limit=128',
    '--memory=512m\n          --memory-swap=512m\n          --cpus=2\n          --pids-limit=256',
  ]) {
    assert.ok(
      resourceJob.includes(expected),
      `missing exact envelope ${expected}`,
    );
  }
});

test('uploads one strict source-bound evidence bundle per native architecture', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const resourceJob = workflow.match(
    /  linux-resource-envelopes:\n([\s\S]*?)\n  linux-resource-release-evidence:/,
  )?.[1];
  assert.ok(resourceJob);
  for (const tier of [
    'router-stress-ci',
    'edge-release-ci',
    'cluster-control-ci',
  ]) {
    assert.equal(
      resourceJob.match(
        new RegExp(
          `> "\\$\\{RUNNER_TEMP\\}/ql3-linux-resource-evidence/${tier}\\.json"`,
          'g',
        ),
      )?.length,
      1,
      `${tier} raw evidence must be captured exactly once`,
    );
    assert.match(
      resourceJob,
      new RegExp(
        `--${tier}="\\$\\{RUNNER_TEMP\\}/ql3-linux-resource-evidence/${tier}\\.json"`,
      ),
    );
  }
  assert.match(resourceJob, /--mode=bundle/);
  assert.match(resourceJob, /--repository="\$\{SOURCE_REPOSITORY\}"/);
  assert.match(resourceJob, /--revision="\$\{SOURCE_REVISION\}"/);
  assert.match(resourceJob, /--workflow="\$\{SOURCE_WORKFLOW\}"/);
  assert.match(resourceJob, /--run-id="\$\{SOURCE_RUN_ID\}"/);
  assert.match(resourceJob, /--run-attempt="\$\{SOURCE_RUN_ATTEMPT\}"/);
  assert.match(resourceJob, /--architecture="\$\{\{ matrix\.arch \}\}"/);
  assert.equal(
    resourceJob.match(
      /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g,
    )?.length,
    1,
  );
  assert.match(
    resourceJob,
    /name: ql3-linux-resource-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.arch \}\}/,
  );
  assert.match(resourceJob, /if-no-files-found: error/);
  assert.match(resourceJob, /overwrite: false/);
  assert.doesNotMatch(resourceJob, /continue-on-error/);
});

test('merges exact x64 and arm64 artifacts into one release evidence artifact', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const releaseJob = workflow.match(
    /  linux-resource-release-evidence:\n([\s\S]*?)\n  supply-chain:/,
  )?.[1];
  assert.ok(releaseJob, 'linux-resource-release-evidence job is missing');
  assert.match(releaseJob, /needs: linux-resource-envelopes/);
  assert.equal(
    releaseJob.match(
      /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/g,
    )?.length,
    2,
  );
  for (const architecture of ['x64', 'arm64']) {
    assert.match(
      releaseJob,
      new RegExp(
        `name: ql3-linux-resource-\\$\\{\\{ github\\.run_id \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}-${architecture}`,
      ),
    );
    assert.match(
      releaseJob,
      new RegExp(
        `path: \\$\\{\\{ runner\\.temp \\}\\}/ql3-linux-resource-evidence/${architecture}`,
      ),
    );
  }
  assert.match(releaseJob, /--mode=merge/);
  assert.match(
    releaseJob,
    /--x64="\$\{RUNNER_TEMP\}\/ql3-linux-resource-evidence\/x64\/x64\.json"/,
  );
  assert.match(
    releaseJob,
    /--arm64="\$\{RUNNER_TEMP\}\/ql3-linux-resource-evidence\/arm64\/arm64\.json"/,
  );
  assert.match(
    releaseJob,
    /name: ql3-linux-resource-release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.equal(
    releaseJob.match(
      /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g,
    )?.length,
    1,
  );
  assert.doesNotMatch(releaseJob, /pattern:|merge-multiple:|continue-on-error/);
});

test('does not duplicate the legacy edge-only budget in backend matrices', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const backendJob = workflow.match(
    /  backend:\n([\s\S]*?)\n  linux-resource-envelopes:/,
  )?.[1];
  assert.ok(backendJob);
  assert.doesNotMatch(backendJob, /ql3-linux-resource-gate/);
  assert.doesNotMatch(backendJob, /Enforce 256 MiB edge process budget/);
});
