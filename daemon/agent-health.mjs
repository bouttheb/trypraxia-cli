import { spawn } from "node:child_process";
import { homedir } from "node:os";

// Auth failures are terminal until a human runs `claude /login` (or `codex
// login`) on the daemon Mac. Unlike quota signals, retrying does nothing, so
// the daemon opens a circuit breaker per agent: it stops claiming work for
// that agent, holds anything already claimed, and probes for recovery instead
// of burning every queued command one by one (the 2026-07-19 outage mode).
// Patterns match only against failed runs, mirroring PLAN_QUOTA_PATTERNS.
export const AUTH_FAILURE_PATTERNS = [
  "oauth token has expired",
  "token has expired",
  "please run /login",
  "please run `/login`",
  "invalid api key",
  "authentication_error",
  "authentication failed",
  "not logged in",
  "please run codex login",
  "run `codex login`",
  "401 unauthorized",
];

// Only subscription/CLI-login agents get breaker treatment; the others fail
// for reasons a probe cannot verify.
export const AUTH_GUARDED_AGENTS = new Set(["claude", "codex", "gemini", "kimi"]);

export function detectAuthFailure(result) {
  const haystack = `${result?.result || ""}\n${result?.error || ""}`.toLowerCase();
  return AUTH_FAILURE_PATTERNS.find((pattern) => haystack.includes(pattern)) || null;
}

export function createAgentHealth({ probeIntervalMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const state = new Map();
  return {
    isHealthy(agent) {
      return state.get(agent)?.ok !== false;
    },
    markAuthFailure(agent, signal) {
      const prior = state.get(agent);
      state.set(agent, {
        ok: false,
        signal,
        since: prior?.ok === false ? prior.since : now(),
        lastProbeAt: prior?.ok === false ? prior.lastProbeAt : 0,
      });
    },
    markHealthy(agent) {
      state.set(agent, { ok: true, checkedAt: now() });
    },
    dueForProbe(agent) {
      const entry = state.get(agent);
      if (!entry || entry.ok) return false;
      return now() - (entry.lastProbeAt || 0) >= probeIntervalMs;
    },
    noteProbe(agent) {
      const entry = state.get(agent);
      if (entry && !entry.ok) entry.lastProbeAt = now();
    },
    unhealthyAgents() {
      return [...state.entries()].filter(([, entry]) => !entry.ok).map(([agent]) => agent);
    },
    snapshot() {
      const agents = {};
      for (const [agent, entry] of state.entries()) {
        agents[agent] = entry.ok
          ? { ok: true, checkedAt: new Date(entry.checkedAt).toISOString() }
          : { ok: false, signal: entry.signal, since: new Date(entry.since).toISOString() };
      }
      return agents;
    },
  };
}

// Cheap end-to-end auth check: run the agent CLI on a trivial prompt and look
// for an auth signal. Exit 0 with no signal = healthy. A quota-capped plan
// also fails the probe, which is the desired behavior — the breaker stays
// open until the agent can actually complete work again.
export function probeAgentAuth(agent, { timeoutMs = 120_000 } = {}) {
  const commands = {
    claude: {
      bin: process.env.CLAUDE_BIN || "claude",
      args: ["-p", "--model", "haiku", "Reply with only the word ok."],
    },
    codex: {
      bin: process.env.CODEX_BIN || "codex",
      // The probe runs from the home directory, which codex does not trust —
      // without --skip-git-repo-check it exits with a trust error that reads
      // as an auth failure and wrongly opens the breaker (seen 7/19 on the
      // first daemon restart after this probe shipped).
      args: ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-c", 'approval_policy="never"', "Reply with only the word ok."],
    },
    gemini: {
      bin: process.env.GEMINI_BIN || "gemini",
      args: ["-p", "Reply with only the word ok.", "--model", "gemini-3.5-flash-lite"],
    },
    kimi: {
      bin: process.env.KIMI_BIN || "kimi",
      args: ["-p", "Reply with only the word ok.", "--model", "kimi-k2.6"],
    },
  };
  const command = commands[agent];
  if (!command) return Promise.resolve({ ok: true, skipped: true });
  return new Promise((resolveProbe) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command.bin, command.args, {
      cwd: homedir(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolveProbe({ ok: false, error: `auth probe timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe({ ok: false, error: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const signal = detectAuthFailure({ result: stdout, error: stderr });
      if (code === 0 && !signal) resolveProbe({ ok: true });
      else resolveProbe({ ok: false, error: signal || stderr.trim().slice(0, 300) || `probe exited ${code}` });
    });
  });
}
