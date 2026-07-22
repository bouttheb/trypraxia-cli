import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

// Per-run telemetry: every command/job outcome is appended to a local JSONL
// file (durable record of what happened between input and output) and rolled
// into in-memory counters that ride along on the heartbeat so the dashboard
// can show success rates per work kind. Telemetry must never break the daemon
// — every filesystem write is best-effort.
export function createTelemetry({ path = null, maxBytes = 5_000_000, now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  const counters = new Map(); // kind -> { total, byStatus, totalDurationMs, durationSamples }

  function record(event) {
    const kind = typeof event?.kind === "string" && event.kind ? event.kind : "event";
    const entry = counters.get(kind) || { total: 0, byStatus: {}, totalDurationMs: 0, durationSamples: 0 };
    entry.total += 1;
    const status = typeof event.status === "string" && event.status
      ? event.status
      : event.ok === true ? "ok" : event.ok === false ? "failed" : "recorded";
    entry.byStatus[status] = (entry.byStatus[status] || 0) + 1;
    if (Number.isFinite(event.durationMs)) {
      entry.totalDurationMs += event.durationMs;
      entry.durationSamples += 1;
    }
    counters.set(kind, entry);
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
      appendFileSync(path, `${JSON.stringify({ at: now().toISOString(), ...event })}\n`);
    } catch {
      // Best-effort only.
    }
  }

  function summary() {
    const kinds = {};
    for (const [kind, entry] of counters.entries()) {
      kinds[kind] = {
        total: entry.total,
        byStatus: entry.byStatus,
        avgDurationMs: entry.durationSamples ? Math.round(entry.totalDurationMs / entry.durationSamples) : null,
      };
    }
    return { sinceStartedAt: startedAt, kinds };
  }

  return { record, summary };
}
