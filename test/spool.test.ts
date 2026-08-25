import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { replaySpool, spoolEvent } from "../src/spool.js";
import { MemoryStore } from "../src/store.js";

const input = {
  id: "spooled-event",
  type: "tool.failed",
  content: "password=plain-secret",
  agent: "claude",
  projectId: "project-a",
  branch: "main",
  headCommit: "abc",
  automatic: true,
} as const;

describe("event spool", () => {
  it("redaction된 이벤트만 저장하고 SQLite로 멱등 replay한다", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-memory-spool-"));
    const store = new MemoryStore(":memory:");
    try {
      const path = spoolEvent(input, directory);
      const persisted = readFileSync(path, "utf8");
      expect(persisted).not.toContain("plain-secret");
      expect(persisted).toContain("[REDACTED]");

      expect(replaySpool(store, directory)).toBe(1);
      expect(store.getEvent(input.id)?.content).toBe("password=[REDACTED]");
      expect(readdirSync(directory)).toHaveLength(0);
      expect(replaySpool(store, directory)).toBe(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("수집 pause 중에는 spool을 replay하지 않는다", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-memory-spool-"));
    const store = new MemoryStore(":memory:");
    try {
      spoolEvent(input, directory);
      const settings = store.getCollectionSettings();
      store.setCollectionSettings({ ...settings, paused: true });
      expect(replaySpool(store, directory)).toBe(0);
      expect(readdirSync(directory)).toHaveLength(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("사용자 redaction pattern을 spool 영구 저장 전 적용한다", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-memory-spool-"));
    try {
      const path = spoolEvent(
        { ...input, id: "custom-pattern", content: "CUSTOM-12345" },
        directory,
        ["CUSTOM-[0-9]+"],
      );
      expect(readFileSync(path, "utf8")).not.toContain("CUSTOM-12345");
      expect(readFileSync(path, "utf8")).toContain("[REDACTED]");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
