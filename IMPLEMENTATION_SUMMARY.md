# Security Fix Implementation Summary

## Issue
**Title**: 运行的脚本可以通过 fs 等模块修改/config/task_after.sh等文件达到监听、修改所有脚本代码

**Translation**: Scripts can modify /config/task_after.sh and other files through fs module to monitor and modify all script code

**Severity**: Critical - Allows arbitrary code injection into all scripts

## Root Cause
User scripts ran with unrestricted filesystem access, allowing them to:
1. Modify `task_after.sh` to inject code that runs after every script
2. Modify `task_before.sh` to inject code that runs before every script
3. Modify configuration files
4. Potentially compromise the entire system

## Solution
Implemented a filesystem sandbox that intercepts file operations and blocks unauthorized writes.

### Implementation Details

#### 1. Node.js Sandbox (`shell/preload/sandbox.js`)
- Wraps all fs module write methods (writeFile, appendFile, mkdir, unlink, etc.)
- Wraps fs.promises API
- Wraps fs.createWriteStream
- Prevents module require bypass by wrapping Module.prototype.require
- Returns EACCES error with security message for blocked operations

#### 2. Python Sandbox (`shell/preload/sandbox.py`)
- Wraps builtins.open() for write modes ('w', 'a', 'x', '+')
- Wraps os module functions (remove, mkdir, rename, chmod, etc.)
- Wraps shutil operations (rmtree, copy, move, etc.)
- Wraps pathlib.Path methods (write_text, mkdir, unlink, etc.)
- Raises PermissionError with security message for blocked operations

#### 3. Integration
- Updated `shell/preload/sitecustomize.js` to load Node.js sandbox first
- Updated `shell/preload/sitecustomize.py` to load Python sandbox first
- Sandboxes are loaded before any user code executes

### Protected Directories
Scripts CANNOT write to:
- `/back` - Backend application code
- `/src` - Frontend source code
- `/shell` - Shell scripts and utilities
- `/sample` - Sample configuration files
- `/node_modules` - Node.js dependencies
- `/data/config` - System configuration (task_after.sh, task_before.sh, config.sh, etc.)
- `/data/db` - Database files

### Allowed Directories
Scripts CAN write to:
- `/data/scripts` - User scripts directory
- `/data/log` - Log files
- `/data/repo` - Repository clones
- `/data/raw` - Raw data storage
- `/.tmp` - Temporary files
- `/tmp` - System temporary directory

### Configuration
- **Default**: Sandbox enabled
- **Disable**: Set `QL_DISABLE_SANDBOX=true` (not recommended)

## Testing

### Test Coverage
1. ✅ Node.js exploit blocked (exact exploit from issue)
2. ✅ Python exploit blocked
3. ✅ Allowed writes work correctly
4. ✅ Sandbox can be disabled
5. ✅ CodeQL security scan: 0 alerts
6. ✅ All filesystem operations tested (write, append, mkdir, unlink, rename, etc.)

### Verification
The exact exploit from the issue is now blocked:
```javascript
const fs = require("fs");
const path = require("path");
fs.writeFileSync(path.join(__dirname, "..", "..", 'config', 'task_after.sh'), `echo 123`);
// Returns: Error: EACCES: Security Error: Script attempted to writeFileSync protected path
```

## Security Impact

### Before Fix
- ❌ Scripts could modify any system file
- ❌ Malicious scripts could inject code into all other scripts
- ❌ System configuration could be compromised
- ❌ No isolation between scripts

### After Fix
- ✅ Scripts cannot modify system files
- ✅ Scripts cannot modify configuration files
- ✅ Each script is isolated from system files
- ✅ Legitimate operations still work
- ✅ Clear error messages for blocked operations
- ✅ Optional disable for advanced use cases

## Files Changed
1. `shell/preload/sandbox.js` - Node.js sandbox implementation (NEW)
2. `shell/preload/sandbox.py` - Python sandbox implementation (NEW)
3. `shell/preload/sitecustomize.js` - Load Node.js sandbox
4. `shell/preload/sitecustomize.py` - Load Python sandbox
5. `SECURITY.md` - Document sandbox feature
6. `README.md` - Add security features section
7. `README-en.md` - Add security features section (English)
8. `SANDBOX_TESTING.md` - Testing documentation (NEW)
9. `.gitignore` - Exclude test files

## Backwards Compatibility
- ✅ Existing scripts continue to work
- ✅ No breaking changes to API
- ✅ No changes to user workflow
- ✅ Can be disabled if needed

## Future Considerations
1. Consider adding more granular permissions
2. Consider sandboxing shell scripts (currently not needed as they run with limited scope)
3. Consider adding audit logging for blocked operations
4. Consider adding user-configurable protected/allowed paths

## Conclusion
The security vulnerability has been successfully fixed with comprehensive filesystem sandboxing. The implementation:
- Blocks the exact exploit from the issue
- Maintains backwards compatibility
- Has zero security alerts
- Is thoroughly tested
- Is well documented
- Can be disabled if needed
