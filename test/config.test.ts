import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  autoUseStatus,
  configuredAutoUse,
  configuredDatabasePath,
  configuredEmbedding,
  configuredProjectAutoUse,
  setConfiguredAutoUse,
  setConfiguredDatabasePath,
  setConfiguredEmbedding,
  setConfiguredProjectAutoUse,
} from "../src/config.js";

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

  it("embedding endpoint와 model을 database 설정과 함께 보존한다", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-memory-embedding-config-"));
    const configPath = join(root, "nested", "config.json");
    try {
      setConfiguredEmbedding(
        {
          endpoint: "http://127.0.0.1:11434/v1/embeddings",
          model: " qwen3-embedding:0.6b ",
        },
        configPath,
      );
      const databasePath = join(root, "memory.db");
      setConfiguredDatabasePath(databasePath, configPath);

      expect(configuredEmbedding(configPath)).toEqual({
        endpoint: "http://127.0.0.1:11434/v1/embeddings",
        model: "qwen3-embedding:0.6b",
      });
      expect(configuredDatabasePath(configPath)).toBe(databasePath);

      setConfiguredEmbedding(null, configPath);
      expect(configuredEmbedding(configPath)).toBeNull();
      expect(configuredDatabasePath(configPath)).toBe(databasePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("embedding 설정의 URL과 model을 검증한다", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-memory-invalid-embedding-"));
    const configPath = join(root, "config.json");
    try {
      expect(() =>
        setConfiguredEmbedding({ endpoint: "file:///tmp/model", model: "model" }, configPath),
      ).toThrow("HTTP 또는 HTTPS");
      expect(() =>
        setConfiguredEmbedding({ endpoint: "http://localhost:11434", model: " " }, configPath),
      ).toThrow("비어 있을 수 없습니다");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("자동 사용 기본값은 off이고 project 설정이 전역 설정보다 우선한다", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-memory-auto-use-"));
    const configPath = join(root, "config.json");
    try {
      expect(configuredAutoUse(configPath)).toBe(false);
      expect(autoUseStatus("project-a", configPath)).toEqual({
        enabled: false,
        source: "default",
      });

      setConfiguredAutoUse(true, configPath);
      expect(autoUseStatus("project-a", configPath)).toEqual({
        enabled: true,
        source: "configuration",
      });

      setConfiguredProjectAutoUse("project-a", false, configPath);
      expect(configuredProjectAutoUse("project-a", configPath)).toBe(false);
      expect(autoUseStatus("project-a", configPath)).toEqual({
        enabled: false,
        source: "project",
      });

      setConfiguredProjectAutoUse("project-a", null, configPath);
      expect(configuredProjectAutoUse("project-a", configPath)).toBeNull();
      expect(autoUseStatus("project-a", configPath).enabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
