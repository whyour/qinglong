// Reproducible storage comparison, without touching actual script history.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
for (const file of ['sample/notify.js', 'shell/task.sh']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const versions = Array.from({ length: 20 }, (_, i) => ({
    content: source + '\n// edit ' + i,
  }));
  const raw = Buffer.from(JSON.stringify(versions));
  const strategies = {
    gzipSeparate: () =>
      versions.reduce(
        (sum, version) => sum + zlib.gzipSync(version.content).length,
        0,
      ),
    gzipBundle: () => zlib.gzipSync(raw).length,
    brotliBundle: () =>
      zlib.brotliCompressSync(raw, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
        },
      }).length,
  };
  for (const [strategy, compress] of Object.entries(strategies)) {
    const start = performance.now();
    const bytes = compress();
    console.log(
      JSON.stringify({
        file,
        strategy,
        rawBytes: raw.length,
        bytes,
        ms: +(performance.now() - start).toFixed(2),
      }),
    );
  }
}
