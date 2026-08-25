import type { AdapterClient } from "./adapters.js";
import { readDaemonToken } from "./daemon-auth.js";

export async function ingestThroughDaemon(
  client: AdapterClient,
  payload: unknown,
  options: { port?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const token = readDaemonToken();
  if (token === null) return null;
  try {
    const response = await fetch(
      `http://127.0.0.1:${options.port ?? Number(process.env.AGENTS_MEMORY_DAEMON_PORT ?? "3789")}/api/adapter`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ client, payload }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 150),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { context?: unknown };
    return typeof body.context === "string" ? body.context : null;
  } catch {
    return null;
  }
}
