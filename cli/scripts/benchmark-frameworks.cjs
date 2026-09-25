const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const worker = path.join(__dirname, 'framework-prototype.cjs');
const kinds = ['baseline', 'native', 'commander', 'cac', 'yargs'];
if (process.env.QL_FRAMEWORK_INCLUDE_BUNDLE === '1') kinds.push('commander-bundled');
const samples = 21;
const measurements = {};
function run(kind, scenario) {
  const start = performance.now();
  const child = spawnSync(process.execPath, [worker, kind, scenario], { encoding:'utf8', timeout:30000 });
  const elapsed = performance.now() - start;
  if (child.status !== 0) throw Error(`${kind}/${scenario}: ${child.stderr}`);
  return { elapsed, ...JSON.parse(child.stdout) };
}
function summary(values) {
  const sorted = [...values].sort((a,b) => a-b);
  return { median: +sorted[Math.floor(sorted.length/2)].toFixed(3), p95:+sorted[Math.ceil(sorted.length*.95)-1].toFixed(3), samples:values.map(n=>+n.toFixed(3)) };
}
for (const scenario of ['parse', 'help']) {
  const groups = Object.fromEntries(kinds.map(kind => [kind, []]));
  for (let round = -2; round < samples; round++) {
    const offset = (round+2) % kinds.length;
    for (const kind of [...kinds.slice(offset), ...kinds.slice(0, offset)]) {
      const measurement = run(kind, scenario);
      if (round >= 0) groups[kind].push(measurement);
    }
  }
  for (const kind of kinds) {
    measurements[kind] ??= {};
    measurements[kind][scenario] = {
      wallMs:summary(groups[kind].map(item=>item.elapsed)),
      peakRssMiB:summary(groups[kind].map(item=>item.maxRSS/1024)),
    };
  }
}
for (const kind of kinds.filter(kind=>kind!=='baseline'))
  measurements[kind].warmParseMs = summary(Array.from({length:5},()=>run(kind, 'warm').perCallMs));

const external = createRequire(path.join(process.env.QL_FRAMEWORK_DEPS || '/tmp/ql-framework-eval', 'package.json'));
function bytes(directory) {
  return fs.readdirSync(directory, {withFileTypes:true}).reduce((sum, entry)=>sum+
    (entry.isDirectory() ? bytes(path.join(directory, entry.name)) : entry.isFile() ? fs.statSync(path.join(directory, entry.name)).size : 0),0);
}
function packageTree(name) {
  const seen = new Set();
  const packages = [];
  function visit(name, resolve) {
    let directory = path.dirname(resolve.resolve(name));
    while (!fs.existsSync(path.join(directory,'package.json'))) directory=path.dirname(directory);
    if (seen.has(directory)) return;
    seen.add(directory);
    const file = path.join(directory,'package.json');
    const metadata = JSON.parse(fs.readFileSync(file));
    packages.push({name:metadata.name, version:metadata.version, bytes:bytes(directory), engines:metadata.engines});
    for (const dependency of Object.keys(metadata.dependencies || {})) visit(dependency, createRequire(file));
  }
  visit(name, external);
  return { packages, packageCount:packages.length, installedFileBytes:packages.reduce((sum,p)=>sum+p.bytes,0) };
}
const dependencies = Object.fromEntries(['commander','cac','yargs'].map(kind=>[kind, packageTree(kind)]));
console.log(JSON.stringify({ measuredAt:new Date().toISOString(), node:process.version, platform:process.platform, arch:process.arch,
  cpu:os.cpus()[0]?.model, samples, warmups:2,
  method:'Fresh processes with rotating order; OS caches warm. Shared existing registry and validation scaffold; baseline loads that scaffold without parsing. All framework prototypes register current command specifications; native uses current parser. Successful task list arguments are asserted equivalent. Help layouts differ. Warm measurement rebuilds parser per call (20 warmups, 200 calls, five batches). No panel requests or script execution. Prototypes are not full compatibility replacements.',
  measurements, dependencies }, null, 2));
