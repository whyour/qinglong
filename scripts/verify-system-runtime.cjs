const { spawnSync } = require('node:child_process');
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C' };
const cases = [
  ['ssh', '/usr/bin/ssh', ['-V'], /OpenSSH_/],
  ['curl', '/usr/bin/curl', ['--version'], /^curl\s+\d/m],
  ['openssl', '/usr/bin/openssl', ['version'], /^OpenSSL\s+\d/m],
  ['pythonSsl', 'python3', ['-c', 'import ssl;print("QA_SSL_IMPORT_OK")'], /^QA_SSL_IMPORT_OK\s*$/m],
];
const checks = {};
for (const [name, command, args, marker] of cases) {
  const r = spawnSync(command, args, { env, encoding: 'utf8', timeout: 15000 });
  const markerPresent = marker.test(String(r.stdout || '') + String(r.stderr || ''));
  const signal = ['SIGSEGV', 'SIGTERM', 'SIGKILL', 'SIGILL', 'SIGABRT'].includes(r.signal)
    ? r.signal : r.signal ? 'OTHER' : null;
  checks[name] = { exitCode: r.status, signal, executionError: !!r.error, markerPresent,
    pass: r.status === 0 && !r.signal && !r.error && markerPresent };
}
const pass = Object.values(checks).every(r => r.pass);
console.log(JSON.stringify({ gate: 'runtime-system-tools', pass, checks }));
process.exitCode = pass ? 0 : 1;
