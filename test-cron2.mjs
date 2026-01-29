import CronExpressionParser from 'cron-parser';

// Test cases - same as the image shows
const testExpressions = [
  '*/8 * * * *',      // 5 fields (every 8 minutes)
  '*/8 * * * * ?',    // 6 fields with seconds (every 8 seconds) - FROM THE IMAGE
];

console.log('Testing with default import (like the validation code):\n');

testExpressions.forEach(expr => {
  try {
    const parsed = CronExpressionParser.parse(expr);
    if (parsed.hasNext()) {
      console.log(`✓ "${expr}" - VALID, hasNext: true`);
    } else {
      console.log(`? "${expr}" - parsed but hasNext is false`);
    }
  } catch (e) {
    console.log(`✗ "${expr}" - INVALID: ${e.message}`);
  }
});
