#!/usr/bin/env node
import { translate } from './i18n';
import { standaloneHelp } from './i18n/standalone';
import { parseFlags, isArgumentError } from './framework/options';
import { CliError, fail } from './errors';
import { planRelease, applyRelease } from './developer/release';

export async function developerMain(
  args = process.argv.slice(2),
): Promise<number> {
  const json = args.includes('--json');
  try {
    const parsed = parseFlags(args, {
        root: { type: 'string' },
        remote: { type: 'string', default: 'origin' },
        branch: { type: 'string', default: 'master' },
        apply: { type: 'boolean' },
        commit: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
    }, { rejectDuplicates:false });
    if (parsed.values.help || args.length === 0) {
      const help = standaloneHelp('developer');
      process.stdout.write(
        (json ? JSON.stringify({ code: 200, data: { help } }) : help) + '\n',
      );
      return 0;
    }
    if (
      parsed.positionals.length !== 1 ||
      parsed.positionals[0] !== 'release' ||
      !parsed.values.root
    )
      fail(translate(process.env, '请使用 release --root <仓库绝对路径>。'), 2);
    if (parsed.values.apply && !parsed.values.commit)
      fail(
        translate(
          process.env,
          '--apply 需要通过 --commit 指定已审阅发布计划中的提交。',
        ),
        2,
      );
    if (!parsed.values.apply && parsed.values.commit)
      fail(translate(process.env, '--commit 必须与 --apply 一起使用。'), 2);
    const options = {
      root: parsed.values.root as string,
      remote: parsed.values.remote as string,
      branch: parsed.values.branch as string,
    };
    const plan = parsed.values.apply
      ? await applyRelease(options, parsed.values.commit as string)
      : await planRelease(options);
    process.stdout.write(
      JSON.stringify(
        { code: 200, data: { applied: !!parsed.values.apply, ...plan } },
        null,
        json ? 0 : 2,
      ) + '\n',
    );
    return 0;
  } catch (error) {
    const usage = isArgumentError(error);
    const code = error instanceof CliError ? error.exitCode : usage ? 2 : 1;
    const message =
      error instanceof CliError
        ? error.message
        : usage
        ? translate(process.env, '发布选项无效，请运行 --help。')
        : translate(
            process.env,
            '发布失败，请检查诊断信息，不要盲目重复外部操作。',
          );
    process.stderr.write(
      (json ? JSON.stringify({ code, message }) : message) + '\n',
    );
    return code;
  }
}
if (require.main === module)
  void developerMain().then((code) => {
    process.exitCode = code;
  });
