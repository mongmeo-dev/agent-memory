export interface RedactionResult {
  text: string;
  count: number;
}

function globRegex(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      pattern += ".*";
      index += 1;
    } else if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += character?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`${pattern}$`, "u");
}

export function isExcludedPath(path: string, globs: readonly string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const basename = normalized.split("/").at(-1) ?? normalized;
  return globs.some((glob) => {
    const matcher = globRegex(glob);
    return (
      matcher.test(normalized) ||
      (!glob.includes("/") && matcher.test(basename)) ||
      (glob.startsWith("**/") && globRegex(glob.slice(3)).test(normalized))
    );
  });
}

interface RedactionRule {
  pattern: RegExp;
  replace: string | ((match: string, captures: readonly unknown[]) => string);
}

const REDACTED = "[REDACTED]";

function capture(values: readonly unknown[], index: number): string {
  const value = values[index];
  if (typeof value !== "string") {
    throw new Error(`민감정보 필터 캡처 ${index}가 문자열이 아닙니다.`);
  }
  return value;
}

const RULES: RedactionRule[] = [
  {
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    replace: REDACTED,
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    replace: `Bearer ${REDACTED}`,
  },
  {
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
    replace: REDACTED,
  },
  {
    pattern:
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|client[_-]?secret)\b(\s*[=:]\s*)(["']?)[^\s,"'};]+\3/gi,
    replace: (_match, captures) => `${capture(captures, 0)}${capture(captures, 1)}${REDACTED}`,
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi,
    replace: (_match, captures) => `${capture(captures, 0)}${REDACTED}${capture(captures, 2)}`,
  },
];

export function redact(input: string, customPatterns: readonly string[] = []): RedactionResult {
  let text = input;
  let count = 0;

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match: string, ...captures: unknown[]) => {
      count += 1;
      return typeof rule.replace === "string" ? rule.replace : rule.replace(match, captures);
    });
  }

  for (const pattern of customPatterns) {
    text = text.replace(new RegExp(pattern, "gu"), () => {
      count += 1;
      return REDACTED;
    });
  }

  return { text, count };
}
