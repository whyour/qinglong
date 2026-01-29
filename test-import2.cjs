const cronParser = require('cron-parser');
const CronExpressionParser = cronParser.default || cronParser;  // Simulating esModuleInterop

// Test cases
const testExpressions = [
  '*/8 * * * *',      // 5 fields (every 8 minutes)
  '*/8 * * * * ?',    // 6 fields with seconds (every 8 seconds)
  '0 */8 * * * *',    // 6 fields with seconds (every 8 minutes at 0 seconds)
  '*/5 * * * * *',    // 6 fields (every 5 seconds)
];

console.log('Testing with .default:\n');

testExpressions.forEach(expr => {
  try {
    const parsed = CronExpressionParser.parse(expr);
    if (parsed.hasNext()) {
      console.log(`✓ "${expr}" - VALID`);
    }
  } catch (e) {
    console.log(`✗ "${expr}" - INVALID: ${e.message}`);
  }
});
