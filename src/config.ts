import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export function defaultConfigPath(): string {
  return `${process.env.HOME ?? process.cwd()}/.agents-memory/config.json`;
}

export function configuredDatabasePath(path = defaultConfigPath()): string | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "databasePath" in value &&
      typeof value.databasePath === "string" &&
      isAbsolute(value.databasePath)
    ) {
      return value.databasePath;
    }
    return null;
  } catch {
    return null;
  }
}

export function setConfiguredDatabasePath(databasePath: string, path = defaultConfigPath()): void {
  if (!isAbsolute(databasePath)) throw new Error("database 경로는 절대 경로여야 합니다.");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ databasePath }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}
