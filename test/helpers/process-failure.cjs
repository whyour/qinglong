// execFile errors contain the command (including credentials), stdout and
// stderr. Keep CI diagnostics useful without publishing any of those values.
function processFailure(error, runtime = process) {
  const stderr = String(error?.stderr || '');
  return {
    code: Number.isInteger(error?.code) ? error.code : null,
    signal: /^SIG[A-Z0-9]+$/.test(error?.signal || '') ? error.signal : null,
    killed: error?.killed === true,
    node: runtime.versions.node,
    arch: runtime.arch,
    fatal: {
      threadCreation:
        /uv_thread_create|pthread_create|Failed to start thread|failed to create[^\n]*thread/i.test(
          stderr,
        ),
      outOfMemory: /heap out of memory|Allocation failed|OutOfMemory/i.test(
        stderr,
      ),
      v8Check: /Check failed:|Fatal error in/i.test(stderr),
      heapBroker: /JSHeapBroker|compiler\/heap-refs/.test(stderr),
      compiler: /v8::internal::(?:compiler|maglev)|PersistentHandles/.test(
        stderr,
      ),
    },
  };
}

module.exports = { processFailure };
