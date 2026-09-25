// Evaluation only. Dependencies live outside the application package.
const path = require('node:path');
const { createRequire } = require('node:module');
const nativeDist = process.env.QL_FRAMEWORK_NATIVE_DIST;
if (!nativeDist || !path.isAbsolute(nativeDist)) throw Error('Set QL_FRAMEWORK_NATIVE_DIST to an absolute pre-Commander dist snapshot.');
const { commands, globalOptions, localOptions } = require(path.join(nativeDist, 'framework/registry'));
const { integer } = require(path.join(nativeDist, 'arguments'));
const external = createRequire(path.join(process.env.QL_FRAMEWORK_DEPS || '/tmp/ql-framework-eval', 'package.json'));
const kind = process.argv[2];
const scenario = process.argv[3] || 'parse';
const taskArgs = ['task', 'list', '--search', 'example', '--page', '2', '--size', '20', '--json'];
const schemas = commands.map(spec => ({ ...spec, options: { ...globalOptions, ...(spec.local ? localOptions : {}), ...spec.options } }));
const canonical = spec => spec.name.replace(/^local /, '');
const normalizeKey = key => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function finish(spec, raw, positionals) {
  const values = {};
  for (const [key, option] of Object.entries(spec.options)) {
    let value = raw[key] ?? raw[normalizeKey(key)] ?? option.default;
    if (kind === 'cac' && Array.isArray(value) && value.length === 1) value = value[0];
    if (value !== undefined) values[key] = value;
    if (option.required && !value) throw Error('Required option');
    if (option.choices && !option.choices.includes(value)) throw Error('Invalid choice');
    if (option.integer && value !== undefined) integer(String(value), option.integer.min, option.integer.max);
  }
  if (positionals.length < (spec.minimum || 0) || positionals.length > (spec.maximum || 0)) throw Error('Argument count');
  return { name: spec.name, values, positionals };
}

let parse;
if (kind === 'native') {
  const { parse: current } = require(path.join(nativeDist, 'arguments'));
  parse = (args, help = false) => {
    const result = current(help ? ['--help'] : args);
    return help ? result.help : { name: result.name, values: { ...result.values }, positionals: result.positionals };
  };
} else if (kind === 'commander' || kind === 'commander-bundled') {
  const { Command, Option } = external(kind === 'commander-bundled' ? './commander-bundle.cjs' : 'commander');
  parse = (args, help = false) => {
    let result;
    const root = new Command('ql').exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
    const groups = new Map();
    for (const spec of schemas) {
      const parts = canonical(spec).split(' ');
      let parent = root;
      if (parts.length === 2) {
        if (!groups.has(parts[0])) groups.set(parts[0], root.command(parts[0]));
        parent = groups.get(parts.shift());
      }
      const command = parent.command(parts[0]).description(spec.summary).allowExcessArguments(false);
      if (spec.arguments) command.arguments(spec.arguments);
      for (const [key, option] of Object.entries(spec.options)) {
        if (key === 'help') continue;
        const flags = `${option.short ? `-${option.short}, ` : ''}--${key}${option.type === 'string' ? ' <value>' : ''}`;
        const flag = new Option(flags, option.description);
        if (option.default !== undefined) flag.default(option.default);
        command.addOption(flag);
      }
      command.action((...parsed) => {
        const instance = parsed.at(-1);
        result = finish(spec, instance.opts(), instance.args);
      });
    }
    if (help) return root.helpInformation();
    root.parse(args, { from: 'user' });
    return result;
  };
} else if (kind === 'cac') {
  const { cac } = external('cac');
  parse = (args, help = false) => {
    const cli = cac('ql');
    let result;
    // CAC command matching is flat. Route the existing two-token groups to
    // an internal flat command name before calling CAC; this is adapter code.
    const selected = schemas.find(spec => canonical(spec).split(' ').every((part, i) => args[i] === part));
    const routed = selected ? [canonical(selected).replace(/ /g, '-'), ...args.slice(canonical(selected).split(' ').length)] : args;
    for (const spec of schemas) {
      const command = cli.command(`${canonical(spec).replace(/ /g, '-')}${spec.arguments ? ' ' + spec.arguments : ''}`, spec.summary);
      for (const [key, option] of Object.entries(spec.options))
        command.option(`${option.short ? `-${option.short}, ` : ''}--${key}${option.type === 'string' ? ' <value>' : ''}`, option.description, { default: option.default, type: option.type === 'string' ? [String] : undefined });
      command.action((...parsed) => { result = finish(spec, parsed.at(-1), parsed.slice(0, -1)); });
    }
    cli.help();
    if (help) {
      let rendered = '';
      const output = console.log, info = console.info;
      console.log = (...parts) => { rendered += parts.join(' ') + '\n'; };
      console.info = console.log;
      try { cli.outputHelp(); } finally { console.log = output; console.info = info; }
      return rendered;
    }
    cli.parse(['node', 'ql', ...routed]);
    return result;
  };
} else if (kind === 'yargs') {
  const yargs = external('yargs/yargs');
  parse = (args, help = false) => {
    let result;
    const root = yargs([]).scriptName('ql').exitProcess(false).strict().help(false).version(false);
    const add = (parent, spec, name) => parent.command(name + (spec.arguments ? ' ' + spec.arguments : ''), spec.summary,
      builder => {
        for (const [key, option] of Object.entries(spec.options))
          builder.option(key, {type:option.type, alias:option.short, default:option.default, description:option.description});
        return builder;
      }, raw => { result = finish(spec, raw, spec.arguments ? [String(raw[spec.arguments.slice(1, -1)])] : []); });
    for (const group of ['auth', 'task', 'subscription'])
      root.command(group + ' <command>', group, builder => {
        for (const spec of schemas.filter(item => item.name.startsWith(group + ' '))) add(builder, spec, spec.name.slice(group.length + 1));
        return builder;
      });
    for (const spec of schemas.filter(item => item.local)) add(root, spec, canonical(spec));
    if (help) { let rendered = ''; root.showHelp(text => { rendered = text; }); return rendered; }
    root.parseSync(args);
    return result;
  };
} else if (kind !== 'baseline') throw Error('Unknown framework');

if (kind !== 'baseline') {
  const args = process.env.QL_FRAMEWORK_ARGS ? JSON.parse(process.env.QL_FRAMEWORK_ARGS) : taskArgs;
  const result = parse(args, scenario === 'help');
  if (scenario === 'help') {
    if (typeof result !== 'string' || result.length < 50) throw Error('Missing help');
  } else if (!process.env.QL_FRAMEWORK_ARGS) {
    require('node:assert/strict').deepEqual(result, { name:'task list', values:{json:true,search:'example',page:'2',size:'20'}, positionals:[] });
  }
  if (scenario === 'warm') {
    for (let i = 0; i < 20; i++) parse(args);
    const start = performance.now();
    for (let i = 0; i < 200; i++) parse(args);
    process.stdout.write(JSON.stringify({ perCallMs:(performance.now()-start)/200, maxRSS:process.resourceUsage().maxRSS })+'\n');
  } else process.stdout.write(JSON.stringify({ result, maxRSS:process.resourceUsage().maxRSS })+'\n');
} else process.stdout.write(JSON.stringify({ maxRSS:process.resourceUsage().maxRSS })+'\n');
