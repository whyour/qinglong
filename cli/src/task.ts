#!/usr/bin/env node
import { taskMain } from './ql';
export { taskMain } from './ql';

if (require.main === module)
  void taskMain().then(code => { process.exitCode = code; });
