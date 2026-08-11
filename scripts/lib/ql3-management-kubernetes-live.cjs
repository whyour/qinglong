#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { waitFor } = require('./ql3-k3s-docker-live.cjs');

function podReady(pod) {
  return Boolean(
    pod?.metadata?.deletionTimestamp === undefined &&
      pod?.status?.conditions?.some(
        (condition) =>
          condition.type === 'Ready' && condition.status === 'True',
      ),
  );
}

async function readyManagementPods(options) {
  const observed = await waitFor(options.description, 300_000, () => {
    const pods = options.fixture
      .kubectlJson([
        '-n',
        options.namespace,
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=' + options.deployment,
      ])
      .items.filter(
        (pod) =>
          podReady(pod) &&
          !(options.excludedUids ?? new Set()).has(pod.metadata.uid) &&
          (options.expectedGeneration === undefined ||
            pod.metadata.annotations?.['qinglong.io/identity-generation'] ===
              String(options.expectedGeneration)),
      );
    const nodes = new Set(pods.map((pod) => pod.spec.nodeName));
    return pods.length === 2 && nodes.size === 2
      ? {
          ready: true,
          value: pods.sort((left, right) =>
            left.metadata.name.localeCompare(right.metadata.name),
          ),
        }
      : {
          ready: false,
          fact: pods.length + ' Ready Pods on ' + nodes.size + ' nodes',
        };
  });
  return observed.value;
}

function patchManagementGeneration(options) {
  options.fixture.kubectl(
    [
      '-n',
      options.namespace,
      'patch',
      'deployment',
      options.deployment,
      '--type=merge',
      '-p',
      JSON.stringify({
        spec: {
          template: {
            metadata: {
              annotations: {
                'qinglong.io/identity-generation': String(options.generation),
                ...(options.annotations ?? {}),
              },
            },
          },
        },
      }),
    ],
    { capture: true, quiet: true },
  );
}

function waitManagementRollout(options) {
  options.fixture.kubectl([
    '-n',
    options.namespace,
    'rollout',
    'status',
    'deployment/' + options.deployment,
    '--timeout=5m',
  ]);
}

async function waitForTwoPreserved(options) {
  let minimumReady = Number.POSITIVE_INFINITY;
  const observed = await waitFor(options.description, 300_000, () => {
    const pods = options.fixture
      .kubectlJson([
        '-n',
        options.namespace,
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=' + options.deployment,
      ])
      .items.filter(
        (pod) => pod.metadata.deletionTimestamp === undefined,
      );
    const ready = pods.filter(podReady);
    minimumReady = Math.min(minimumReady, ready.length);
    const replacements = ready.filter(
      (pod) =>
        !options.excludedUids.has(pod.metadata.uid) &&
        pod.metadata.annotations?.['qinglong.io/identity-generation'] ===
          String(options.expectedGeneration),
    );
    const nodes = new Set(replacements.map((pod) => pod.spec.nodeName));
    return replacements.length === 2 && nodes.size === 2
      ? { ready: true, value: replacements }
      : {
          ready: false,
          fact:
            ready.length +
            ' ready, ' +
            replacements.length +
            ' replacements',
        };
  });
  assert.ok(
    minimumReady >= 2,
    'rollout availability dropped to ' + minimumReady,
  );
  return Object.freeze({ pods: observed.value, minimumReady });
}

function createManagementClientExecutor(options) {
  options.fixture.apply({
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
      name: options.serviceAccount,
      namespace: options.namespace,
    },
    automountServiceAccountToken: false,
  });
  return async function executeClient(definition, expected) {
    const input = definition.name + '-input';
    const clientConfig = {
      schemaVersion: 1,
      endpoint:
        'https://' +
        options.servername +
        ':' +
        String(options.port) +
        options.managementPath,
      servername: options.servername,
      caFile: '/tmp/ca.crt',
      clientCertificateFile: '/tmp/client.crt',
      clientPrivateKeyFile: '/tmp/client.key',
      requestTimeoutMs: 5_000,
    };
    options.fixture.create({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: input, namespace: options.namespace },
      immutable: true,
      type: 'Opaque',
      stringData: {
        'client.json': JSON.stringify(clientConfig) + '\n',
        'command.json': JSON.stringify(definition.command) + '\n',
        'assertion.jwt': definition.bearer,
        'ca.crt': options.ca,
        'client.crt': definition.clientCertificate,
        'client.key': definition.clientKey,
      },
    });
    options.fixture.create({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: definition.name,
        namespace: options.namespace,
        labels: {
          'app.kubernetes.io/name': options.appName,
          'app.kubernetes.io/component': options.component,
          'qinglong.io/execution-model': 'caller-driven',
        },
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 240,
        ttlSecondsAfterFinished: 600,
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/name': options.appName,
              'app.kubernetes.io/component': options.component,
              [options.networkPolicyLabel]: 'true',
              'qinglong.io/execution-model': 'caller-driven',
            },
          },
          spec: {
            serviceAccountName: options.serviceAccount,
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            restartPolicy: 'Never',
            hostAliases: [
              {
                ip: definition.target.status.podIP,
                hostnames: [options.servername],
              },
            ],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 10001,
              runAsGroup: 10001,
              fsGroup: 10001,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'client',
                image: options.adminImage,
                imagePullPolicy: 'Never',
                command: ['/bin/sh', '-c'],
                args: [
                  [
                    'set -eu',
                    'umask 077',
                    'cp /var/run/qinglong3/client/client.json /tmp/client.json',
                    'cp /var/run/qinglong3/client/command.json /tmp/command.json',
                    'cp /var/run/qinglong3/client/assertion.jwt /tmp/assertion.jwt',
                    'cp /var/run/qinglong3/client/ca.crt /tmp/ca.crt',
                    'cp /var/run/qinglong3/client/client.crt /tmp/client.crt',
                    'cp /var/run/qinglong3/client/client.key /tmp/client.key',
                    'chmod 600 /tmp/client.json /tmp/command.json ' +
                      '/tmp/assertion.jwt /tmp/ca.crt /tmp/client.crt ' +
                      '/tmp/client.key',
                    'set +e',
                    'attempt=0',
                    'while true; do',
                    '  attempt=$((attempt + 1))',
                    '  output="$(node ' +
                      options.clientCliPath +
                      ' --config=/tmp/client.json ' +
                      '--command=/tmp/command.json ' +
                      '--assertion=/tmp/assertion.jwt 2>&1)"',
                    '  status=$?',
                    '  if [ "$status" -eq 0 ] || { ! printf \'%s\' "$output" | ' +
                      'grep -q QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REQUEST_FAILED && ' +
                      '! printf \'%s\' "$output" | grep -q \'"statusCode":503\'; } || ' +
                      '[ "$attempt" -ge 60 ]; then',
                    '    break',
                    '  fi',
                    '  sleep 1',
                    'done',
                    'printf \'%s\\n\' "$output" > /dev/termination-log',
                    'printf \'%s\\n\' "$output"',
                    'exit "$status"',
                  ].join('\n'),
                ],
                terminationMessagePolicy: 'File',
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                resources: {
                  requests: { cpu: '10m', memory: '32Mi' },
                  limits: { cpu: '250m', memory: '128Mi' },
                },
                volumeMounts: [
                  { name: 'tmp', mountPath: '/tmp' },
                  {
                    name: 'input',
                    mountPath: '/var/run/qinglong3/client',
                    readOnly: true,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: 'tmp',
                emptyDir: { medium: 'Memory', sizeLimit: '4Mi' },
              },
              {
                name: 'input',
                secret: { secretName: input, defaultMode: 288 },
              },
            ],
          },
        },
      },
    });

    const completion = await waitFor(
      definition.name + ' completion',
      300_000,
      () => {
        const job = options.fixture.kubectlJson([
          '-n',
          options.namespace,
          'get',
          'job',
          definition.name,
        ]);
        const complete = job.status.conditions?.some(
          (condition) =>
            condition.type === 'Complete' && condition.status === 'True',
        );
        const failed = job.status.conditions?.some(
          (condition) =>
            condition.type === 'Failed' && condition.status === 'True',
        );
        return complete || failed
          ? { ready: true, value: { complete, failed } }
          : { ready: false, fact: JSON.stringify(job.status ?? {}) };
      },
    );
    const clientPod = (
      await waitFor(definition.name + ' terminal pod', 60_000, () => {
        const pods = options.fixture.kubectlJson([
          '-n',
          options.namespace,
          'get',
          'pods',
          '-l',
          'batch.kubernetes.io/job-name=' + definition.name,
        ]).items;
        return pods.length === 1 && pods[0].status.containerStatuses?.[0]
          ? { ready: true, value: pods[0] }
          : {
              ready: false,
              fact: 'observed ' + pods.length + ' client pods',
            };
      })
    ).value;
    assert.equal(clientPod.spec.automountServiceAccountToken, false);
    assert.equal(
      clientPod.spec.volumes.some((volume) =>
        volume.projected?.sources?.some(
          (source) => source.serviceAccountToken !== undefined,
        ),
      ),
      false,
    );
    assert.equal(
      options.fixture.kubectlJson([
        '-n',
        options.namespace,
        'get',
        'secret',
        input,
      ]).immutable,
      true,
    );
    const terminated =
      clientPod.status.containerStatuses?.[0]?.state?.terminated;
    assert.ok(
      terminated,
      options.description + ' client termination state is missing',
    );
    const message = terminated.message ?? '';
    assert.equal(message.includes(definition.bearer), false);
    assert.equal(message.includes(definition.clientKey), false);
    const output = JSON.parse(message.split('\n').filter(Boolean).at(-1));
    if (expected.statusCode === 200) {
      assert.equal(
        completion.value.complete,
        true,
        options.description +
          ' client unexpectedly failed: ' +
          JSON.stringify(output),
      );
      assert.equal(output.event, 'command_completed');
      assert.equal(output.result.operation, definition.command.operation);
      if (expected.resultStatus) {
        assert.ok(expected.resultStatus.includes(output.result.status));
      }
    } else {
      assert.equal(
        completion.value.failed,
        true,
        options.description +
          ' client unexpectedly succeeded: ' +
          JSON.stringify(output),
      );
      assert.equal(output.event, 'command_failed');
      assert.equal(output.statusCode, expected.statusCode);
      assert.equal(output.responseCode, expected.responseCode);
    }
    const result = Object.freeze({
      targetPod: definition.target.metadata.name,
      targetPodUid: definition.target.metadata.uid,
      targetNode: definition.target.spec.nodeName,
      statusCode: expected.statusCode,
      output,
    });
    options.fixture.kubectl(
      [
        '-n',
        options.namespace,
        'delete',
        'job/' + definition.name,
        'secret/' + input,
        '--wait=false',
      ],
      { capture: true, quiet: true },
    );
    return result;
  };
}

function podTcpProbe(options) {
  const script = [
    "const net=require('node:net');let finished=false;",
    'const socket=net.createConnection({host:process.argv[1],port:Number(process.argv[2])});',
    'const finish=(status)=>{if(finished)return;finished=true;socket.destroy();process.exitCode=status};',
    "socket.setTimeout(3000);socket.once('connect',()=>finish(0));",
    "socket.once('timeout',()=>finish(1));socket.once('error',()=>finish(1));",
  ].join('\n');
  return options.fixture.kubectl(
    [
      '-n',
      options.namespace,
      'exec',
      options.podName,
      '--',
      'node',
      '-e',
      script,
      options.host,
      String(options.port),
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
}

async function clientTcpProbe(options) {
  const labels = {
    'app.kubernetes.io/name': options.appName,
    ...(options.labelled
      ? { [options.networkPolicyLabel]: 'true' }
      : {}),
  };
  const script = [
    "const fs=require('node:fs');const net=require('node:net');let finished=false;let attempt=0;let socket;",
    'const maximum=Number(process.argv[3]);',
    "const finish=(message,status)=>{if(finished)return;finished=true;fs.writeFileSync('/dev/termination-log',message);socket?.destroy();process.exitCode=status};",
    "const retry=(reason)=>{socket.destroy();attempt+=1;if(attempt>=maximum){finish('denied:'+reason,1);return;}setTimeout(connect,500);};",
    "const connect=()=>{let settled=false;const failed=(reason)=>{if(settled)return;settled=true;retry(reason)};socket=net.createConnection({host:process.argv[1],port:Number(process.argv[2])});socket.setTimeout(3000);socket.once('connect',()=>{if(settled)return;settled=true;finish('connected',0)});socket.once('timeout',()=>failed('timeout'));socket.once('error',(error)=>failed(error.code||'error'));};",
    'connect();',
  ].join('\n');
  options.fixture.create({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: options.name, namespace: options.namespace },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 120,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'probe',
              image: options.adminImage,
              imagePullPolicy: 'Never',
              command: [
                'node',
                '-e',
                script,
                options.targetHost,
                String(options.port),
                String(options.expectedConnected ? 12 : 1),
              ],
              terminationMessagePolicy: 'File',
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: {
                requests: { cpu: '5m', memory: '16Mi' },
                limits: { cpu: '100m', memory: '64Mi' },
              },
            },
          ],
        },
      },
    },
  });
  const observed = await waitFor(
    options.name + ' completion',
    180_000,
    () => {
      const job = options.fixture.kubectlJson([
        '-n',
        options.namespace,
        'get',
        'job',
        options.name,
      ]);
      const complete = job.status.conditions?.some(
        (condition) =>
          condition.type === 'Complete' && condition.status === 'True',
      );
      const failed = job.status.conditions?.some(
        (condition) =>
          condition.type === 'Failed' && condition.status === 'True',
      );
      return complete || failed
        ? { ready: true, value: { complete, failed } }
        : { ready: false, fact: JSON.stringify(job.status ?? {}) };
    },
  );
  const probePod = (
    await waitFor(options.name + ' terminal pod', 30_000, () => {
      const pods = options.fixture.kubectlJson([
        '-n',
        options.namespace,
        'get',
        'pods',
        '-l',
        'batch.kubernetes.io/job-name=' + options.name,
      ]).items;
      const terminated =
        pods[0]?.status.containerStatuses?.[0]?.state?.terminated;
      return pods.length === 1 && terminated
        ? { ready: true, value: pods[0] }
        : { ready: false, fact: 'observed ' + pods.length + ' probe pods' };
    })
  ).value;
  const terminated = probePod.status.containerStatuses[0].state.terminated;
  const observation =
    options.name + ': ' + (terminated.message ?? 'no-message');
  assert.equal(
    observed.value.complete,
    options.expectedConnected,
    observation,
  );
  assert.equal(
    observed.value.failed,
    !options.expectedConnected,
    observation,
  );
  assert.equal(
    terminated.exitCode === 0,
    options.expectedConnected,
    observation,
  );
  if (options.expectedConnected) {
    assert.equal(terminated.message, 'connected');
  } else {
    assert.match(terminated.message ?? '', /^denied:/);
  }
  options.fixture.kubectl(
    [
      '-n',
      options.namespace,
      'delete',
      'job',
      options.name,
      '--wait=false',
    ],
    { capture: true, quiet: true },
  );
  return options.expectedConnected
    ? observed.value.complete
    : observed.value.failed;
}

module.exports = {
  clientTcpProbe,
  createManagementClientExecutor,
  patchManagementGeneration,
  podReady,
  podTcpProbe,
  readyManagementPods,
  waitForTwoPreserved,
  waitManagementRollout,
};
