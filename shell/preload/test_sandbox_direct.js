// Minimal test of sandbox module
const path = require('path');

// Set up environment
process.env.QL_DIR = path.join(__dirname, '../..');
process.env.QL_DATA_DIR = path.join(__dirname, '../../data');

// Load sandbox
require('./sandbox.js');

const fs = require('fs');

console.log("Testing filesystem sandbox...\n");

// Test 1: Try to write to config directory (should fail)
console.log("Test 1: Attempting to write to config/test.txt (should fail)...");
try {
  const configPath = path.join(__dirname, '../../data/config/test.txt');
  fs.writeFileSync(configPath, 'test');
  console.log("❌ FAILED: Was able to write to protected config directory!");
  process.exit(1);
} catch (error) {
  if (error.code === 'EACCES' && error.message.includes('Security Error')) {
    console.log("✅ PASSED: Correctly blocked write to config directory");
    console.log("Error message:", error.message.split('\n')[0]);
  } else {
    console.log("❓ UNEXPECTED ERROR:", error.message);
  }
}

// Test 2: Write to scripts directory (should succeed)
console.log("\nTest 2: Attempting to write to scripts directory (should succeed)...");
try {
  const scriptsPath = path.join(__dirname, '../../data/scripts/test_output.txt');
  fs.writeFileSync(scriptsPath, 'This is a test file');
  console.log("✅ PASSED: Successfully wrote to scripts directory");
  fs.unlinkSync(scriptsPath);
} catch (error) {
  console.log("❌ FAILED: Could not write to allowed scripts directory:", error.message);
  process.exit(1);
}

console.log("\n✅ Basic sandbox tests passed!");
