const CronExpressionParser = require('cron-parser');

// Replicate the validation logic
const validateSchedule = (value) => {
  try {
    if (CronExpressionParser.parse(value).hasNext()) {
      return { valid: true };
    }
  } catch (e) {
    return { valid: false, error: e.message };
  }
  return { valid: false, error: 'hasNext() returned false' };
};

// Test cases from the issue
const testExpressions = [
  '*/8 * * * *',      // 5 fields (every 8 minutes)
  '*/8 * * * * ?',    // 6 fields with seconds (every 8 seconds) - FROM THE IMAGE
  '0 */8 * * * *',    // 6 fields with seconds (every 8 minutes at 0 seconds)
  '*/5 * * * * *',    // 6 fields (every 5 seconds)
];

console.log('Testing validation logic with CommonJS:\n');

testExpressions.forEach(expr => {
  const result = validateSchedule(expr);
  if (result.valid) {
    console.log(`✓ "${expr}" - VALID`);
  } else {
    console.log(`✗ "${expr}" - INVALID: ${result.error}`);
  }
});
