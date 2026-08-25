import { execFileSync } from "node:child_process";

const SERVICE = "agents-memory-sync";

export interface CredentialStore {
  get(endpointId: string): string | null;
  set(endpointId: string, token: string): void;
  delete(endpointId: string): void;
}

function command(path: string, args: string[], input?: string): string {
  return execFileSync(path, args, {
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    ...(input === undefined ? {} : { input }),
  }).trim();
}

export class SystemCredentialStore implements CredentialStore {
  get(endpointId: string): string | null {
    try {
      if (process.platform === "darwin") {
        return command("/usr/bin/security", [
          "find-generic-password",
          "-s",
          SERVICE,
          "-a",
          endpointId,
          "-w",
        ]);
      }
      if (process.platform === "linux") {
        return command("secret-tool", ["lookup", "service", SERVICE, "endpoint", endpointId]);
      }
      throw new Error(`Unsupported keychain platform: ${process.platform}`);
    } catch {
      return null;
    }
  }

  set(endpointId: string, token: string): void {
    if (token.length < 20) {
      throw new Error("The synchronization token must be at least 20 characters.");
    }
    if (process.platform === "darwin") {
      command("/usr/bin/security", [
        "add-generic-password",
        "-U",
        "-s",
        SERVICE,
        "-a",
        endpointId,
        "-w",
        token,
      ]);
      return;
    }
    if (process.platform === "linux") {
      command(
        "secret-tool",
        ["store", "--label", "Agents Memory sync", "service", SERVICE, "endpoint", endpointId],
        token,
      );
      return;
    }
    throw new Error(`Unsupported keychain platform: ${process.platform}`);
  }

  delete(endpointId: string): void {
    try {
      if (process.platform === "darwin") {
        command("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", endpointId]);
      } else if (process.platform === "linux") {
        command("secret-tool", ["clear", "service", SERVICE, "endpoint", endpointId]);
      }
    } catch {
      // Deleting an absent credential is idempotent.
    }
  }
}
