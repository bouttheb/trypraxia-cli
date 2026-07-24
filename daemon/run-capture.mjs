// Transparent Runs raw capture (docs/TRANSPARENT_RUNS.md Phase 1).
//
// Buffers one agent run's raw events to ~/.praxia-cloud/run-events/<id>.jsonl
// (the durability buffer — upload retries survive daemon restarts), redacts
// client-side BEFORE bytes leave the machine, and uploads in chunks to
// POST /api/daemon/run-events after the run finishes. Files are deleted only
// after the server acknowledges every chunk.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_RUN_EVENTS_DIR = join(homedir(), ".praxia-cloud", "run-events");
const MAX_EVENT_BYTES = 256_000; // one oversized tool dump can't sink an upload
const CHUNK_EVENTS = 500;
const CHUNK_BYTES = 1_000_000;

// Attempts within one command must not collide on seq — attempt N starts here.
export const ATTEMPT_SEQ_STRIDE = 1_000_000;

const REDACTION_PATTERNS = [
  [/(api[_-]?key|secret|token|password)(\s*[:=]\s*)["']?[^"'\s]+/gi, "$1$2[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key-id]"],
  [/\baws_secret_access_key\b[^\n]*/gi, "aws_secret_access_key=[REDACTED:aws-secret]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED:github-token]"],
  [/\b[rs]k_(live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED:stripe-key]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:api-key]"],
  [/\bpx[dm]_[A-Za-z0-9]{16,}\b/g, "[REDACTED:praxia-token]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:slack-token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED:jwt]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}/gi, "Bearer [REDACTED]"],
  [/\bAuthorization:\s*\S+\s+\S+/gi, "Authorization: [REDACTED]"],
  [/(postgres(?:ql)?:\/\/)[^\s)"']+/gi, "$1[REDACTED:database-url]"],
  [/\b([A-Z][A-Z0-9_]{2,}_(?:KEY|TOKEN|SECRET|PASSWORD))=[^\s"']+/g, "$1=[REDACTED]"],
];

export function redactText(value) {
  // PostgreSQL json/jsonb rejects the NUL code point even though it is valid
  // in JSON strings. Tool output can contain raw binary fragments (for
  // example .DS_Store bytes), so normalize NULs before a captured event ever
  // leaves the daemon. The API repeats this normalization as a trust-boundary
  // safeguard for older daemons and other capture clients.
  let out = String(value).replaceAll("\u0000", "[NUL]");
  for (const [pattern, replacement] of REDACTION_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// Redacts string VALUES recursively so JSON structure survives — running the
// key=value regexes across serialized JSON would corrupt it.
export function redactDeep(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactDeep(entry);
    return out;
  }
  return value;
}

function truncatePayload(payload) {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) <= MAX_EVENT_BYTES) return payload;
  return {
    type: "truncated_event",
    original_type: typeof payload?.type === "string" ? payload.type : null,
    text: serialized.slice(0, MAX_EVENT_BYTES),
    truncated: true,
  };
}

/**
 * One run's capture. mode "stream" treats each stdout line as a JSON event
 * (claude stream-json / codex --json); mode "raw" collects everything into a
 * single raw_text event at finalize — still better than nothing, and the
 * deriver can improve later without daemon changes.
 */
export function createRunCapture({
  id,
  commandId = null,
  projectId = null,
  organizationId = null,
  agent,
  source = "daemon_run",
  mode = "raw",
  dir = DEFAULT_RUN_EVENTS_DIR,
  seqOffset = 0,
}) {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${id}.jsonl`);
  let seq = seqOffset;
  let pending = "";
  let rawText = "";
  let lastAssistantText = "";
  let eventCount = 0;
  let finalResultText = null;
  let finalized = false;

  const writeEvent = (payload) => {
    const redacted = truncatePayload(redactDeep(payload));
    appendFileSync(filePath, `${JSON.stringify({ seq, payload: redacted })}\n`);
    seq += 1;
    eventCount += 1;
  };

  const absorbLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      writeEvent({ type: "raw_text", text: trimmed });
      return;
    }
    if (event?.type === "result" && typeof event.result === "string") {
      finalResultText = event.result;
    }
    if (event?.type === "assistant") {
      const content = event.message?.content;
      const text = Array.isArray(content)
        ? content
            .filter((item) => item?.type === "text")
            .map((item) => item.text || "")
            .join(" ")
            .trim()
        : typeof content === "string"
          ? content
          : "";
      if (text) lastAssistantText = text;
    }
    writeEvent(event);
  };

  return {
    filePath,
    meta: { id, commandId, projectId, organizationId, agent, source },
    write(chunk) {
      const text = chunk.toString();
      if (mode === "raw") {
        rawText += text;
        return;
      }
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) absorbLine(line);
    },
    finalize() {
      if (finalized) return { filePath, eventCount };
      finalized = true;
      if (mode === "raw") {
        if (rawText.trim()) writeEvent({ type: "raw_text", text: rawText.trim() });
      } else if (pending.trim()) {
        absorbLine(pending);
        pending = "";
      }
      // A meta trailer so the flush sweep can upload files from crashed runs
      // without any in-memory state.
      appendFileSync(filePath, `${JSON.stringify({ meta: this.meta })}\n`);
      return { filePath, eventCount };
    },
    /** Final assistant text from the stream (claude's result event), for use
     *  as the command result when no --output-last-message file exists. */
    finalText() {
      return finalResultText;
    },
    /** Last assistant message seen so progress updates can stay readable
     *  even though stdout is now JSONL. */
    progressText() {
      return lastAssistantText;
    },
    eventCount() {
      return eventCount;
    },
  };
}

function parseBufferFile(filePath) {
  const rows = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const events = [];
  let meta = null;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row);
      if (parsed?.meta) meta = parsed.meta;
      else if (parsed && Number.isFinite(parsed.seq)) events.push(parsed);
    } catch {
      // Skip torn lines (daemon crash mid-append); the rest still uploads.
    }
  }
  return { meta, events };
}

/**
 * Upload one buffered run file in chunks through postJson(path, body) — an
 * api() closure bound to a workspace context. Deletes the buffer only after
 * every chunk is acknowledged. Throws on failure so callers can leave the
 * file for the next sweep.
 */
export async function uploadRunCaptureFile(filePath, postJson) {
  const { meta, events } = parseBufferFile(filePath);
  if (!meta || events.length === 0) {
    rmSync(filePath, { force: true });
    return { uploaded: 0, chunks: 0 };
  }
  let chunk = [];
  let chunkBytes = 0;
  let uploaded = 0;
  let chunks = 0;
  const flush = async () => {
    if (chunk.length === 0) return;
    const body = {
      source: meta.source,
      agent: meta.agent,
      commandId: meta.commandId,
      projectId: meta.projectId,
      externalSessionId: meta.externalSessionId ?? null,
      workingDirectory: meta.workingDirectory ?? null,
      events: chunk,
    };
    const response = await postJson("/api/daemon/run-events", body);
    if (!response || response.ok !== true) {
      throw new Error(`run-events upload rejected: ${JSON.stringify(response).slice(0, 300)}`);
    }
    uploaded += chunk.length;
    chunks += 1;
    chunk = [];
    chunkBytes = 0;
  };
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (chunk.length >= CHUNK_EVENTS || (chunkBytes + size > CHUNK_BYTES && chunk.length > 0)) await flush();
    chunk.push(event);
    chunkBytes += size;
  }
  await flush();
  rmSync(filePath, { force: true });
  return { uploaded, chunks };
}

/** Upload every leftover buffer (crashed or previously-failed runs). */
export async function sweepRunCaptureDir(postJson, dir = DEFAULT_RUN_EVENTS_DIR, log = () => {}) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = join(dir, name);
    try {
      // Skip files still being written (a live run appends continuously).
      if (Date.now() - statSync(filePath).mtimeMs < 120_000) continue;
      const { uploaded } = await uploadRunCaptureFile(filePath, postJson);
      if (uploaded > 0) log(`run-events sweep uploaded ${uploaded} event(s) from ${name}`);
    } catch (error) {
      log(`run-events sweep left ${name} for retry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
