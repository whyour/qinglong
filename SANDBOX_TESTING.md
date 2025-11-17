# Filesystem Sandbox Testing

This document describes how to test the filesystem sandbox feature that protects Qinglong from malicious scripts.

## The Vulnerability (Before Fix)

The original issue demonstrated that a malicious script could modify critical system files:

```javascript
const fs = require("fs")
const path = require("path")
fs.writeFileSync(path.join(__dirname, "..", "..", 'config', 'task_after.sh'), `echo 123`)
```

This would allow the script to inject code that runs after every other script, compromising the entire system.

## The Fix

The sandbox intercepts filesystem operations and blocks writes to protected directories:

### Protected Directories
- `/back` - Backend code
- `/src` - Frontend code
- `/shell` - Shell scripts
- `/sample` - Sample files
- `/node_modules` - Dependencies
- `/data/config` - Configuration files (including task_after.sh, task_before.sh)
- `/data/db` - Database files

### Allowed Directories
- `/data/scripts` - User scripts
- `/data/log` - Logs
- `/data/repo` - Repositories
- `/data/raw` - Raw data
- `/.tmp` and `/tmp` - Temporary files

## Testing the Fix

### Quick Test

Run the exploit script to verify it's blocked:

```bash
cd /home/runner/work/qinglong/qinglong
export QL_DIR=$(pwd)
export QL_DATA_DIR=$(pwd)/data

# Try the exploit
cat > data/scripts/test_exploit.js << 'EOF'
const fs = require("fs");
const path = require("path");
try {
  fs.writeFileSync(path.join(__dirname, "..", "..", 'config', 'task_after.sh'), `echo 123`);
  console.log("❌ VULNERABILITY: Exploit succeeded!");
  process.exit(1);
} catch (error) {
  if (error.code === 'EACCES') {
    console.log("✅ SECURE: Exploit blocked!");
    process.exit(0);
  }
  throw error;
}
EOF

NODE_OPTIONS="-r ./shell/preload/sandbox.js" node data/scripts/test_exploit.js
```

Expected output: `✅ SECURE: Exploit blocked!`

### Comprehensive Testing

The repository includes comprehensive tests:

1. **Node.js Tests**: Verify that Node.js scripts cannot write to protected paths
2. **Python Tests**: Verify that Python scripts cannot write to protected paths
3. **Allowed Writes**: Verify that legitimate writes still work
4. **Disable Option**: Verify that the sandbox can be disabled when needed

## Configuration

### Enable Sandbox (Default)

The sandbox is enabled by default. No configuration needed.

### Disable Sandbox (Not Recommended)

To disable the sandbox:

```bash
export QL_DISABLE_SANDBOX=true
```

**Warning**: Disabling the sandbox removes all filesystem protections and allows scripts to modify any file, including critical system files.

## How It Works

### Node.js
- Loads `shell/preload/sandbox.js` before script execution
- Wraps `fs` module methods (writeFile, appendFile, mkdir, unlink, etc.)
- Checks paths before allowing write operations
- Returns EACCES error for protected paths

### Python
- Loads `shell/preload/sandbox.py` before script execution  
- Wraps `builtins.open()` for write modes
- Wraps `os` module functions (remove, mkdir, rename, etc.)
- Wraps `shutil` operations (rmtree, copy, move, etc.)
- Wraps `pathlib.Path` methods (write_text, mkdir, unlink, etc.)
- Raises PermissionError for protected paths

## Security Impact

This fix prevents:
- ✅ Modification of task_before.sh and task_after.sh
- ✅ Modification of system scripts
- ✅ Modification of configuration files
- ✅ Injection of code into other scripts
- ✅ Compromise of the entire Qinglong installation

Scripts can still:
- ✅ Read any files (read-only access)
- ✅ Write to their own directory (/data/scripts)
- ✅ Write logs
- ✅ Write to temporary directories
- ✅ Perform all legitimate operations
