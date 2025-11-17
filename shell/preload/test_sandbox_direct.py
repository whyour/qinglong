#!/usr/bin/env python3
# Minimal test of Python sandbox module
import os
import sys
from pathlib import Path

# Set up environment
script_dir = Path(__file__).parent.resolve()
ql_dir = script_dir.parent.parent
os.environ['QL_DIR'] = str(ql_dir)
os.environ['QL_DATA_DIR'] = str(ql_dir / 'data')

# Add preload to path
sys.path.insert(0, str(script_dir))

# Load sandbox
import sandbox

print("Testing Python filesystem sandbox...\n")

# Test 1: Try to write to config directory (should fail)
print("Test 1: Attempting to write to config/test.txt (should fail)...")
try:
    config_path = ql_dir / 'data' / 'config' / 'test.txt'
    with open(config_path, 'w') as f:
        f.write('test')
    print("❌ FAILED: Was able to write to protected config directory!")
    sys.exit(1)
except PermissionError as e:
    if 'Security Error' in str(e):
        print("✅ PASSED: Correctly blocked write to config directory")
        print(f"Error message: {str(e).split(chr(10))[0]}")
    else:
        print(f"❓ UNEXPECTED ERROR: {e}")
except Exception as e:
    print(f"❓ UNEXPECTED ERROR: {e}")

# Test 2: Write to scripts directory (should succeed)
print("\nTest 2: Attempting to write to scripts directory (should succeed)...")
try:
    scripts_path = ql_dir / 'data' / 'scripts' / 'test_output.txt'
    with open(scripts_path, 'w') as f:
        f.write('This is a test file')
    print("✅ PASSED: Successfully wrote to scripts directory")
    os.remove(scripts_path)
except Exception as e:
    print(f"❌ FAILED: Could not write to allowed scripts directory: {e}")
    sys.exit(1)

print("\n✅ Basic Python sandbox tests passed!")
