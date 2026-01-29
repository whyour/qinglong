// Simulating the built code
const cron_parser_1 = require("cron-parser");

const validateSchedule = (value, helpers) => {
    const mockHelpers = {
        error: (msg) => ({ error: msg })
    };
    helpers = helpers || mockHelpers;
    
    try {
        if (cron_parser_1.default.parse(value).hasNext()) {
            return value;
        }
    }
    catch (e) {
        return helpers.error('any.invalid');
    }
    return helpers.error('any.invalid');
};

// Test cases
const testExpressions = [
  '*/8 * * * *',      // 5 fields (every 8 minutes)
  '*/8 * * * * ?',    // 6 fields with seconds (every 8 seconds) - FROM THE IMAGE
  '0 */8 * * * *',    // 6 fields with seconds (every 8 minutes at 0 seconds)
  '*/5 * * * * *',    // 6 fields (every 5 seconds)
];

console.log('Testing built validation logic:\n');

testExpressions.forEach(expr => {
  const result = validateSchedule(expr);
  if (result === expr) {
    console.log(`✓ "${expr}" - VALID`);
  } else {
    console.log(`✗ "${expr}" - INVALID:`, result);
  }
});
