import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface EmbeddingConfiguration {
  endpoint: string;
  model: string;
}

interface LocalConfiguration {
  databasePath?: string;
  embedding?: EmbeddingConfiguration;
  autoUse?: boolean;
  projectAutoUse?: Record<string, boolean>;
}

export interface AutoUseStatus {
  enabled: boolean;
  source: "project" | "configuration" | "default";
}

export function defaultConfigPath(): string {
  return `${process.env.HOME ?? process.cwd()}/.agents-memory/config.json`;
}

function readConfiguration(path: string): LocalConfiguration {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as LocalConfiguration) : {};
  } catch {
    return {};
  }
}

function writeConfiguration(configuration: LocalConfiguration, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function configuredDatabasePath(path = defaultConfigPath()): string | null {
  const databasePath = readConfiguration(path).databasePath;
  return typeof databasePath === "string" && isAbsolute(databasePath) ? databasePath : null;
}

export function setConfiguredDatabasePath(databasePath: string, path = defaultConfigPath()): void {
  if (!isAbsolute(databasePath)) throw new Error("database 경로는 절대 경로여야 합니다.");
  writeConfiguration({ ...readConfiguration(path), databasePath }, path);
}

export function configuredEmbedding(path = defaultConfigPath()): EmbeddingConfiguration | null {
  const embedding = readConfiguration(path).embedding;
  if (
    embedding === undefined ||
    typeof embedding.endpoint !== "string" ||
    typeof embedding.model !== "string"
  ) {
    return null;
  }
  try {
    const endpoint = new URL(embedding.endpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return null;
  } catch {
    return null;
  }
  const model = embedding.model.trim();
  return model.length === 0 ? null : { endpoint: embedding.endpoint, model };
}

export function setConfiguredEmbedding(
  embedding: EmbeddingConfiguration | null,
  path = defaultConfigPath(),
): void {
  const configuration = readConfiguration(path);
  if (embedding === null) {
    delete configuration.embedding;
  } else {
    let endpoint: URL;
    try {
      endpoint = new URL(embedding.endpoint);
    } catch {
      throw new Error("embedding endpoint는 유효한 URL이어야 합니다.");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("embedding endpoint는 HTTP 또는 HTTPS URL이어야 합니다.");
    }
    const model = embedding.model.trim();
    if (model.length === 0) throw new Error("embedding model은 비어 있을 수 없습니다.");
    configuration.embedding = { endpoint: endpoint.toString(), model };
  }
  writeConfiguration(configuration, path);
}

export function configuredAutoUse(path = defaultConfigPath()): boolean {
  return readConfiguration(path).autoUse === true;
}

export function setConfiguredAutoUse(enabled: boolean, path = defaultConfigPath()): void {
  writeConfiguration({ ...readConfiguration(path), autoUse: enabled }, path);
}

export function configuredProjectAutoUse(
  projectId: string,
  path = defaultConfigPath(),
): boolean | null {
  const value = readConfiguration(path).projectAutoUse?.[projectId];
  return typeof value === "boolean" ? value : null;
}

export function setConfiguredProjectAutoUse(
  projectId: string,
  enabled: boolean | null,
  path = defaultConfigPath(),
): void {
  const configuration = readConfiguration(path);
  const projectAutoUse = { ...configuration.projectAutoUse };
  if (enabled === null) delete projectAutoUse[projectId];
  else projectAutoUse[projectId] = enabled;
  if (Object.keys(projectAutoUse).length === 0) delete configuration.projectAutoUse;
  else configuration.projectAutoUse = projectAutoUse;
  writeConfiguration(configuration, path);
}

export function autoUseStatus(projectId: string, path = defaultConfigPath()): AutoUseStatus {
  const project = configuredProjectAutoUse(projectId, path);
  if (project !== null) return { enabled: project, source: "project" };
  const configuration = readConfiguration(path);
  if (typeof configuration.autoUse === "boolean") {
    return { enabled: configuration.autoUse, source: "configuration" };
  }
  return { enabled: false, source: "default" };
}
