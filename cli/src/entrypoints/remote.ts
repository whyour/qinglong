#!/usr/bin/env node
import { registry } from '../remote/commands/registry';
import { invoke } from '../shared/cli/invoke';
import { dispatchRemote } from '../remote/commands/dispatch';

export function remoteMain(args = process.argv.slice(2)): Promise<number> {
  return invoke(args, registry, dispatchRemote);
}

if (require.main === module)
  void remoteMain().then((code) => {
    process.exitCode = code;
  });
