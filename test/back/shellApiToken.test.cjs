const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const apiFile = path.resolve(__dirname, '../../shell/api.sh');

const endpoints = {
  status: {
    method: 'PUT', url: /\/open\/crons\/status\?t=\d+$/,
    body: { ids: ['37'], status: '1', pid: '4321', log_path: 'task/run.log',
      last_execution_time: 1787004000, last_running_time: 90, exit_code: 0 },
    success: '', failure: (message) => message,
  },
  statistics: {
    method: 'POST', url: /\/open\/dashboard\/record$/,
    body: { ref_id: 37, code: 0, elapsed: 90 },
    success: '', failure: (message) => message,
  },
  add: {
    method: 'POST', url: /\/open\/crons\?t=\d+$/,
    body: { name: 'sample job', command: 'task job.py', schedule: '0 * * * *', sub_id: null },
    success: 'sample job -> 添加成功', failure: (message) => `sample job -> 添加失败(${message})`,
  },
  update: {
    method: 'PUT', url: /\/open\/crons\?t=\d+$/,
    body: { name: 'sample job', command: 'task job.py', schedule: '0 * * * *', id: '37' },
    success: 'sample job -> 更新成功', failure: (message) => `sample job -> 更新失败(${message})`,
  },
  command: {
    method: 'PUT', url: /\/open\/crons\?t=\d+$/,
    body: { command: 'task job.py', id: '37' },
    success: 'task job.py -> 更新成功', failure: (message) => `task job.py -> 更新失败(${message})`,
  },
  delete: {
    method: 'DELETE', url: /\/open\/crons\?t=\d+$/,
    body: [37, 38], success: '成功', failure: (message) => `失败(${message})`,
  },
  notify: {
    method: 'PUT', url: /\/open\/system\/notify\?t=\d+$/,
    body: { title: 'title', content: 'body' },
    success: '通知发送成功🎉', failure: (message) => `通知失败(${message})`,
  },
  find: {
    method: 'GET', url: /\/open\/crons\/detail\?log_path=task\/run.log&t=\d+$/,
    body: null, success: 'sample job', failure: () => '',
  },
  auth: {
    method: 'PUT', url: /\/open\/system\/auth\/reset\?t=\d+$/,
    body: { retries: 0 }, success: '重置登录错误次数成功🎉',
    failure: (message) => `重置登录错误次数失败(${message})`,
  },
};

function runCallback(endpoint, scenario) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-api-token-'));
  try {
    const tokenFile = path.join(directory, 'token.json');
    fs.writeFileSync(tokenFile, JSON.stringify({
      value: 'initial-token', expiration: Math.floor(Date.now() / 1000) + 3600,
    }));
    const child = spawnSync('bash', ['-c', `
      . "$API_FILE"
      create_token() {
        printf 'refresh\\n' >> "$CAPTURE"
        __ql_token__=fresh-token
        printf '{"value":"fresh-token","expiration":4102444800}' > "$file_auth_token"
      }
      case "$SCENARIO" in
        expired) printf '{"value":"initial-token","expiration":1}' > "$file_auth_token" ;;
        replaced) printf '{"value":"fresh-token","expiration":4102444800}' > "$file_auth_token" ;;
      esac
      curl() {
        local auth body url method arg
        while [[ $# -gt 0 ]]; do
          arg="$1"; shift
          case "$arg" in
            -H) [[ "$1" == Authorization:* ]] && auth="$1"; shift ;;
            --data-raw) body="$1"; shift ;;
            -X) method="$1"; shift ;;
            http:*) url="$arg" ;;
          esac
        done
        printf '%s\\n%s\\n%s\\n%s\\n' "$auth" "$method" "$url" "\${body:-null}" >> "$CAPTURE"
        if [[ "$SCENARIO" == forbidden ]]; then
          printf '{"code":403,"message":"forbidden"}'
        elif [[ "$SCENARIO" == unavailable ]]; then
          printf '{"code":500,"message":"unavailable"}'
        elif [[ "$SCENARIO" == persistent || ( "$SCENARIO" != valid && "$auth" != 'Authorization: Bearer fresh-token' ) ]]; then
          printf '{"code":401,"message":"Token 已失效"}'
        else
          printf '{"code":200,"data":{"name":"sample job"}}'
        fi
      }
      t() { printf "$@"; }
      case "$ENDPOINT" in
        status) update_cron '"37"' 1 4321 'task/run.log' 1787004000 90 0 execution-37 ;;
        statistics) record_cron_stat 37 0 90 ;;
        add) add_cron_api '0 * * * *' 'task job.py' 'sample job' ;;
        update) update_cron_api '0 * * * *' 'task job.py' 'sample job' 37 ;;
        command) update_cron_command_api 'task job.py' 37 ;;
        delete) del_cron_api '37,38' ;;
        notify) notify_api title body ;;
        find) find_cron_api 'log_path=task/run.log' ;;
        auth) update_auth_config '"retries":0' '重置登录错误次数' ;;
      esac
    `], {
      env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH}`, API_FILE: apiFile, file_auth_token: tokenFile,
        CAPTURE: path.join(directory, 'requests'), SCENARIO: scenario,
        ENDPOINT: endpoint, ql_port: '5700' },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const lines = fs.readFileSync(path.join(directory, 'requests'), 'utf8').trim().split('\n');
    const refreshes = lines.filter((line) => line === 'refresh').length;
    const requests = lines.filter((line) => line !== 'refresh');
    const captures = [];
    for (let i = 0; i < requests.length; i += 4) {
      captures.push({ auth: requests[i], method: requests[i + 1],
        url: requests[i + 2], body: JSON.parse(requests[i + 3]) });
    }
    return { output: child.stdout, refreshes, captures };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const [endpoint, expected] of Object.entries(endpoints)) {
  for (const scenario of ['valid', 'expired', 'replaced', 'rejected', 'persistent', 'forbidden', 'unavailable']) {
    test(`${endpoint} API handles ${scenario} token without unbounded retries`, () => {
      const { output, refreshes, captures } = runCallback(endpoint, scenario);
      const retries = ['rejected', 'persistent'].includes(scenario);
      assert.equal(captures.length, retries ? 2 : 1);
      assert.equal(refreshes, ['expired', 'rejected', 'persistent'].includes(scenario) ? 1 : 0);
      for (const capture of captures) {
        assert.deepEqual(capture.body, expected.body);
        assert.equal(capture.method, expected.method);
        assert.match(capture.url, expected.url);
      }
      if (['expired', 'replaced', 'rejected'].includes(scenario)) {
        assert.equal(captures.at(-1).auth, 'Authorization: Bearer fresh-token');
      }
      const error = scenario === 'persistent' ? 'Token 已失效'
        : scenario === 'forbidden' ? 'forbidden' : scenario === 'unavailable' ? 'unavailable' : '';
      assert.equal(output.trim(), error ? expected.failure(error) : expected.success);
    });
  }
}
