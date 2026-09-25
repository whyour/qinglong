const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const before = process.env.QL_CLI_BEFORE;
if (!before || !path.isAbsolute(before)) throw Error('Set QL_CLI_BEFORE to an absolute pre-refactor dist directory.');
const after = path.resolve(__dirname, '../dist');
const samples = 21;
const scenarios = [
  ['root-help', ['--help','--json']],
  ['api-help', ['task','list','--help','--json']],
  ['runner-help', ['task','exec','--help','--json']],
];
const results = [];
for (const [name, args] of scenarios) {
  const values = {before:[], after:[]};
  for (let round = -2; round < samples; round++) {
    for (const kind of round % 2 ? ['before','after'] : ['after','before']) {
      const start = performance.now();
      const child = spawnSync(process.execPath, [path.join(kind === 'before' ? before : after, 'ql.js'), ...args], {
        encoding:'utf8', env:{PATH:process.env.PATH, QL_LANG:'en'}, timeout:10000,
      });
      const elapsed = performance.now() - start;
      if (child.status !== 0 || !JSON.parse(child.stdout).data.help) throw Error(child.stderr || 'Invalid help');
      if (round >= 0) values[kind].push(elapsed);
    }
  }
  const summary = {};
  for (const [kind, times] of Object.entries(values)) {
    const sorted = [...times].sort((a,b)=>a-b);
    summary[kind] = {medianMs:+sorted[10].toFixed(3),p95Ms:+sorted[19].toFixed(3),samplesMs:times.map(n=>+n.toFixed(3))};
  }
  results.push({name,args,...summary});
}
const crypto = require('node:crypto');
function snapshot(directory) {
  const files = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file = path.join(dir,entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files[path.relative(directory,file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  visit(directory);
  return files;
}
console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,samples,warmups:2,
  method:'Real ql entrypoints, fresh processes, alternating order, warm filesystem caches. Help paths only: no API request or user script execution.',
  results,snapshots:{before:snapshot(before),after:snapshot(after)}},null,2));
