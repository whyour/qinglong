const cronParser = require('cron-parser');

console.log('Type:', typeof cronParser);
console.log('Keys:', Object.keys(cronParser));
console.log('\nCronExpressionParser:', cronParser.CronExpressionParser);
console.log('Default:', cronParser.default);
console.log('\nIs parse a method on default?', typeof cronParser.default?.parse);
console.log('Is parse a method on CronExpressionParser?', typeof cronParser.CronExpressionParser?.parse);
