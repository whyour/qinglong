import type { DeploymentProfile } from '../../cluster-control/clusterControlActivation';

export const RUN_LOG_MODEL_CONTEXT_PROFILES = [
  'edge',
  'standalone',
  'cluster-control',
] as const;

export type RunLogModelContextProfile =
  (typeof RUN_LOG_MODEL_CONTEXT_PROFILES)[number];

export const RUN_LOG_REDACTION_CATEGORIES = [
  'authorization',
  'credential_assignment',
  'private_key',
  'url_userinfo',
  'jwt',
  'cloud_access_key',
  'opaque_token',
] as const;

export type RunLogRedactionCategory =
  (typeof RUN_LOG_REDACTION_CATEGORIES)[number];

export const RUN_LOG_PROMPT_INJECTION_SIGNALS = [
  'instruction_override',
  'role_impersonation',
  'secret_exfiltration',
  'tool_coercion',
] as const;

export type RunLogPromptInjectionSignal =
  (typeof RUN_LOG_PROMPT_INJECTION_SIGNALS)[number];

export interface RunLogModelContextBudget {
  readonly sourceBytes: number;
  readonly maximumTextBytes: number;
}

export interface RunLogModelContextProjection {
  readonly content: string;
  readonly sourceBytes: number;
  readonly modelTextBytes: number;
  readonly redaction: Readonly<{
    readonly contract: 'recognized_credentials_v1';
    readonly residualSensitivity: 'potentially_sensitive';
    readonly replacements: number;
    readonly categories: readonly RunLogRedactionCategory[];
  }>;
  readonly normalization: Readonly<{
    readonly invalidUtf8: boolean;
    readonly unsafeCodePointsReplaced: number;
  }>;
  readonly trust: Readonly<{
    readonly classification: 'untrusted_execution_output';
    readonly instructionPolicy: 'data_only_never_execute';
    readonly actionAuthority: 'none';
    readonly suspectedPromptInjection: boolean;
    readonly signals: readonly RunLogPromptInjectionSignal[];
  }>;
}

const BUDGETS: Readonly<
  Record<RunLogModelContextProfile, Readonly<RunLogModelContextBudget>>
> = Object.freeze({
  edge: Object.freeze({ sourceBytes: 4 * 1024, maximumTextBytes: 12 * 1024 }),
  standalone: Object.freeze({
    sourceBytes: 8 * 1024,
    maximumTextBytes: 24 * 1024,
  }),
  'cluster-control': Object.freeze({
    sourceBytes: 16 * 1024,
    maximumTextBytes: 48 * 1024,
  }),
});

const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const AUTHORIZATION_PATTERN =
  /(?<![A-Za-z0-9_])(["']?)(authorization)\1(?![A-Za-z0-9_])(\s*[:=]\s*)(["']?)(bearer|basic)(\s+)([^\s,;"']+)\4/gi;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(?<![A-Za-z0-9_])(["']?)(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|cookie|set-cookie)\1(?![A-Za-z0-9_])(\s*[:=]\s*)(["']?)([^\s,;}\]"']{1,2048})\4/gi;
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^@/\s]+)@/gi;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const CLOUD_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const OPAQUE_TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g;

function isProfile(
  value: DeploymentProfile,
): value is RunLogModelContextProfile {
  return RUN_LOG_MODEL_CONTEXT_PROFILES.includes(
    value as RunLogModelContextProfile,
  );
}

export function runLogModelContextBudget(
  profile: DeploymentProfile,
): Readonly<RunLogModelContextBudget> {
  if (!isProfile(profile)) {
    throw new TypeError('Run log model-context profile is invalid');
  }
  return BUDGETS[profile];
}

function mask(value: string): string {
  return Array.from(value, (character) =>
    character === '\n' || character === '\r' ? character : '*',
  ).join('');
}

function normalizeText(value: Uint8Array): Readonly<{
  text: string;
  invalidUtf8: boolean;
  unsafeCodePointsReplaced: number;
}> {
  let invalidUtf8 = false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    invalidUtf8 = true;
  }
  const decoded = new TextDecoder('utf-8').decode(value);
  let unsafeCodePointsReplaced = 0;
  let text = '';
  for (const character of decoded.replace(/\r\n?/g, '\n')) {
    const point = character.codePointAt(0)!;
    if (
      (point < 0x20 && point !== 0x09 && point !== 0x0a) ||
      point === 0x7f ||
      point === 0x200b ||
      point === 0x200c ||
      point === 0x200d ||
      point === 0x2060 ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    ) {
      text += '\ufffd';
      unsafeCodePointsReplaced += 1;
    } else {
      text += character;
    }
  }
  return Object.freeze({ text, invalidUtf8, unsafeCodePointsReplaced });
}

function redact(value: string): Readonly<{
  text: string;
  replacements: number;
  categories: readonly RunLogRedactionCategory[];
}> {
  let text = value;
  let replacements = 0;
  const categories = new Set<RunLogRedactionCategory>();
  const counted =
    (
      category: RunLogRedactionCategory,
      replacement: (...values: string[]) => string,
    ) =>
    (...values: string[]): string => {
      replacements += 1;
      categories.add(category);
      return replacement(...values);
    };

  text = text.replace(
    PRIVATE_KEY_PATTERN,
    counted('private_key', (match) => mask(match)),
  );
  text = text.replace(
    AUTHORIZATION_PATTERN,
    counted(
      'authorization',
      (
        _match,
        keyQuote,
        key,
        separator,
        valueQuote,
        scheme,
        spacing,
        credential,
      ) =>
        `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${scheme}${spacing}${mask(
          credential,
        )}${valueQuote}`,
    ),
  );
  text = text.replace(
    CREDENTIAL_ASSIGNMENT_PATTERN,
    counted(
      'credential_assignment',
      (_match, nameQuote, name, separator, valueQuote, credential) =>
        `${nameQuote}${name}${nameQuote}${separator}${valueQuote}${mask(
          credential,
        )}${valueQuote}`,
    ),
  );
  text = text.replace(
    URL_USERINFO_PATTERN,
    counted(
      'url_userinfo',
      (_match, prefix, userinfo) => `${prefix}${mask(userinfo)}@`,
    ),
  );
  text = text.replace(
    JWT_PATTERN,
    counted('jwt', (match) => mask(match)),
  );
  text = text.replace(
    CLOUD_ACCESS_KEY_PATTERN,
    counted('cloud_access_key', (match) => mask(match)),
  );
  text = text.replace(
    OPAQUE_TOKEN_PATTERN,
    counted('opaque_token', (match) => mask(match)),
  );

  return Object.freeze({
    text,
    replacements,
    categories: Object.freeze(
      RUN_LOG_REDACTION_CATEGORIES.filter((category) =>
        categories.has(category),
      ),
    ),
  });
}

function promptInjectionSignals(
  text: string,
): readonly RunLogPromptInjectionSignal[] {
  const signals: RunLogPromptInjectionSignal[] = [];
  if (
    /\b(?:ignore|disregard|forget)\b[\s\S]{0,64}\b(?:previous|prior|system|developer|instructions?)\b/i.test(
      text,
    ) ||
    /忽略[\s\S]{0,32}(?:之前|以上|系统|开发者)[\s\S]{0,16}(?:指令|提示)/u.test(
      text,
    )
  ) {
    signals.push('instruction_override');
  }
  if (/^(?:\s*)(?:system|assistant|developer|tool)\s*:/im.test(text)) {
    signals.push('role_impersonation');
  }
  if (
    /\b(?:reveal|print|send|exfiltrate)\b[\s\S]{0,64}\b(?:secret|token|password|credential|system prompt)\b/i.test(
      text,
    )
  ) {
    signals.push('secret_exfiltration');
  }
  if (
    /\b(?:call|invoke|run|execute)\b[\s\S]{0,48}\b(?:tool|command|shell|terminal)\b/i.test(
      text,
    )
  ) {
    signals.push('tool_coercion');
  }
  return Object.freeze(signals);
}

export function projectRunLogModelContext(
  content: Uint8Array,
  profile: DeploymentProfile,
): Readonly<RunLogModelContextProjection> {
  const budget = runLogModelContextBudget(profile);
  if (
    !(content instanceof Uint8Array) ||
    content.byteLength > budget.sourceBytes
  ) {
    throw new TypeError('Run log model-context source is invalid');
  }
  const source = Buffer.from(
    content.buffer,
    content.byteOffset,
    content.byteLength,
  );
  const normalized = normalizeText(source);
  const redacted = redact(normalized.text);
  const modelTextBytes = Buffer.byteLength(redacted.text, 'utf8');
  if (modelTextBytes > budget.maximumTextBytes) {
    throw new TypeError('Run log model-context text budget was exceeded');
  }
  const signals = promptInjectionSignals(redacted.text);
  return Object.freeze({
    content: redacted.text,
    sourceBytes: source.byteLength,
    modelTextBytes,
    redaction: Object.freeze({
      contract: 'recognized_credentials_v1' as const,
      residualSensitivity: 'potentially_sensitive' as const,
      replacements: redacted.replacements,
      categories: redacted.categories,
    }),
    normalization: Object.freeze({
      invalidUtf8: normalized.invalidUtf8,
      unsafeCodePointsReplaced: normalized.unsafeCodePointsReplaced,
    }),
    trust: Object.freeze({
      classification: 'untrusted_execution_output' as const,
      instructionPolicy: 'data_only_never_execute' as const,
      actionAuthority: 'none' as const,
      suspectedPromptInjection: signals.length > 0,
      signals,
    }),
  });
}
