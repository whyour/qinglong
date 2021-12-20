import { CommandModule } from 'yargs';
export const updateCommand: CommandModule = {
  command: 'update',
  describe: 'Update and restart qinglong',
  builder: (yargs) => {
    return yargs.option('repositority', {
      type: 'string',
      alias: 'r',
      describe: `Specify the release warehouse address of the package`,
    });
  },
  handler: async (argv) => {},
};
