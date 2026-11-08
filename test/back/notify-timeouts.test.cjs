const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process');

const notifyFile = path.resolve(
  process.env.NOTIFY_PY_PATH || 'sample/notify.py',
);
const source = fs.readFileSync(notifyFile, 'utf8');

function httpCalls(text) {
  const calls = [];
  const pattern = /requests\.(?:get|post|request)\s*\(/g;
  let match;
  while ((match = pattern.exec(text))) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    calls.push(text.slice(match.index, end + 1));
  }
  return calls;
}

test('sample/notify.py sends every HTTP request with a timeout', () => {
  const calls = httpCalls(source);
  assert.ok(
    calls.length >= 27,
    `expected at least 27 HTTP calls, got ${calls.length}`,
  );
  const missing = calls.filter((call) => !/\btimeout\s*=/.test(call));
  assert.deepEqual(missing, []);
});

test('notify.send returns after a bounded wait when a channel hangs', () => {
  const script = `
import os, sys, time, types
requests = types.ModuleType("requests")
requests.get = requests.post = requests.request = lambda *a, **k: None
sys.modules["requests"] = requests
sys.path.insert(0, ${JSON.stringify(path.dirname(notifyFile))})
os.environ.pop("QL_DIR", None)
import notify
notify.NOTIFY_JOIN_TIMEOUT = 1
notify.push_config = {key: "" for key in notify.push_config}
notify.push_config["HITOKOTO"] = False
notify.push_config["CONSOLE"] = True
def hang(*args, **kwargs):
    time.sleep(60)
notify.console = hang
start = time.monotonic()
notify.send("title", "content")
elapsed = time.monotonic() - start
assert elapsed < 5, elapsed
print("elapsed=%.2f" % elapsed)
`;
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['-'], {
    input: script,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, QL_DIR: '' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /elapsed=/);
});
