// Stable panel integration and executable paths. Source folders may move independently.
module.exports = {
  'ql.js': {
    module: 'entrypoints/ql.js',
    method: 'qlMain',
  },
  'task.js': {
    module: 'entrypoints/task.js',
    method: 'taskMain',
  },
  'runner.js': {
    module: 'internal/execution/runner.js',
    method: 'runnerMain',
  },
  'remote.js': {
    module: 'entrypoints/remote.js',
    method: 'remoteMain',
  },
  'compat.js': {
    module: 'compatibility/legacy.js',
    method: 'compatibilityMain',
  },
  'startup.js': {
    module: 'compatibility/startup.js',
    method: 'startupMain',
  },
  'subscription-worker.js': {
    module: 'internal/subscription/worker.js',
    method: 'subscriptionWorker',
  },
  'main.js': {
    module: 'compatibility/main.js',
    method: null,
  },
  'index.js': {
    module: 'entrypoints/index.js',
    method: null,
  },
  'admin.js': {
    module: 'entrypoints/admin.js',
    method: null,
  },
  'container.js': {
    module: 'entrypoints/container.js',
    method: null,
  },
  'local/entrypoints.js': {
    module: 'internal/integration/entrypoints.js',
    method: null,
  },
  'local/cronEntrypoint.js': {
    module: 'internal/integration/cronEntrypoint.js',
    method: null,
  },
};
