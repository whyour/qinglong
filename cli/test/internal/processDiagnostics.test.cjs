const test = require('node:test');
const assert = require('node:assert/strict');
const { runProcess, checkedProcess } = require('../../dist/internal/runtime/process');

for (const language of ['zh', 'en', 'unsupported']) {
  test(`subprocess failures localize and reap failed writers: ${language}`, async () => {
    const env = { QL_LANG: language };
    const expected = (zh, en) => (language === 'en' ? en : zh);
    await assert.rejects(
      runProcess('/nonexistent/ql-fixture-program', [], { env }),
      expected(/无法启动必要的可执行程序/, /Cannot start required executable/),
    );
    await assert.rejects(
      checkedProcess(
        process.execPath,
        ['-e', 'process.exitCode=7', 'private-argument'],
        { env },
      ),
      (error) => {
        assert.equal(error.exitCode, 1);
        assert.match(error.message, expected(/退出码 7/, /exit 7/));
        assert.doesNotMatch(error.message, /private-argument/);
        return true;
      },
    );
    for (const overflow of [false, true]) {
      let pid;
      await assert.rejects(
        runProcess(
          process.execPath,
          [
            '-e',
            'process.stderr.write(String(process.pid)); setTimeout(()=>{process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)},50)',
          ],
          {
            env,
            capture: overflow,
            maxCaptureBytes: 16,
            stderrOutput: (chunk) => {
              pid = Number(chunk.toString());
            },
            output: () => {
              throw undefined;
            },
          },
        ),
        overflow
          ? expected(/捕获上限/, /capture limit/)
          : expected(/输出写入失败/, /output sink failed/),
      );
      assert.ok(Number.isSafeInteger(pid) && pid > 1);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    const original = new Error('caller sink error');
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'console.log("output")'], {
        env,
        output: () => {
          throw original;
        },
      }),
      (error) => error === original,
    );
  });
}
