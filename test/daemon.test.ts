import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureDaemonToken, readDaemonToken } from "../src/daemon-auth.js";
import { installDaemonService } from "../src/setup-daemon.js";

describe("daemon setup", () => {
  it("creates and reuses a mode-0600 daemon token", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-memory-daemon-"));
    const path = join(root, "nested", "daemon-token");
    try {
      const first = ensureDaemonToken(path);
      expect(first).toHaveLength(43);
      expect(readDaemonToken(path)).toBe(first);
      expect(ensureDaemonToken(path)).toBe(first);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).not.toContain("Bearer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the native service artifact without mutating in dry-run", () => {
    const result = installDaemonService({
      nodePath: process.execPath,
      daemonPath: "/not-built/daemon.js",
      dryRun: true,
    });
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(result.status).toBe("planned");
      expect(result.artifact).toContain(process.platform === "darwin" ? "LaunchAgents" : "systemd");
    } else {
      expect(result.status).toBe("unsupported");
    }
  });
});
