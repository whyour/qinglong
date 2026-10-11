import { english } from './en';

export function translate(
  env: NodeJS.ProcessEnv,
  key: string,
  ...values: unknown[]
): string {
  const template = env.QL_LANG === 'en' ? english[key] ?? key : key;
  let index = 0;
  return template.replace(/%%|%s/g, (token) =>
    token === '%%' ? '%' : String(values[index++] ?? ''),
  );
}
