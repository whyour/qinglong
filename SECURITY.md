## Reporting a Vulnerability

To report a vulnerability, please open a private vulnerability report at <https://github.com/whyour/qinglong/security>.

While the discovery of new vulnerabilities is rare, we also recommend always using the latest versions of Qinglong to ensure your application remains as secure as possible.

## Script Sandboxing

Qinglong includes built-in filesystem sandboxing to protect against malicious scripts. Scripts running in Qinglong have restricted filesystem access:

### Protected Directories (Read-Only for Scripts)

Scripts cannot write to or modify files in these directories:
- `/back` - Backend application code
- `/src` - Frontend source code  
- `/shell` - Shell scripts and system utilities
- `/sample` - Sample configuration files
- `/node_modules` - Node.js dependencies
- `/data/config` - System configuration files (including `task_before.sh`, `task_after.sh`, `config.sh`, etc.)
- `/data/db` - Database files

### Allowed Directories (Scripts Can Write)

Scripts can freely read and write in these directories:
- `/data/scripts` - User scripts directory
- `/data/log` - Log files
- `/data/repo` - Repository clones
- `/data/raw` - Raw data storage
- `/.tmp` - Temporary files
- `/tmp` - System temporary directory

### Disabling Sandbox (Not Recommended)

The sandbox is enabled by default. To disable it (not recommended for security reasons), set the environment variable:

```bash
QL_DISABLE_SANDBOX=true
```

**Warning**: Disabling the sandbox allows scripts to modify any file on the system, including critical system files like `task_after.sh`, which could compromise the entire Qinglong installation.

### How It Works

The sandbox works by intercepting filesystem operations in Node.js and Python scripts:

- **Node.js**: The sandbox wraps the `fs` module and its methods (`writeFile`, `appendFile`, `mkdir`, `rmdir`, `unlink`, etc.)
- **Python**: The sandbox wraps `builtins.open()`, `os` module functions, `shutil` operations, and `pathlib.Path` methods

When a script attempts to write to a protected path, the operation is blocked with a `PermissionError` (Python) or `EACCES` error (Node.js).
