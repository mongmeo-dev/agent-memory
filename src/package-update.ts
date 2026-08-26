import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type PackageUpdateRunner = (command: string, args: string[]) => CommandResult;

export interface PackageIdentity {
  name: string;
  version: string;
}

export interface PackageUpdateOptions extends PackageIdentity {
  nodePath: string;
}

export interface PackageUpdateResult {
  status: "updated" | "up-to-date";
  previousVersion: string;
  version: string;
  setup?: unknown;
}

const defaultRunner: PackageUpdateRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

function runChecked(
  runner: PackageUpdateRunner,
  command: string,
  args: string[],
  description: string,
): string {
  const result = runner(command, args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    throw new Error(`${description}: ${detail}`);
  }
  return result.stdout.trim();
}

export function installedPackageIdentity(): PackageIdentity {
  const document: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof document !== "object" ||
    document === null ||
    !("name" in document) ||
    typeof document.name !== "string" ||
    !("version" in document) ||
    typeof document.version !== "string"
  ) {
    throw new Error("The installed package metadata is invalid.");
  }
  return { name: document.name, version: document.version };
}

export function updateGlobalPackage(
  options: PackageUpdateOptions,
  runner: PackageUpdateRunner = defaultRunner,
): PackageUpdateResult {
  const target = `${options.name}@latest`;
  const latestVersion = runChecked(
    runner,
    "npm",
    ["view", target, "version", "--prefer-online"],
    "Unable to check the latest NPM version",
  );
  if (latestVersion.length === 0 || latestVersion.includes("\n")) {
    throw new Error("The NPM registry returned an invalid package version.");
  }
  if (latestVersion === options.version) {
    return {
      status: "up-to-date",
      previousVersion: options.version,
      version: options.version,
    };
  }

  runChecked(
    runner,
    "npm",
    ["install", "--global", target, "--prefer-online"],
    "Unable to install the latest NPM package",
  );
  const globalRoot = runChecked(
    runner,
    "npm",
    ["root", "--global"],
    "Unable to locate the global NPM package directory",
  );
  if (globalRoot.length === 0) {
    throw new Error("NPM returned an empty global package directory.");
  }
  const installedCliPath = join(globalRoot, options.name, "dist", "cli.js");
  const installedVersion = runChecked(
    runner,
    options.nodePath,
    [installedCliPath, "--version"],
    "Unable to verify the installed package version",
  );
  if (installedVersion !== latestVersion) {
    throw new Error(
      `The installed package version is ${installedVersion || "unknown"}, but NPM latest is ${latestVersion}.`,
    );
  }

  const setupOutput = runChecked(
    runner,
    options.nodePath,
    [installedCliPath, "setup", "all"],
    "The package was updated, but client setup failed",
  );
  let setup: unknown;
  try {
    setup = JSON.parse(setupOutput);
  } catch {
    throw new Error("The package was updated, but client setup returned invalid output.");
  }

  return {
    status: "updated",
    previousVersion: options.version,
    version: installedVersion,
    setup,
  };
}
