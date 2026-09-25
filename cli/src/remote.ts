#!/usr/bin/env node
import { invoke } from './invoke';
import { dispatchRemote } from './framework/remoteDispatch';

export function remoteMain(args = process.argv.slice(2)): Promise<number> {
  return invoke(args, 'public', dispatchRemote);
}

if (require.main === module)
  void remoteMain().then(code => { process.exitCode = code; });
