require(`./env.js`);

function expandRange(rangeStr, max) {
  const tempRangeStr = rangeStr
    .trim()
    .replace(/-max/g, `-${max}`)
    .replace(/max-/g, `${max}-`);

  return tempRangeStr.split(' ').flatMap((part) => {
    const rangeMatch = part.match(/^(\d+)([-~_])(\d+)$/);
    if (rangeMatch) {
      const [, start, , end] = rangeMatch.map(Number);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    return Number(part);
  });
}

function run() {
  if (process.env.envParam && process.env.numParam) {
    const { envParam, numParam } = process.env;
    const array = (process.env[envParam] || '').split('&');
    const runArr = expandRange(numParam, array.length);
    const arrayRun = runArr.map((i) => array[i - 1]);
    const envStr = arrayRun.join('&');
    process.env[envParam] = envStr;
  }
}

run();
