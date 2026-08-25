import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function defaultDaemonTokenPath(): string {
  return `${process.env.HOME ?? process.cwd()}/.agents-memory/daemon-token`;
}

export function readDaemonToken(path = defaultDaemonTokenPath()): string | null {
  try {
    const token = readFileSync(path, "utf8").trim();
    return token.length >= 32 ? token : null;
  } catch {
    return null;
  }
}

export function ensureDaemonToken(path = defaultDaemonTokenPath()): string {
  const existing = readDaemonToken(path);
  if (existing !== null) return existing;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return token;
}
