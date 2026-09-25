const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const entry = path.resolve(__dirname, '../dist/index.js');
const samples = 9;
function measure(args) {
  const elapsed = [], rss = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now();
    const child = spawnSync(process.execPath, ['-e', 'process.on("beforeExit",()=>process.stderr.write(JSON.stringify(process.resourceUsage())));' + args], { encoding: 'utf8' });
    if (child.status !== 0) throw new Error('Benchmark child failed. Build CLI first.');
    elapsed.push(performance.now() - start);
    rss.push(JSON.parse(child.stderr).maxRSS / 1024);
  }
  elapsed.sort((a, b) => a - b); rss.sort((a, b) => a - b);
  return { medianMs: Number(elapsed[4].toFixed(2)), p95Ms: Number(elapsed[8].toFixed(2)), medianPeakRssMiB: Number(rss[4].toFixed(2)) };
}
function artifactBytes(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => total + (entry.isDirectory() ? artifactBytes(path.join(directory, entry.name)) : fs.statSync(path.join(directory, entry.name)).size), 0);
}
const baseline = measure('');
const help = measure(`process.argv=[process.execPath,${JSON.stringify(entry)},"--help"];require(${JSON.stringify(entry)});`);
process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, samples, baseline, help, incrementalMedianMs: Number((help.medianMs - baseline.medianMs).toFixed(2)), incrementalPeakRssMiB: Number((help.medianPeakRssMiB - baseline.medianPeakRssMiB).toFixed(2)), distBytesIncludingSourceMaps: artifactBytes(path.dirname(entry)) }, null, 2) + '\n');
