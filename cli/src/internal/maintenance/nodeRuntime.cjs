// Node 24's ARMv6 JS compiler tiers can trap on ARM1176. Keep WebAssembly
// enabled for fetch/undici; --jitless disables their HTTP parser as well.
const armv6ServerArgs = Object.freeze([
  '--no-opt',
  '--no-sparkplug',
  '--no-maglev',
]);
function serverRuntimeArgs(runtime = process) {
  return runtime.arch === 'arm' &&
    Number(runtime.config.variables.arm_version) === 6 &&
    Number(runtime.versions.node.split('.')[0]) >= 24
    ? [...armv6ServerArgs]
    : [];
}

module.exports = { serverRuntimeArgs, armv6ServerArgs };
if (require.main === module)
  process.stdout.write(serverRuntimeArgs().join(' '));
