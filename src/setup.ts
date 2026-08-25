import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterInstallOptions, AdapterInstallResult } from "./setup-adapters.js";
import { installLifecycleAdapter } from "./setup-adapters.js";

export const CLIENT_NAMES = ["claude", "codex", "gjc"] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];
export type SetupScope = "user" | "project";

export interface SetupOptions {
  clients: ClientName[];
  scope: SetupScope;
  nodePath: string;
  mcpPath: string;
  adapterPath?: string;
  projectRoot?: string;
  databasePath?: string;
  dryRun?: boolean;
}

export interface SetupResult {
  client: ClientName;
  status: "configured" | "needs-review" | "planned" | "skipped" | "failed";
  command?: string[];
  pluginCommand?: string[];
  artifacts?: string[];
  message: string;
}

interface CommandResult {
  status: number | null;
  error?: Error;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], cwd?: string) => CommandResult;
export type AdapterInstaller = (options: AdapterInstallOptions) => AdapterInstallResult;

const defaultRunner: CommandRunner = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(cwd === undefined ? {} : { cwd }),
  });
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
  adapterInstaller: AdapterInstaller = installLifecycleAdapter,
): SetupResult[] {
  if (!existsSync(options.mcpPath) && options.dryRun !== true) {
    throw new Error(
      `MCP 서버를 찾을 수 없습니다. 먼저 npm run build를 실행하세요: ${options.mcpPath}`,
    );
  }

  return options.clients.map((client) => {
    const commandCwd = options.scope === "project" ? options.projectRoot : undefined;
    const command = addCommand(client, options);
    const adapterOptions = {
      client,
      scope: options.scope,
      nodePath: options.nodePath,
      adapterPath: options.adapterPath ?? join(dirname(options.mcpPath), "adapter-cli.js"),
      ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
      ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    };
    if (options.dryRun === true) {
      const adapter = adapterInstaller({ ...adapterOptions, dryRun: true });
      const pluginCommand =
        client === "gjc" && adapter.bundleRoot !== undefined
          ? [
              "gjc",
              "plugin",
              "install",
              adapter.bundleRoot,
              options.scope === "project" ? "--project" : "--user",
              "--force",
            ]
          : undefined;
      return {
        client,
        status: "planned",
        command: [client, ...command],
        ...(pluginCommand === undefined ? {} : { pluginCommand }),
        artifacts: adapter.artifacts,
        message:
          client === "codex" && options.scope === "project"
            ? "hook 설치 예정; Codex 프로젝트 범위 MCP는 지원되지 않음"
            : "MCP와 lifecycle adapter 설치 예정",
      };
    }

    if (!commandAvailable(client, runner)) {
      return { client, status: "skipped", message: `${client} 실행 파일을 찾을 수 없습니다.` };
    }

    if (!(client === "codex" && options.scope === "project")) {
      runner(client, removeCommand(client, options.scope), commandCwd);
      const result = runner(client, command, commandCwd);
      if (result.status !== 0) {
        return {
          client,
          status: "failed",
          command: [client, ...command],
          message: result.stderr.trim() || "MCP 서버 등록에 실패했습니다.",
        };
      }
    }

    const adapter = adapterInstaller(adapterOptions);
    if (client === "gjc" && adapter.bundleRoot !== undefined) {
      const pluginCommand = [
        "plugin",
        "install",
        adapter.bundleRoot,
        options.scope === "project" ? "--project" : "--user",
        "--force",
      ];
      const pluginResult = runner("gjc", pluginCommand, commandCwd);
      if (pluginResult.status !== 0) {
        return {
          client,
          status: "failed",
          command: [client, ...command],
          pluginCommand: ["gjc", ...pluginCommand],
          artifacts: adapter.artifacts,
          message: pluginResult.stderr.trim() || "GJC lifecycle plugin 설치에 실패했습니다.",
        };
      }
    }
    return {
      client,
      status: adapter.needsReview ? "needs-review" : "configured",
      command: [client, ...command],
      ...(client === "gjc" && adapter.bundleRoot !== undefined
        ? {
            pluginCommand: [
              "gjc",
              "plugin",
              "install",
              adapter.bundleRoot,
              options.scope === "project" ? "--project" : "--user",
              "--force",
            ],
          }
        : {}),
      artifacts: adapter.artifacts,
      message: adapter.needsReview
        ? `${options.scope} 범위에 등록했습니다. Codex /hooks에서 정의를 검토하고 신뢰해야 합니다.`
        : `${options.scope} 범위에 MCP와 lifecycle adapter를 등록했습니다.`,
    };
  });
}
