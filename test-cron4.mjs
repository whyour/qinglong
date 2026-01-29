import CronExpressionParser from 'cron-parser';

// Test both ways
const testExpressions = [
  '*/8 * * * *',      // 5 fields (every 8 minutes)
  '*/8 * * * * ?',    // 6 fields with seconds (every 8 seconds)
];

console.log('Testing CronExpressionParser.CronExpressionParser.parse:\n');

testExpressions.forEach(expr => {
  try {
    const parsed = CronExpressionParser.CronExpressionParser.parse(expr);
    if (parsed.hasNext()) {
      console.log(`✓ "${expr}" - VALID`);
    }
  } catch (e) {
    console.log(`✗ "${expr}" - INVALID: ${e.message}`);
  }
});
