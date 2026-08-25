#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { ensureDaemonToken } from "./daemon-auth.js";
import { replaySpool } from "./spool.js";
import { MemoryStore } from "./store.js";
import { createManagementServer } from "./web.js";

export async function runDaemon(): Promise<void> {
  const store = new MemoryStore();
  const server = createManagementServer(store, {
    host: "127.0.0.1",
    port: Number(process.env.AGENTS_MEMORY_DAEMON_PORT ?? "3789"),
    token: ensureDaemonToken(),
  });
  replaySpool(store);
  const replayTimer = setInterval(() => replaySpool(store), 5_000);
  replayTimer.unref();
  await server.start();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  clearInterval(replayTimer);
  await server.stop();
  store.close();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDaemon().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
