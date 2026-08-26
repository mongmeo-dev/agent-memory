import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ensureDaemonToken } from "./daemon-auth.js";

export interface DaemonInstallOptions {
  nodePath: string;
  daemonPath: string;
  databasePath?: string;
  dryRun?: boolean;
}

export interface DaemonInstallResult {
  status: "configured" | "failed" | "planned" | "unsupported";
  artifact: string | null;
  message: string;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.agents-memory.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function installDaemonService(options: DaemonInstallOptions): DaemonInstallResult {
  if (!existsSync(options.daemonPath) && options.dryRun !== true) {
    throw new Error(`Daemon executable not found: ${options.daemonPath}`);
  }
  if (process.platform === "darwin") {
    const artifact = join(homedir(), "Library", "LaunchAgents", "dev.agents-memory.daemon.plist");
    if (options.dryRun === true) {
      return { status: "planned", artifact, message: "Will install the launchd user service." };
    }
    ensureDaemonToken();
    writeAtomic(
      artifact,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.agents-memory.daemon</string>
<key>ProgramArguments</key><array><string>${xml(options.nodePath)}</string><string>${xml(options.daemonPath)}</string></array>
${options.databasePath === undefined ? "" : `<key>EnvironmentVariables</key><dict><key>AGENTS_MEMORY_DB</key><string>${xml(options.databasePath)}</string></dict>`}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(homedir(), ".agents-memory", "daemon.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(homedir(), ".agents-memory", "daemon-error.log"))}</string>
</dict></plist>
`,
    );
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try {
      execFileSync("/bin/launchctl", ["bootout", domain, artifact], { stdio: "ignore" });
    } catch {
      // A missing previous service is expected on first install.
    }
    try {
      execFileSync("/bin/launchctl", ["bootstrap", domain, artifact], { stdio: "ignore" });
    } catch (error) {
      return {
        status: "failed",
        artifact,
        message: `Failed to start the launchd service: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { status: "configured", artifact, message: "Started the launchd user service." };
  }
  if (process.platform === "linux") {
    const artifact = join(homedir(), ".config", "systemd", "user", "agents-memory.service");
    if (options.dryRun === true) {
      return { status: "planned", artifact, message: "Will install the systemd user service." };
    }
    ensureDaemonToken();
    writeAtomic(
      artifact,
      `[Unit]
Description=Agents Memory daemon
After=default.target

[Service]
ExecStart=${options.nodePath} ${options.daemonPath}
${options.databasePath === undefined ? "" : `Environment=${JSON.stringify(`AGENTS_MEMORY_DB=${options.databasePath}`)}`}
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
`,
    );
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "agents-memory.service"], {
        stdio: "ignore",
      });
      execFileSync("systemctl", ["--user", "restart", "agents-memory.service"], {
        stdio: "ignore",
      });
    } catch (error) {
      return {
        status: "failed",
        artifact,
        message: `Failed to start the systemd user service: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { status: "configured", artifact, message: "Started the systemd user service." };
  }
  return {
    status: "unsupported",
    artifact: null,
    message: `Service installation is not supported on ${process.platform}.`,
  };
}
