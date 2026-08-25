import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installLifecycleAdapter } from "../src/setup-adapters.js";

describe("installLifecycleAdapter", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "agents-memory-adapter-"));
    roots.push(root);
    const adapterPath = join(root, "adapter-cli.js");
    writeFileSync(adapterPath, "// built adapter\n");
    return { root, adapterPath };
  }

  it("Claude 설정의 기존 hook을 보존하고 lifecycle hook을 멱등 병합한다", () => {
    const { root, adapterPath } = fixture();
    const settingsPath = join(root, ".claude", "settings.json");
    mkdirSync(join(root, ".claude"), { recursive: true });
    const existing = {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing" }] }] },
    };
    writeFileSync(settingsPath, JSON.stringify(existing), { flag: "wx" });

    const options = {
      client: "claude" as const,
      scope: "project" as const,
      nodePath: process.execPath,
      adapterPath,
      projectRoot: root,
      databasePath: join(root, "memory.db"),
    };
    installLifecycleAdapter(options);
    installLifecycleAdapter(options);

    const document = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(document.hooks.SessionStart).toHaveLength(2);
    expect(JSON.stringify(document)).toContain("existing");
    expect(JSON.stringify(document)).toContain(adapterPath);
    expect(JSON.stringify(document)).toContain(join(root, "memory.db"));
  });

  it("Codex hooks 파일과 GJC extension 파일을 생성한다", () => {
    const { root, adapterPath } = fixture();
    const codex = installLifecycleAdapter({
      client: "codex",
      scope: "project",
      nodePath: process.execPath,
      adapterPath,
      projectRoot: root,
    });
    const gjc = installLifecycleAdapter({
      client: "gjc",
      scope: "project",
      nodePath: process.execPath,
      adapterPath,
      projectRoot: root,
    });

    expect(codex.needsReview).toBe(true);
    expect(readFileSync(codex.artifacts[0] ?? "", "utf8")).toContain("UserPromptSubmit");
    expect(readFileSync(gjc.artifacts[0] ?? "", "utf8")).toContain("session_start");
    expect(readFileSync(gjc.artifacts[4] ?? "", "utf8")).toContain("memory://context/current");
    expect(readFileSync(gjc.artifacts[4] ?? "", "utf8")).toContain("memory.revalidate");
    expect(readFileSync(gjc.artifacts[4] ?? "", "utf8")).toContain("memory.handoff");
  });
});
