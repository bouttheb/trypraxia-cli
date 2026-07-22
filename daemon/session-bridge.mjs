import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { redactDeep } from "./run-capture.mjs";

const MAX_TRANSCRIPT_TOOL_ROWS = 20_000;
const MAX_TRANSCRIPT_ROW_BYTES = 200_000;
const FULL_PARSE_BYTES = 40_000_000;
const SAMPLE_HEAD_BYTES = 4_000_000;
const SAMPLE_TAIL_BYTES = 16_000_000;

const seen = new Map();
const MAX_AGE_MS = 30 * 86_400_000;
const MAX_FILES = 160;
const MAX_FILE_BYTES = 4_000_000_000;

export function scanLocalAgentSessions(now = Date.now(), options = {}) {
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : MAX_AGE_MS;
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : MAX_FILES;
  const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : Number.POSITIVE_INFINITY;
  const ignoreSeen = options.ignoreSeen === true;
  const roots = [
    { source: "codex", path: join(homedir(), ".codex", "sessions") },
    { source: "claude", path: join(homedir(), ".claude", "projects") },
  ];
  const candidates = roots.flatMap((root) => walkJsonl(root.path).map((path) => ({ ...root, path })))
    .map((entry) => ({ ...entry, stat: safeStat(entry.path) }))
    .filter((entry) => entry.stat && now - entry.stat.mtimeMs <= maxAgeMs && entry.stat.size <= MAX_FILE_BYTES)
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, maxFiles);
  const events = [];
  for (const entry of candidates) {
    if (events.length >= maxSessions) break;
    const marker = `${entry.stat.mtimeMs}:${entry.stat.size}`;
    if (!ignoreSeen && seen.get(entry.path) === marker) continue;
    try {
      const parsed = entry.source === "codex" ? parseCodex(entry.path, entry.stat.mtimeMs, now) : parseClaude(entry.path, entry.stat.mtimeMs, now);
      if (parsed) events.push(parsed);
      seen.set(entry.path, marker);
    } catch {
      // A partially-written JSONL file is retried when its mtime changes.
    }
  }
  return events;
}

function parseCodex(path, mtimeMs, now) {
  const rows = sessionJsonLines(path);
  const meta = rows.find((row) => row.type === "session_meta")?.payload ?? {};
  const messages = rows.filter((row) => row.type === "response_item" && row.payload?.type === "message");
  const users = messages.map(messageText).filter((row) => row.role === "user" && usableUserText(row.text));
  const user = users.at(-1);
  const assistant = messages.map(messageText).filter((row) => row.role === "assistant" && row.text).at(-1);
  if (!meta.cwd || (!user && !assistant)) return null;
  return sessionEvent({
    source: "codex", sessionId: meta.session_id || meta.id || basename(path, ".jsonl"), cwd: meta.cwd,
    title: user?.text || "Codex session", initialGoal: users[0]?.text, summary: assistant?.text || "Codex session is in progress.",
    occurredAt: assistant?.timestamp || user?.timestamp || new Date(mtimeMs).toISOString(),
    status: now - mtimeMs > 5 * 60_000 ? "completed" : "running", path,
    workingDirectories: inferSessionWorkingDirectories(rows, meta.cwd),
  });
}

function parseClaude(path, mtimeMs, now) {
  const rows = sessionJsonLines(path).filter((row) => (row.type === "user" || row.type === "assistant") && row.message);
  const users = rows.map(claudeMessageText).filter((row) => row.role === "user" && usableUserText(row.text));
  const user = users.at(-1);
  const assistant = rows.map(claudeMessageText).filter((row) => row.role === "assistant" && row.text).at(-1);
  const representative = rows.find((row) => row.cwd && row.sessionId);
  if (!representative?.cwd || (!user && !assistant)) return null;
  return sessionEvent({
    source: "claude", sessionId: representative.sessionId || basename(path, ".jsonl"), cwd: representative.cwd,
    title: user?.text || "Claude session", initialGoal: users[0]?.text, summary: assistant?.text || "Claude session is in progress.",
    occurredAt: assistant?.timestamp || user?.timestamp || new Date(mtimeMs).toISOString(),
    status: now - mtimeMs > 5 * 60_000 ? "completed" : "running", path,
    workingDirectories: inferSessionWorkingDirectories(rows, representative.cwd),
  });
}

function sessionEvent(input) {
  const title = clean(input.title).slice(0, 220);
  const initialGoal = clean(input.initialGoal || input.title).slice(0, 2000);
  const summary = clean(input.summary).slice(0, 6000);
  return {
    source: input.source, sessionId: input.sessionId, workingDirectory: input.cwd,
    workingDirectories: input.workingDirectories ?? [],
    title: title.length > 180 ? `${title.slice(0, 177)}...` : title,
    summary, detail: `Initial goal: ${initialGoal}\n\nLatest request: ${title}\n\nLatest agent report: ${summary}`.slice(0, 12_000),
    status: input.status, occurredAt: input.occurredAt,
    evidence: { sessionFile: input.path, capturedAt: new Date().toISOString() },
    metadata: { ingestion: "local_session_bridge", transcriptStored: false },
  };
}

/**
 * Infer the repositories a session actually touched. Desktop sessions often
 * start at ~/dev, so the session-level cwd alone is not enough to attribute
 * the work. Codex turn contexts and tool arguments, and Claude tool inputs,
 * carry the real workdir/file paths.
 */
export function inferSessionWorkingDirectories(rows, fallbackCwd = "") {
  const paths = [];
  const add = (value) => {
    if (typeof value !== "string" || !value.trim()) return;
    const expanded = value.trim() === "~"
      ? homedir()
      : value.trim().startsWith("~/")
        ? join(homedir(), value.trim().slice(2))
        : value.trim();
    if (!isAbsolute(expanded)) return;
    const root = nearestRepoRoot(expanded);
    if (root && !paths.includes(root)) paths.push(root);
  };
  // A desktop task can stay open for days and touch several repositories.
  // Route it by the most recent evidence, while retaining every touched repo
  // in the receipt metadata. Otherwise an old tool call can permanently own
  // all later work in the same Codex/Claude session.
  for (const row of [...rows].reverse()) {
    add(row?.cwd);
    add(row?.payload?.cwd);
    for (const root of [...(row?.payload?.workspace_roots ?? [])].reverse()) add(root);
    collectToolPaths(row?.payload?.input, add);
    collectToolPaths(row?.payload?.arguments, add);
    for (const item of [...(Array.isArray(row?.message?.content) ? row.message.content : [])].reverse()) {
      if (item?.type === "tool_use") collectToolPaths(item.input, add);
    }
  }
  add(fallbackCwd);
  return paths;
}

function collectToolPaths(value, add) {
  if (typeof value === "string") {
    try {
      collectToolPaths(JSON.parse(value), add);
    } catch {
      for (const match of value.matchAll(/(?:^|\s)(\/(?:Users|Volumes|private|tmp)\/[^\s'";]+)/g)) add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolPaths(item, add);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (["cwd", "workdir", "workingDirectory", "file_path", "filePath", "path"].includes(key)) add(item);
    else if (key === "command" || typeof item === "object") collectToolPaths(item, add);
  }
}

function nearestRepoRoot(path) {
  let current = resolve(path);
  try {
    if (existsSync(current) && !statSync(current).isDirectory()) current = dirname(current);
  } catch {
    current = dirname(current);
  }
  while (current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    current = dirname(current);
  }
  return null;
}

/**
 * Full redacted JSONL rows of one local agent session, for upload through
 * POST /api/daemon/run-events (source: session_bridge). Redaction happens
 * here, client-side, before any byte leaves the machine.
 */
export async function readSessionTranscript(path, { afterLine = 0 } = {}) {
  const semantic = [];
  const tools = [];
  let lineNumber = 0;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber <= afterLine) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const kind = transcriptRowKind(row);
    if (!kind) continue;
    const entry = { lineNumber, row: truncateTranscriptRow(redactDeep(row)) };
    if (kind === "semantic") semantic.push(entry);
    else {
      tools.push(entry);
      if (tools.length > MAX_TRANSCRIPT_TOOL_ROWS) tools.shift();
    }
  }
  const events = [...semantic, ...tools]
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((entry) => ({ seq: entry.lineNumber - 1, payload: entry.row }));
  return { events, lastLine: lineNumber };
}

function transcriptRowKind(row) {
  if (row?.type === "session_meta") return "semantic";
  if (row?.type === "response_item") {
    if (row?.payload?.type === "message") return "semantic";
    if (["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "web_search_call"]
      .includes(row?.payload?.type)) return "tool";
  }
  if ((row?.type === "user" || row?.type === "assistant") && row?.message) return "semantic";
  return null;
}

function truncateTranscriptRow(row) {
  const serialized = JSON.stringify(row);
  if (Buffer.byteLength(serialized) <= MAX_TRANSCRIPT_ROW_BYTES) return row;
  const compacted = structuredClone(row);
  if (Array.isArray(compacted?.payload?.content)) compacted.payload.content = compactContent(compacted.payload.content);
  if (Array.isArray(compacted?.message?.content)) compacted.message.content = compactContent(compacted.message.content);
  if (Buffer.byteLength(JSON.stringify(compacted)) <= MAX_TRANSCRIPT_ROW_BYTES) return compacted;
  return {
    type: "truncated_event",
    original_type: typeof row?.type === "string" ? row.type : null,
    text: serialized.slice(0, MAX_TRANSCRIPT_ROW_BYTES),
    truncated: true,
  };
}

function compactContent(content) {
  return content.map((item) => {
    if (!item || typeof item !== "object") return item;
    const copy = { ...item };
    if (typeof copy.text === "string" && copy.text.length > 100_000) {
      copy.text = `${copy.text.slice(0, 100_000)}\n[TRUNCATED]`;
    }
    if (typeof copy.content === "string" && copy.content.length > 80_000) {
      copy.content = `${copy.content.slice(0, 80_000)}\n[TRUNCATED]`;
    }
    if (Array.isArray(copy.content)) copy.content = compactContent(copy.content);
    return copy;
  });
}

function messageText(row) {
  return { role: row.payload?.role, timestamp: row.timestamp, text: contentText(row.payload?.content) };
}

function claudeMessageText(row) {
  return { role: row.message?.role, timestamp: row.timestamp, text: contentText(row.message?.content) };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text" || item?.type === "input_text" || item?.type === "output_text").map((item) => item.text || "").join(" ");
}

function usableUserText(text) {
  const value = clean(text);
  return value.length > 3 && !value.startsWith("<") && !value.startsWith("You are working inside a Praxia-managed") ? true : value.includes("Original request:");
}

function clean(value) {
  return String(value || "")
    .replace(/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/(postgres(?:ql)?:\/\/)[^\s)]+/gi, "$1[REDACTED_DATABASE_URL]")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonLines(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

// Session receipts only need the immutable header and the newest messages/tool
// paths. Large historical JSONL files can exceed a gigabyte, so sampling the
// head and tail keeps the five-second watcher bounded; the transcript uploader
// above separately streams every semantic message across the entire file.
function sessionJsonLines(path) {
  const size = safeStat(path)?.size ?? 0;
  if (size <= FULL_PARSE_BYTES) return jsonLines(path);
  const descriptor = openSync(path, "r");
  try {
    const head = Buffer.alloc(Math.min(SAMPLE_HEAD_BYTES, size));
    readSync(descriptor, head, 0, head.length, 0);
    const tailLength = Math.min(SAMPLE_TAIL_BYTES, Math.max(0, size - head.length));
    const tail = Buffer.alloc(tailLength);
    if (tailLength > 0) readSync(descriptor, tail, 0, tailLength, size - tailLength);
    const tailText = tail.toString("utf8").replace(/^[^\n]*\n?/, "");
    return `${head.toString("utf8")}\n${tailText}`
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally {
    closeSync(descriptor);
  }
}

function walkJsonl(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !path.includes("/subagents/")) files.push(path);
    }
  }
  return files;
}

function safeStat(path) { try { return statSync(path); } catch { return null; } }
