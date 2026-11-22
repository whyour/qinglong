// Observe the first executable location in the entry file. Preloads, the TS
// compiler and ESM dependency evaluation can all run before that location.
const { Session, url } = require('inspector');
const { pathToFileURL } = require('url');
const { writeFileSync } = require('fs');

module.exports = function observeScriptStart(entry, marker) {
  if (!entry || !marker || url()) return;
  const session = new Session();
  try {
    session.connect();
    const target = pathToFileURL(entry).href;
    session.post('Debugger.enable');
    session.post(
      'Debugger.setBreakpointByUrl',
      { url: target, lineNumber: 0 },
      (err, bp) => {
        if (err || !bp) {
          session.disconnect();
          return;
        }
        session.on('Debugger.paused', ({ params }) => {
          if (params.hitBreakpoints?.includes(bp.breakpointId)) {
            try {
              writeFileSync(marker, String(Date.now()), {
                flag: 'wx',
                mode: 0o600,
              });
            } catch {}
            session.disconnect();
          } else {
            session.post('Debugger.resume');
          }
        });
      },
    );
  } catch {
    try {
      session.disconnect();
    } catch {}
  }
};
