import pLimit from "p-limit";
import os from 'os';

const cpuLimit = pLimit(os.cpus().length);
const oneLimit = pLimit(1);

export function runWithCpuLimit<T>(fn: () => Promise<T>): Promise<T> {
  return cpuLimit(() => {
    return fn();
  });
}

export function runOneByOne<T>(fn: () => Promise<T>): Promise<T> {
  return oneLimit(() => {
    return fn();
  });
}
