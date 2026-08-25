import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const CLIENT_NAMES = ["claude", "codex", "gjc"] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];
export type SetupScope = "user" | "project";

export interface SetupOptions {
  clients: ClientName[];
  scope: SetupScope;
  nodePath: string;
  mcpPath: string;
  databasePath?: string;
  dryRun?: boolean;
}

export interface SetupResult {
  client: ClientName;
  status: "configured" | "planned" | "skipped" | "failed";
  command?: string[];
  message: string;
}

interface CommandResult {
  status: number | null;
  error?: Error;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

const defaultRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
    stderr: result.stderr ?? "",
  };
};

function commandAvailable(command: string, runner: CommandRunner): boolean {
  const result = runner(command, ["--version"]);
  return result.error?.message.includes("ENOENT") !== true && result.status !== null;
}

function environmentArgs(client: ClientName, databasePath: string | undefined): string[] {
  if (databasePath === undefined) return [];
  const value = `AGENTS_MEMORY_DB=${databasePath}`;
  if (client === "claude") return ["-e", value];
  if (client === "codex") return ["--env", value];
  return ["--env", value];
}

function addCommand(client: ClientName, options: SetupOptions): string[] {
  const environment = environmentArgs(client, options.databasePath);

  if (client === "claude") {
    return [
      "mcp",
      "add",
      "--scope",
      options.scope,
      ...environment,
      "agents-memory",
      "--",
      options.nodePath,
      options.mcpPath,
    ];
  }

  if (client === "codex") {
    return ["mcp", "add", ...environment, "agents-memory", "--", options.nodePath, options.mcpPath];
  }

  return [
    "mcp",
    "add",
    "agents-memory",
    "--force",
    ...(options.scope === "project" ? ["--project"] : []),
    "--command",
    options.nodePath,
    "--arg",
    options.mcpPath,
    ...environment,
  ];
}

function removeCommand(client: ClientName, scope: SetupScope): string[] {
  if (client === "claude") return ["mcp", "remove", "--scope", scope, "agents-memory"];
  if (client === "gjc") {
    return ["mcp", "remove", ...(scope === "project" ? ["--project"] : []), "agents-memory"];
  }
  return ["mcp", "remove", "agents-memory"];
}

export function setupClients(
  options: SetupOptions,
  runner: CommandRunner = defaultRunner,
): SetupResult[] {
  if (!existsSync(options.mcpPath) && options.dryRun !== true) {
    throw new Error(
      `MCP 서버를 찾을 수 없습니다. 먼저 npm run build를 실행하세요: ${options.mcpPath}`,
    );
  }

  return options.clients.map((client) => {
    if (client === "codex" && options.scope === "project") {
      return {
        client,
        status: "skipped",
        message: "Codex CLI는 프로젝트 범위 MCP 등록을 지원하지 않습니다.",
      };
    }

    const command = addCommand(client, options);
    if (options.dryRun === true) {
      return { client, status: "planned", command: [client, ...command], message: "실행 예정" };
    }

    if (!commandAvailable(client, runner)) {
      return { client, status: "skipped", message: `${client} 실행 파일을 찾을 수 없습니다.` };
    }

    runner(client, removeCommand(client, options.scope));
    const result = runner(client, command);
    if (result.status !== 0) {
      return {
        client,
        status: "failed",
        command: [client, ...command],
        message: result.stderr.trim() || "MCP 서버 등록에 실패했습니다.",
      };
    }

    return {
      client,
      status: "configured",
      command: [client, ...command],
      message: `${options.scope} 범위에 등록했습니다.`,
    };
  });
}
