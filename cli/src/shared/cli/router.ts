import { quietCommand } from './options';

// Delegate to a lazily loaded command implementation in this process. Keep
// the original argv slice: Commander consumes a leading -- during parsing,
// but the script/legacy parsers must receive that boundary unchanged.
export async function routeCommands(
  name: string,
  args: string[],
  handlers: Record<string, (args: string[]) => Promise<number>>,
  fallback: () => Promise<number>,
): Promise<number> {
  let result: number | undefined;
  const root = quietCommand(name).enablePositionalOptions()
    .passThroughOptions().allowUnknownOption().argument('[arguments...]');
  root.action(async () => { result = await fallback(); });
  for (const [command, handler] of Object.entries(handlers)) {
    root.addCommand(quietCommand(command).allowUnknownOption()
      .allowExcessArguments(true).passThroughOptions()
      .action(async () => { result = await handler(args.slice(1)); }));
  }
  await root.parseAsync(args, { from:'user' });
  return result ?? await fallback();
}
