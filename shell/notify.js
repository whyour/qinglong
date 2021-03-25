const notify = require('/ql/scripts/sendNotify');
const title = process.argv[2];
const content = process.argv[3];

notify.sendNotify(`${title}`, `${content}`);
