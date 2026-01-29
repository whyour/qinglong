import * as parser from 'cron-parser';

console.log('Available exports:', Object.keys(parser));
console.log('Default export:', parser.default);

// Try with the named export
const testExpressions = [
  '*/8 * * * *',      // 5 fields (every 8 minutes)
  '*/8 * * * * ?',    // 6 fields with seconds (every 8 seconds)
  '0 */8 * * * *',    // 6 fields with seconds (every 8 minutes at 0 seconds)
  '*/5 * * * * *',    // 6 fields (every 5 seconds)
];

console.log('\nTesting cron-parser with various expressions:\n');

testExpressions.forEach(expr => {
  try {
    const parsed = parser.CronExpressionParser.parse(expr);
    console.log(`✓ "${expr}" - VALID, hasNext: ${parsed.hasNext()}`);
  } catch (e) {
    console.log(`✗ "${expr}" - INVALID: ${e.message}`);
  }
});
