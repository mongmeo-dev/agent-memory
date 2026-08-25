import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { configuredDatabasePath, setConfiguredDatabasePath } from "../src/config.js";

describe("local configuration", () => {
  it("custom database 절대 경로를 mode-safe JSON으로 왕복한다", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-memory-config-"));
    const configPath = join(root, "nested", "config.json");
    try {
      const databasePath = join(root, "memory.db");
      setConfiguredDatabasePath(databasePath, configPath);
      expect(configuredDatabasePath(configPath)).toBe(databasePath);
      expect(() => setConfiguredDatabasePath("relative.db", configPath)).toThrow("절대 경로");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
