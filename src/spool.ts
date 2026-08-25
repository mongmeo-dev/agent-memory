import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { projectLifecycleEvent } from "./projector.js";
import { redact } from "./redaction.js";
import type { MemoryStore } from "./store.js";
import type { IngestEventInput } from "./types.js";

const MAX_SPOOL_BYTES = 32 * 1024 * 1024;
const MAX_SPOOL_FILES = 10_000;

export function defaultSpoolPath(): string {
  return `${process.env.HOME ?? process.cwd()}/.agents-memory/spool`;
}

function spoolFiles(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

export function readSpoolLossCount(directory = defaultSpoolPath()): number {
  try {
    const value = Number.parseInt(readFileSync(join(directory, "loss-count"), "utf8"), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function addSpoolLosses(directory: string, count: number): void {
  if (count === 0) return;
  const path = join(directory, "loss-count");
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, String(readSpoolLossCount(directory) + count), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function enforceLimits(directory: string): void {
  const files = spoolFiles(directory);
  let total = files.reduce((sum, name) => {
    try {
      return sum + statSync(join(directory, name)).size;
    } catch {
      return sum;
    }
  }, 0);
  let removed = 0;
  while (files.length > MAX_SPOOL_FILES || total > MAX_SPOOL_BYTES) {
    const name = files.shift();
    if (name === undefined) break;
    const path = join(directory, name);
    try {
      total -= statSync(path).size;
      rmSync(path, { force: true });
      removed += 1;
    } catch {
      // A concurrent replay may already have removed the file.
    }
  }
  addSpoolLosses(directory, removed);
}

export function spoolEvent(
  input: IngestEventInput,
  directory = defaultSpoolPath(),
  customPatterns: readonly string[] = [],
): string {
  const safeInput = {
    ...input,
    content: redact(input.content, customPatterns).text,
    automatic: true,
  };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const timestamp = Date.now().toString().padStart(13, "0");
  const id = input.id ?? crypto.randomUUID();
  const path = join(directory, `${timestamp}-${id}.json`);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(safeInput), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  enforceLimits(directory);
  return path;
}

export function replaySpool(store: MemoryStore, directory = defaultSpoolPath()): number {
  if (store.getCollectionSettings().paused) return 0;
  let replayed = 0;
  for (const name of spoolFiles(directory)) {
    const path = join(directory, name);
    try {
      const input = JSON.parse(readFileSync(path, "utf8")) as IngestEventInput;
      const event = store.ingestEvent({ ...input, automatic: true });
      projectLifecycleEvent(store, event);
      rmSync(path, { force: true });
      replayed += 1;
    } catch {
      break;
    }
  }
  return replayed;
}
