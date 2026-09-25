process.channel.ref();
// Child fixture: real service startup pauses at a deterministic cancellation boundary.
const { createContext } = require('../../dist/local/context');
const { replaceAndReload } = require('../../dist/local/upgrade');
const { startPanel, stopPanel } = require('../../dist/local/operator');
const {
  withCommandCancellation,
  cancellableOperation,
  interruptedCode,
} = require('../../dist/local/cancellation');
const path = require('node:path');
const context = createContext({ root: process.env.TEST_ROOT }, process.env);
let starts = 0;
withCommandCancellation(async (signal) => {
  try {
    await cancellableOperation(signal, () =>
      replaceAndReload(
        context,
        [
          {
            source: path.join(context.root, 'staged'),
            target: context.paths.dir_static,
          },
        ],
        {
          stop: stopPanel,
          start: async (ctx) => {
            const result = await startPanel(ctx);
            if (++starts === 1) {
              const body = await require('./service-response.cjs')('new');
              process.send({ ready: true, pid: body.pid });
              if (!signal.aborted)
                await new Promise((resolve) =>
                  signal.addEventListener('abort', resolve, { once: true }),
                );
            }
            return result;
          },
        },
      ),
    );
    return 0;
  } catch (error) {
    if (!signal.aborted) console.error(error);
    return interruptedCode(signal) ?? 1;
  }
}).then((code) => {
  process.exitCode = code;
  process.disconnect();
});
