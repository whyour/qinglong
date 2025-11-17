const Module = require('module');
const path = require('path');
const fs = require('fs');

// Get the QL_DIR and data directory paths
const qlDir = process.env.QL_DIR || path.join(__dirname, '../../');
let dataDir = process.env.QL_DATA_DIR || path.join(qlDir, 'data');

// Remove trailing slash if present
dataDir = dataDir.replace(/\/$/, '');

// Normalize paths to avoid bypassing with relative paths or symlinks
const normalizedQlDir = fs.existsSync(qlDir) ? fs.realpathSync(qlDir) : path.resolve(qlDir);
const normalizedDataDir = fs.existsSync(dataDir) ? fs.realpathSync(dataDir) : path.resolve(dataDir);

// Protected directories - no write access allowed
const protectedPaths = [
  path.join(normalizedQlDir, 'back'),
  path.join(normalizedQlDir, 'src'),
  path.join(normalizedQlDir, 'shell'),
  path.join(normalizedQlDir, 'sample'),
  path.join(normalizedQlDir, 'node_modules'),
  path.join(normalizedDataDir, 'config'),
  path.join(normalizedDataDir, 'db'),
];

// Allowed write directories - scripts can write here
const allowedWritePaths = [
  path.join(normalizedDataDir, 'scripts'),
  path.join(normalizedDataDir, 'log'),
  path.join(normalizedDataDir, 'repo'),
  path.join(normalizedDataDir, 'raw'),
  path.join(normalizedQlDir, '.tmp'),
  '/tmp',
];

// Check if sandboxing is enabled (default: true)
const sandboxEnabled = process.env.QL_DISABLE_SANDBOX !== 'true';

function isPathProtected(targetPath) {
  if (!sandboxEnabled) {
    return false;
  }

  try {
    // Resolve to absolute path and follow symlinks
    const resolvedPath = fs.realpathSync.native ? 
      fs.realpathSync.native(targetPath) : 
      path.resolve(targetPath);
    
    // Check if path is in a protected directory
    for (const protectedPath of protectedPaths) {
      if (resolvedPath.startsWith(protectedPath + path.sep) || resolvedPath === protectedPath) {
        // Check if it's in an allowed subdirectory
        const isInAllowedPath = allowedWritePaths.some(allowedPath => 
          resolvedPath.startsWith(allowedPath + path.sep) || resolvedPath === allowedPath
        );
        
        if (!isInAllowedPath) {
          return true;
        }
      }
    }
    
    // Also check if trying to write outside data/scripts without being in allowed paths
    const isInQlDir = resolvedPath.startsWith(normalizedQlDir + path.sep) || resolvedPath === normalizedQlDir;
    const isInDataDir = resolvedPath.startsWith(normalizedDataDir + path.sep) || resolvedPath === normalizedDataDir;
    
    if (isInQlDir || isInDataDir) {
      const isInAllowedPath = allowedWritePaths.some(allowedPath => 
        resolvedPath.startsWith(allowedPath + path.sep) || resolvedPath === allowedPath
      );
      
      if (!isInAllowedPath) {
        return true;
      }
    }
    
    return false;
  } catch (err) {
    // If path doesn't exist yet, check parent directory
    const parentPath = path.dirname(targetPath);
    if (parentPath !== targetPath) {
      return isPathProtected(parentPath);
    }
    return false;
  }
}

function createSecurityError(operation, targetPath) {
  const err = new Error(
    `Security Error: Script attempted to ${operation} protected path: ${targetPath}\n` +
    `Scripts are only allowed to write to: ${allowedWritePaths.join(', ')}`
  );
  err.code = 'EACCES';
  return err;
}

// Store original fs methods
const originalFS = {};
const writeOperations = [
  'writeFile', 'writeFileSync',
  'appendFile', 'appendFileSync',
  'mkdir', 'mkdirSync',
  'rmdir', 'rmdirSync',
  'unlink', 'unlinkSync',
  'rm', 'rmSync',
  'rename', 'renameSync',
  'copyFile', 'copyFileSync',
  'chmod', 'chmodSync',
  'chown', 'chownSync',
  'link', 'linkSync',
  'symlink', 'symlinkSync',
  'truncate', 'truncateSync',
  'utimes', 'utimesSync',
];

// Wrap fs methods
for (const method of writeOperations) {
  if (fs[method]) {
    originalFS[method] = fs[method];
  }
}

function wrapFsMethod(method, isSync) {
  return function(...args) {
    const targetPath = args[0];
    
    if (isPathProtected(targetPath)) {
      const err = createSecurityError(method, targetPath);
      if (isSync) {
        throw err;
      } else {
        const callback = args[args.length - 1];
        if (typeof callback === 'function') {
          process.nextTick(() => callback(err));
          return;
        }
        throw err;
      }
    }
    
    // For rename/copy operations, check destination too
    if ((method.startsWith('rename') || method.startsWith('copy')) && args[1]) {
      if (isPathProtected(args[1])) {
        const err = createSecurityError(method, args[1]);
        if (isSync) {
          throw err;
        } else {
          const callback = args[args.length - 1];
          if (typeof callback === 'function') {
            process.nextTick(() => callback(err));
            return;
          }
          throw err;
        }
      }
    }
    
    return originalFS[method].apply(fs, args);
  };
}

// Apply wrappers
if (sandboxEnabled) {
  for (const method of writeOperations) {
    if (fs[method]) {
      const isSync = method.endsWith('Sync');
      fs[method] = wrapFsMethod(method, isSync);
    }
  }

  // Wrap createWriteStream
  originalFS.createWriteStream = fs.createWriteStream;
  fs.createWriteStream = function(targetPath, options) {
    if (isPathProtected(targetPath)) {
      throw createSecurityError('createWriteStream', targetPath);
    }
    return originalFS.createWriteStream.call(fs, targetPath, options);
  };

  // Wrap promises API if it exists
  if (fs.promises) {
    const promisesOriginal = {};
    const promisesMethods = [
      'writeFile', 'appendFile', 'mkdir', 'rmdir', 'unlink', 'rm',
      'rename', 'copyFile', 'chmod', 'chown', 'link', 'symlink',
      'truncate', 'utimes',
    ];

    for (const method of promisesMethods) {
      if (fs.promises[method]) {
        promisesOriginal[method] = fs.promises[method];
        fs.promises[method] = async function(...args) {
          const targetPath = args[0];
          
          if (isPathProtected(targetPath)) {
            throw createSecurityError(method, targetPath);
          }
          
          // For rename/copy operations, check destination too
          if ((method === 'rename' || method === 'copyFile') && args[1]) {
            if (isPathProtected(args[1])) {
              throw createSecurityError(method, args[1]);
            }
          }
          
          return promisesOriginal[method].apply(fs.promises, args);
        };
      }
    }
  }
}

// Wrap child_process to prevent sandbox bypass via subprocesses
let childProcessWrapped = false;
if (sandboxEnabled) {
  // We need to get child_process before wrapping Module.prototype.require
  const childProcess = require('child_process');
  const originalSpawn = childProcess.spawn;
  const originalExec = childProcess.exec;
  const originalExecSync = childProcess.execSync;
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  const originalFork = childProcess.fork;

  // Helper to ensure NODE_OPTIONS and PYTHONPATH are set for subprocesses
  function ensureSandboxEnv(options = {}) {
    const env = { ...process.env, ...options.env };
    
    // Ensure NODE_OPTIONS includes the sandbox
    const sandboxPreload = path.join(__dirname, 'sandbox.js');
    if (!env.NODE_OPTIONS) {
      env.NODE_OPTIONS = '';
    }
    if (!env.NODE_OPTIONS.includes(sandboxPreload)) {
      env.NODE_OPTIONS = `-r ${sandboxPreload} ${env.NODE_OPTIONS}`.trim();
    }
    
    // Ensure PYTHONPATH includes the sandbox directory
    if (!env.PYTHONPATH) {
      env.PYTHONPATH = '';
    }
    if (!env.PYTHONPATH.includes(__dirname)) {
      env.PYTHONPATH = `${__dirname}:${env.PYTHONPATH}`;
    }
    
    return { ...options, env };
  }

  // Wrap spawn
  childProcess.spawn = function(...args) {
    if (args[2]) {
      args[2] = ensureSandboxEnv(args[2]);
    } else if (args.length >= 3) {
      args[2] = ensureSandboxEnv({});
    }
    return originalSpawn.apply(childProcess, args);
  };

  // Wrap exec
  childProcess.exec = function(...args) {
    const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    const optionsIndex = callback ? args.length - 2 : args.length - 1;
    
    if (args[optionsIndex] && typeof args[optionsIndex] === 'object') {
      args[optionsIndex] = ensureSandboxEnv(args[optionsIndex]);
    } else if (optionsIndex > 0) {
      args.splice(optionsIndex, 0, ensureSandboxEnv({}));
    }
    return originalExec.apply(childProcess, args);
  };

  // Wrap execSync
  childProcess.execSync = function(...args) {
    if (args[1]) {
      args[1] = ensureSandboxEnv(args[1]);
    } else {
      args[1] = ensureSandboxEnv({});
    }
    return originalExecSync.apply(childProcess, args);
  };

  // Wrap execFile
  childProcess.execFile = function(...args) {
    const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    const optionsIndex = callback ? args.length - 2 : args.length - 1;
    
    if (args[optionsIndex] && typeof args[optionsIndex] === 'object') {
      args[optionsIndex] = ensureSandboxEnv(args[optionsIndex]);
    } else if (optionsIndex > 1) {
      args.splice(optionsIndex, 0, ensureSandboxEnv({}));
    }
    return originalExecFile.apply(childProcess, args);
  };

  // Wrap execFileSync
  childProcess.execFileSync = function(...args) {
    if (args[2]) {
      args[2] = ensureSandboxEnv(args[2]);
    } else if (args.length >= 3) {
      args[2] = ensureSandboxEnv({});
    }
    return originalExecFileSync.apply(childProcess, args);
  };

  // Wrap fork
  childProcess.fork = function(...args) {
    if (args[2]) {
      args[2] = ensureSandboxEnv(args[2]);
    } else if (args.length >= 3) {
      args[2] = ensureSandboxEnv({});
    }
    return originalFork.apply(childProcess, args);
  };
  
  childProcessWrapped = true;
}

// Prevent requiring the original fs or child_process modules to bypass sandbox
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  const module = originalRequire.apply(this, arguments);
  
  // Return wrapped fs module
  if (id === 'fs' || id === 'node:fs') {
    return fs;
  }
  
  // For child_process, we already wrapped it above, so just return it
  // (no need to re-require as that would cause recursion)
  
  return module;
};

module.exports = {
  sandboxEnabled,
  isPathProtected,
  protectedPaths,
  allowedWritePaths,
};
