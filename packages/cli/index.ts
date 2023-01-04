import * as yargs from 'yargs';
import { green, red } from 'chalk';
import { updateCommand } from './commands/update';

yargs
  .usage('Usage: ql [command] <options>')
  .command(updateCommand)
  .fail((err) => {
    console.error(`${red(err)}`);
  })
  .alias('h', 'help')
  .showHelp()
  .recommendCommands().argv;
