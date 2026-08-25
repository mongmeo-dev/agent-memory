import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { type CommandRunner, setupClients } from "../src/setup.js";

const MCP_PATH = fileURLToPath(import.meta.url);

describe("setupClients", () => {
  it("세 클라이언트의 등록 명령을 dry-run으로 생성한다", () => {
    const results = setupClients({
      clients: ["claude", "codex", "gjc"],
      scope: "user",
      nodePath: "/usr/local/bin/node",
      mcpPath: "/app/dist/mcp.js",
      databasePath: "/data/memory.db",
      dryRun: true,
    });

    expect(results.map((result) => result.status)).toEqual(["planned", "planned", "planned"]);
    expect(results[0]?.command).toEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "-e",
      "AGENTS_MEMORY_DB=/data/memory.db",
      "agents-memory",
      "--",
      "/usr/local/bin/node",
      "/app/dist/mcp.js",
    ]);
    expect(results[1]?.command).toContain("--env");
    expect(results[2]?.command).toContain("--force");
  });

  it("Codex 프로젝트 범위에서는 hook만 설치할 계획을 반환한다", () => {
    const [result] = setupClients({
      clients: ["codex"],
      scope: "project",
      nodePath: process.execPath,
      mcpPath: MCP_PATH,
      dryRun: true,
    });

    expect(result?.status).toBe("planned");
    expect(result?.message).toContain("프로젝트 범위 MCP");
  });

  it("기존 등록을 제거한 뒤 같은 이름으로 다시 등록한다", () => {
    const calls: string[][] = [];
    const runner: CommandRunner = (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stderr: "" };
    };

    const [result] = setupClients(
      {
        clients: ["claude"],
        scope: "user",
        nodePath: process.execPath,
        mcpPath: MCP_PATH,
      },
      runner,
      () => ({ artifacts: ["test-hook"], needsReview: false }),
    );

    expect(result?.status).toBe("configured");
    expect(calls).toEqual([
      ["claude", "--version"],
      ["claude", "mcp", "remove", "--scope", "user", "agents-memory"],
      [
        "claude",
        "mcp",
        "add",
        "--scope",
        "user",
        "agents-memory",
        "--",
        process.execPath,
        MCP_PATH,
      ],
    ]);
  });

  it("설치되지 않은 클라이언트는 실패 대신 건너뛴다", () => {
    const runner: CommandRunner = () => ({
      status: null,
      error: new Error("spawn ENOENT"),
      stderr: "",
    });

    const [result] = setupClients(
      {
        clients: ["gjc"],
        scope: "user",
        nodePath: process.execPath,
        mcpPath: MCP_PATH,
      },
      runner,
    );

    expect(result?.status).toBe("skipped");
  });
});
