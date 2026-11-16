// Keep the command's actual exit available until its SQLite transaction commits.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const idPattern = /^[a-z0-9-]{1,120}$/;

// A full data volume can still have room for a directory entry. In this format
// the empty file publishes the tuple atomically, including its execution-bound
// checksum. Keep the encoded name when moving it into a collector-private slot.
const metadataName = /^\.pending\.([a-z0-9-]{1,120})\.full-(\d{1,3}|SIG[A-Z0-9]+)-(\d{1,16})-([0-9a-f]{64})-([a-zA-Z0-9_]+)$/;

// The digest only guards disposal of legacy bytes. It cannot establish an exit.
const legacyCapture = /^\.pending\.([a-z0-9-]{1,120})\.l-([0-9a-f]{32})-[0-9a-f]{24}$/;
const claimName = /^\.claim(-bound)?\.([a-z0-9-]{1,120})\.[a-zA-Z0-9]{6}$/;

function metadataReceipt(file) {
  const name = path.basename(file);
  return metadataName.exec(name === '.pending.claimed' ? path.basename(path.dirname(file)) : name);
}

function storageFull(error) {
  const codes = [error?.code, error?.original?.code, error?.parent?.code];
  if (codes.some(code => ['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(code))) return true;
  const directory = receiptDirectory();
  if (directory && codes.includes('SQLITE_CANTOPEN')) {
    // SQLite maps a failed journal creation to CANTOPEN even when the kernel
    // reported ENOSPC. Other open failures keep their normal error semantics.
    try {
      const capacity = fs.statfsSync(path.dirname(directory));
      return capacity.bavail === 0 || (capacity.files > 0 && capacity.ffree === 0);
    } catch { return false; }
  }
  return false;
}

function receiptDirectory() {
  const data = process.env.QL_DATA_DIR || (process.env.QL_DIR && path.join(process.env.QL_DIR, 'data'));
  if (data) return path.join(data, 'db', 'cron-exits');
}

function receiptPath(id) {
  const directory = receiptDirectory();
  if (directory && typeof id === 'string' && idPattern.test(id)) return path.join(directory, id);
}

async function listReceiptFiles(directory, prefix) {
  if (!directory) return [];
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const id = entry.name.slice(prefix.length);
      if (idPattern.test(id)) files.push({ id, file: path.join(directory, entry.name) });
    }
    return files;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function publishedExits() {
  return (await listReceiptFiles(receiptDirectory(), '')).map(entry => entry.id);
}

// flock attaches to the open file description. The child inherits fd 3 and
// exits immediately. Closing the panel's handle (including on SIGKILL)
// releases the lock without leaving a lock file on a full volume.
async function lockClaim(handle, shared) {
  const run = (program, args) => new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(program, args, {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 || code === 1) resolve(code === 0);
      else reject(new Error(`Receipt directory lock failed (${signal || code})`));
    });
  });
  try {
    return await run('flock', ['-n', shared ? '-s' : '-x', '3']);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Python is also shipped with the task supervisor on minimal Linux images.
    const program = 'import fcntl,sys\ntry: fcntl.flock(3, fcntl.LOCK_NB | fcntl.LOCK_' +
      (shared ? 'SH' : 'EX') + ')\nexcept BlockingIOError: sys.exit(1)';
    return run('python3', ['-c', program]);
  }
}

// Move the current directory entry to a fresh, recoverable name outside the
// reusable claim directory. A writer can replace that entry without flock.
// Only the bytes actually captured by this attempt authorize its final unlink.
/** @param {string} id @param {string} file @param {{outcome: string, time: number}} [booked] */
async function retireLegacyFile(id, file, booked) {
  const directory = receiptDirectory();
  const sourceDir = path.dirname(file);
  const slot = path.basename(file);
  const bound = /^\.(pending|published)\./.test(slot) && !legacyCapture.test(slot);
  const metadata = metadataReceipt(file);
  const parent = claimName.exec(path.basename(sourceDir));
  const privateSlot = path.dirname(sourceDir) === directory &&
    (parent?.[2] === id && slot === (parent[1] ? '.pending.claimed' : 'receipt') ||
     metadata?.[1] === id && slot === '.pending.claimed');
  if (!directory || !idPattern.test(id)) return;
  const dbDir = path.dirname(directory);
  const localBin = path.join(directory, '.reclaim');
  const fromBin = sourceDir === dbDir || sourceDir === localBin;
  if (sourceDir !== directory && !privateSlot && !(fromBin && captureId(slot) === id)) return;

  const matches = exit => exit && !exit.namedExit && (exit.version === 1
    ? booked && exit.time === booked.time && (exit.signal ?? String(exit.code)) === booked.outcome
    : !bound);
  let handle, binHandle;
  try {
    if ((privateSlot || sourceDir === localBin) && process.platform === 'linux') {
      handle = await fs.promises.open(sourceDir, fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      if (privateSlot && !await lockClaim(handle, true)) return;
    }
    const source = handle ? `/proc/self/fd/${handle.fd}/${slot}` : file;
    // A canonical publication may only be readable after the move. For a
    // recovered copy, first avoid moving an unsettled witness on every scan.
    const previous = await readExit(id, source, file);
    if (slot !== id && !matches(previous)) return;
    const nonce = randomUUID();
    let name;
    if (metadata) {
      name = metadata[0].slice(0, -metadata[5].length) + 'r_' + nonce.replace(/-/g, '').slice(0, 16);
    } else if (bound || !previous || previous.version === 1) {
      name = `.pending.${id}.r-${nonce}`;
    } else {
      const digest = exitChecksum(id, previous.code, previous.signal, previous.time).slice(0, 32);
      name = `.pending.${id}.l-${digest}-${nonce.replace(/-/g, '').slice(0, 24)}`;
    }
    // The database directory is outside the writers' receipt namespace and
    // already exists even at zero free inodes. A separately mounted journal
    // requires a disposal directory on its own filesystem.
    let bin = sourceDir === localBin ? localBin : dbDir;
    const pinBin = async () => {
      binHandle = await fs.promises.open(localBin, fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      return process.platform === 'linux' ? `/proc/self/fd/${binHandle.fd}/${name}` : path.join(localBin, name);
    };
    let captured = path.join(bin, name);
    if (bin === localBin) captured = handle ? path.join(path.dirname(source), name) : await pinBin();
    try {
      await fs.promises.rename(source, captured);
    } catch (error) {
      if (error.code !== 'EXDEV' || bin === localBin) throw error;
      await fs.promises.mkdir(localBin, { mode: 0o700, recursive: true });
      bin = localBin;
      captured = await pinBin();
      await fs.promises.rename(source, captured);
    }
    const actual = await readExit(id, captured, path.join(bin, name));
    // An unreadable source offers no authority to discard unbound bytes.
    const sameExit = previous && actual && actual.version === previous.version &&
      actual.code === previous.code && actual.signal === previous.signal && actual.time === previous.time;
    if (matches(actual) && (sameExit || (!previous && actual.version === 1))) {
      await fs.promises.unlink(captured);
    } else if (actual !== undefined) {
      // A differing, torn or unreadable file is evidence for another pass.
      // Persist its new directory entry before releasing the original directory.
      if (binHandle) await binHandle.sync();
      else if (bin !== sourceDir || !handle) syncDirectory(bin);
      if (bin === localBin) syncDirectory(directory);
      if (handle) await handle.sync();
      else if (sourceDir !== bin) syncDirectory(sourceDir);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    if (binHandle) await binHandle.close();
    if (handle) await handle.close();
    if (privateSlot) await fs.promises.rmdir(sourceDir).catch(() => {});
  }
}

function captureId(name) {
  const marker = metadataName.exec(name);
  if (marker && /^r_[0-9a-f]{16}$/.test(marker[5])) return marker[1];
  const match = legacyCapture.exec(name) ??
    /^\.pending\.([a-z0-9-]{1,120})\.r-[0-9a-f-]{36}$/.exec(name);
  return match?.[1];
}

async function receiptEntries(directory) {
  try { return await fs.promises.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function retiringExits() {
  const dir = receiptDirectory();
  if (!dir) return [];
  const files = [];
  const bins = [path.dirname(dir)];
  for (const entry of await receiptEntries(dir)) {
    if (entry.isDirectory() && entry.name === '.reclaim') {
      bins.push(path.join(dir, entry.name));
      continue;
    }
    const claim = claimName.exec(entry.name);
    const metadata = metadataName.exec(entry.name);
    if ((claim || metadata) && entry.isDirectory()) {
      const directory = path.join(dir, entry.name);
      try { await fs.promises.rmdir(directory); continue; } catch (error) {
        if (error.code === 'ENOENT') continue;
      }
      files.push({ id: metadata ? metadata[1] : claim[2], file: path.join(directory, metadata || claim[1] ? '.pending.claimed' : 'receipt') });
      continue;
    }
    const match = metadata ?? /^\.(?:retiring|collecting)\.([a-z0-9-]{1,120})\.[0-9a-f-]{36}$/.exec(entry.name)
      ?? /^\.pending\.([a-z0-9-]{1,120})\.[a-z0-9_-]{1,64}$/.exec(entry.name)
      ?? /^\.published\.([a-z0-9-]{1,120})\.[0-9a-f]{64}$/.exec(entry.name);
    if (entry.isFile() && match) files.push({ id:match[1], file:path.join(dir,entry.name) });
  }
  for (const bin of bins) {
    for (const entry of await receiptEntries(bin)) {
      const id = entry.isFile() && captureId(entry.name);
      if (id) files.push({ id, file:path.join(bin,entry.name) });
    }
  }
  return files;
}

async function publishedScriptStarts() {
  const directory = process.env.QL_DIR && path.join(process.env.QL_DIR, '.tmp');
  try {
    return await listReceiptFiles(directory, 'cron-start-');
  } catch {
    // Optional entry instrumentation must not prevent exit recovery.
    return [];
  }
}

function validExit(code, signal, time) {
  return Number.isSafeInteger(time) && time > 0 && Number.isFinite(new Date(time).getTime()) &&
    ((Number.isInteger(code) && code >= 0 && code <= 255 && signal === null) ||
     (code === null && typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal)));
}

// The Python supervisor uses the same compact JSON array of ASCII values.
function exitChecksum(id, code, signal, time) {
  return createHash('sha256').update(JSON.stringify([id, code, signal, time])).digest('hex');
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeExit(id, code, signal, time) {
  if (!validExit(code, signal, time)) throw new TypeError('Invalid command exit receipt');
  const file = receiptPath(id);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const checksum = exitChecksum(id, code, signal, time);
  const receipt = JSON.stringify({ code, signal, time, version: 1, checksum });
  // Creation is the first durable observation. No data block is needed for
  // this witness. Keep the regular JSON publication for earlier readers.
  const directory = path.dirname(file);
  const prefix = '.pending.' + id + '.';
  const marker = prefix + 'full-' + (signal ?? code) + '-' + time + '-' + checksum + '-';
  const publish = (name, content) => {
    for (;;) {
      const target = path.join(directory, name + randomUUID().replace(/-/g, '').slice(0, 16));
      try {
        fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600, flush: Boolean(content) });
        return target;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  };
  publish(marker, '');
  // ext4 journals the empty inode and directory entry together. Also fence the
  // directory's own entry: another publisher may just have created it.
  syncDirectory(directory);
  syncDirectory(path.dirname(directory));
  try {
    if (fs.statfsSync(directory).bavail === 0) return;
    const source = publish(marker, receipt);
    try { fs.linkSync(source, file); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (error.code !== 'EEXIST') throw error;
      // A panel from before metadata receipts can still discover this retry.
      for (;;) {
        try { fs.linkSync(source, path.join(directory, prefix + randomUUID())); break; }
        catch (linkError) {
          if (linkError.code === 'ENOENT') break;
          if (linkError.code !== 'EEXIST') throw linkError;
        }
      }
    }
    // Older panels find the JSON only through this newly created link.
    syncDirectory(directory);
  } catch (error) {
    if (!storageFull(error)) throw error;
  }
}

function parseExit(id, value) {
  if (!value || !validExit(value.code, value.signal, value.time)) return null;
  const { code, signal, time, checksum, version } = value;
  if (version !== undefined || checksum !== undefined) {
    if (version !== 1 || checksum !== exitChecksum(id, code, signal, time)) return null;
  } else if (Object.keys(value).length !== 3) {
    return null;
  }
  return { code, signal, time, version };
}

// undefined means no publication. null means a result cannot yet be trusted.
async function readExit(id, file = receiptPath(id), publication = file) {
  if (!file) return;
  try {
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
      // Bound CPU and memory even if the damaged file is growing.
      const buffer = Buffer.alloc(1025);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size === buffer.length) return null;
      const metadata = metadataReceipt(publication);
      const bytes = buffer.toString('utf8', 0, size);
      let namedExit;
      if (metadata && metadata[1] === id && (await handle.stat()).isFile()) {
        const [, , outcome, end, checksum] = metadata;
        const signal = outcome.startsWith('SIG') ? outcome : null;
        const value = { code: signal ? null : Number(outcome), signal, time: Number(end), version: 1, checksum };
        // Both current publishers serialize in this order. Accept a torn body
        // only when every byte matches the tuple independently published by
        // the filename. Validate replacement files on their own bytes below.
        namedExit = parseExit(id, value);
        const json = JSON.stringify(value);
        if (json.startsWith(bytes)) {
          return namedExit && { ...namedExit, file, namedExit: undefined };
        }
      }
      const exit = parseExit(id, JSON.parse(bytes));
      const guard = legacyCapture.exec(path.basename(publication));
      if (guard && exit && exit.version !== 1 && (guard[1] !== id ||
          guard[2] !== exitChecksum(id, exit.code, exit.signal, exit.time).slice(0, 32))) return null;
      const conflictingName = exit?.version === 1 && namedExit && (exit.time !== namedExit.time ||
        exit.code !== namedExit.code || exit.signal !== namedExit.signal);
      return exit && { ...exit, file, namedExit: conflictingName ? namedExit : undefined };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
    if (error.code || error instanceof SyntaxError) return null;
    throw error;
  }
}

module.exports = { isLegacyCapture: file => legacyCapture.test(path.basename(file)), isMetadataReceipt: file => Boolean(metadataReceipt(file)), receiptPath, publishedExits, publishedScriptStarts, readExit, writeExit, validExit, storageFull, retireLegacyFile, retiringExits };

if (require.main === module) {
  const id = process.env.QL_TRIGGER_ID;
  const exit = parseExit(id, JSON.parse(process.argv[2]));
  if (!idPattern.test(id || '') || !exit) throw new Error('Invalid supervisor exit receipt');
  const { code, signal, time } = exit;
  // An older supervisor may only have delivered this tuple in its message.
  // Journal it before waiting for the SQLite writer or loading the panel.
  let journaled = false;
  if (exit.version === 1) {
    try { writeExit(id, code, signal, time); journaled = Boolean(receiptPath(id)); }
    catch (error) { console.error('[scheduler] Could not journal supervisor message:', error); }
  }
  // Development workers run TypeScript directly. Released panels load the
  // compiled module without starting another runtime on ordinary exits.
  if (!fs.existsSync(path.join(__dirname, 'triggerHistory.js'))) {
    process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
    require('ts-node/register/transpile-only');
  }
  const { triggerHistory } = require('./triggerHistory');
  triggerHistory().complete(id, signal || code !== 0 ? 'failed' : 'finished',
    signal, code, time, exit.version === 1 ? exit : 'legacy').catch(error => {
    if (journaled && storageFull(error)) return;
    console.error('[scheduler] Failed to settle orphaned command:', error);
    process.exitCode = storageFull(error) ? 75 : 1;
  }).finally(() => require('../data').sequelize.close());
}
