import CronExpressionParser from 'cron-parser';

console.log('Default import type:', typeof CronExpressionParser);
console.log('Default import:', CronExpressionParser);
console.log('Is it a class?', CronExpressionParser.prototype);
console.log('Available static methods:', Object.getOwnPropertyNames(CronExpressionParser));
