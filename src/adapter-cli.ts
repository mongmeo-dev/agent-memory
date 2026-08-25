#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { type AdapterClient, type AdapterDependencies, ingestAdapterPayload } from "./adapters.js";
import { ingestThroughDaemon } from "./daemon-client.js";
import { MemoryStore } from "./store.js";

const MAX_STDIN_BYTES = 1_048_576;

export function parseAdapterArguments(args: string[]): AdapterClient | null {
  if (args[0] !== "hook" || args[1] !== "--client" || (args.length !== 3 && args.length !== 5)) {
    return null;
  }
  const client = args[2];
  if (args.length === 5) {
    if (args[3] !== "--database" || args[4] === undefined) return null;
    process.env.AGENTS_MEMORY_DB = args[4];
  }
  return client === "claude" || client === "codex" || client === "gjc" ? client : null;
}

export async function readBoundedJson(
  input: AsyncIterable<string | Uint8Array>,
  maximumBytes = MAX_STDIN_BYTES,
): Promise<unknown | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximumBytes) return null;
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Exported hook entrypoint so callers can safely use it without spawning a process. */
export async function runAdapterHook(
  client: AdapterClient,
  input: AsyncIterable<string | Uint8Array>,
  dependencies: AdapterDependencies = {},
): Promise<string> {
  const payload = await readBoundedJson(input);
  if (payload === null) return "";
  const context = ingestAdapterPayload(client, payload, dependencies);
  return formatAdapterOutput(client, payload, context);
}

export function formatAdapterOutput(
  client: AdapterClient,
  payload: unknown,
  context: string,
): string {
  if (context.length === 0) return "";
  const eventName =
    typeof payload === "object" && payload !== null
      ? "hook_event_name" in payload
        ? payload.hook_event_name
        : "event" in payload
          ? payload.event
          : undefined
      : undefined;
  if ((client === "claude" || client === "codex") && typeof eventName === "string") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: context,
      },
    });
  }
  return JSON.stringify({
    customType: "agents-memory-context",
    display: false,
    content: context,
  });
}

async function main(): Promise<void> {
  const client = parseAdapterArguments(process.argv.slice(2));
  if (client === null) return;
  try {
    const payload = await readBoundedJson(process.stdin);
    if (payload === null) return;
    const daemonContext = await ingestThroughDaemon(client, payload);
    let output: string;
    if (daemonContext !== null) {
      output = formatAdapterOutput(client, payload, daemonContext);
    } else {
      const store = new MemoryStore();
      try {
        output = formatAdapterOutput(
          client,
          payload,
          ingestAdapterPayload(client, payload, { store }),
        );
      } finally {
        store.close();
      }
    }
    if (output.length > 0) process.stdout.write(`${output}\n`);
  } catch {
    // Hook callers must never be blocked by collection failures.
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main();
}

export { MAX_STDIN_BYTES };
