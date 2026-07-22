// Repo preflight: never run a command against a repo this Mac could not verify.
//
// Claiming is atomic and first-come (`POST /api/commands/claim`), so a daemon
// cannot know which command it will get before it gets one. Preflight therefore
// runs immediately after the claim and BEFORE any agent starts: verify the repo
// is present, points at a plausible origin, and is current with it; fast-forward
// when behind; and when this machine still cannot service the command, release
// the claim so another Mac takes it.
//
// This is the fix for the failure that made a Profess command look "stuck" for
// three days: a Mac whose ~/dev/recall was a never-synced scaffold claimed the
// work, ran an agent that honestly found nothing, and nothing anywhere noticed.
// A daemon must not be able to claim work it has no way of doing.
//
// Design rule: only release on a verified inability. Conditions that are merely
// unusual (not a git repo, no origin, no upstream, detached HEAD) pass with a
// warning — plenty of legitimate Praxia projects are not clean git checkouts,
// and releasing those would bounce good work around the fleet for no reason.

import { execFile as execFileCallback } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const FETCH_TIMEOUT_MS = Number(process.env.PRAXIA_PREFLIGHT_FETCH_TIMEOUT_MS || 90_000);
const GIT_TIMEOUT_MS = Number(process.env.PRAXIA_PREFLIGHT_GIT_TIMEOUT_MS || 20_000);
// The fleet manifest push-sync regenerates nightly from the canonical Mac's
// actual origin remotes. It is the fleet's declared view of where each repo
// lives; used here only to flag a mismatch, never to force a release (GitHub
// redirects renamed repos, so a stale manifest line is not proof of a bad tree).
const MANIFEST_PATH = process.env.PRAXIA_FLEET_MANIFEST || join(homedir(), "dev", "fleet-ops", "repos.txt");

let manifestCache = { mtimeMs: 0, map: new Map() };

export function readFleetManifest(path = MANIFEST_PATH) {
  try {
    const { mtimeMs } = statSync(path);
    if (mtimeMs === manifestCache.mtimeMs && manifestCache.map.size > 0) return manifestCache.map;
    const map = new Map();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      map.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim());
    }
    manifestCache = { mtimeMs, map };
    return map;
  } catch {
    return new Map();
  }
}

// github.com/bouttheb/praxia-cloud — comparable across https/ssh/creds/.git.
export function normalizeRemote(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  let value = url.trim();
  value = value.replace(/^[a-z+]+:\/\//i, "").replace(/^git@/i, "");
  value = value.replace(/^[^@/]*@/, ""); // strip embedded credentials
  value = value.replace(/:/g, "/").replace(/\.git$/i, "").replace(/\/+$/, "");
  return value.toLowerCase() || null;
}

async function git(args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  const { stdout } = await execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function gitOrNull(args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  try {
    return await git(args, cwd, timeoutMs);
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ok: boolean, state: string, summary: string, reason?: string, warnings: string[], detail: object}>}
 *   ok:false means this machine could not verify or update the repo and the
 *   command should be released back to the pool.
 */
export async function preflightRepo({ cwd, skipFetch = false } = {}) {
  const warnings = [];
  const detail = { cwd };

  const topLevel = await gitOrNull(["rev-parse", "--show-toplevel"], cwd);
  if (!topLevel) {
    return pass("not-a-git-repo", "Working directory is not a git repository; preflight skipped.", warnings, detail);
  }
  detail.repoRoot = topLevel;

  const origin = await gitOrNull(["remote", "get-url", "origin"], cwd);
  if (!origin) {
    warnings.push("Repository has no origin remote; currency could not be verified.");
    return pass("no-origin", "No origin remote; preflight skipped.", warnings, detail);
  }
  detail.origin = normalizeRemote(origin);

  const expected = readFleetManifest().get(basename(topLevel));
  if (expected) {
    const expectedNorm = normalizeRemote(expected);
    detail.expectedOrigin = expectedNorm;
    if (expectedNorm && detail.origin && expectedNorm !== detail.origin) {
      // Reported, not fatal: the manifest lags renames (recall -> profess).
      warnings.push(`origin is ${detail.origin} but the fleet manifest expects ${expectedNorm}.`);
    }
  }

  const branch = await gitOrNull(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  detail.branch = branch;
  if (!branch || branch === "HEAD") {
    warnings.push("HEAD is detached; currency could not be verified against a branch.");
    return pass("detached-head", "Detached HEAD; preflight skipped.", warnings, detail);
  }

  if (!skipFetch) {
    try {
      await git(["fetch", "origin", "--prune", "--quiet"], cwd, FETCH_TIMEOUT_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        "fetch-failed",
        `Could not fetch origin for ${basename(topLevel)} (${detail.origin}): ${firstLine(message)}`,
        warnings,
        detail,
      );
    }
  }

  const upstream =
    (await gitOrNull(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd)) ||
    ((await gitOrNull(["rev-parse", "--verify", "--quiet", `origin/${branch}`], cwd)) ? `origin/${branch}` : null);
  if (!upstream) {
    warnings.push(`Branch ${branch} has no upstream on origin; currency could not be verified.`);
    return pass("no-upstream", `Branch ${branch} is local-only; preflight skipped.`, warnings, detail);
  }
  detail.upstream = upstream;

  const counts = await gitOrNull(["rev-list", "--left-right", "--count", `HEAD...${upstream}`], cwd);
  const [aheadRaw, behindRaw] = (counts || "").split(/\s+/);
  const ahead = Number(aheadRaw || 0);
  const behind = Number(behindRaw || 0);
  detail.ahead = Number.isFinite(ahead) ? ahead : 0;
  detail.behind = Number.isFinite(behind) ? behind : 0;

  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return fail("compare-failed", `Could not compare HEAD with ${upstream}.`, warnings, detail);
  }

  if (behind === 0) {
    if (ahead > 0) warnings.push(`${ahead} local commit(s) not yet pushed to ${upstream}.`);
    return pass("current", `Current with ${upstream}${ahead > 0 ? ` (${ahead} ahead)` : ""}.`, warnings, detail);
  }

  if (ahead > 0) {
    return fail(
      "diverged",
      `${basename(topLevel)} has diverged from ${upstream} (${ahead} ahead, ${behind} behind); this Mac cannot fast-forward.`,
      warnings,
      detail,
    );
  }

  const dirty = await gitOrNull(["status", "--porcelain"], cwd);
  if (dirty) {
    detail.dirtyFiles = dirty.split("\n").length;
    return fail(
      "dirty-and-behind",
      `${basename(topLevel)} is ${behind} commit(s) behind ${upstream} and has ${detail.dirtyFiles} uncommitted change(s) blocking a fast-forward.`,
      warnings,
      detail,
    );
  }

  try {
    await git(["merge", "--ff-only", upstream], cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("ff-failed", `Fast-forward to ${upstream} failed: ${firstLine(message)}`, warnings, detail);
  }
  detail.fastForwarded = behind;
  return pass("fast-forwarded", `Fast-forwarded ${behind} commit(s) to ${upstream}.`, warnings, detail);
}

function pass(state, summary, warnings, detail) {
  return { ok: true, state, summary, warnings, detail };
}

function fail(state, reason, warnings, detail) {
  return { ok: false, state, summary: reason, reason, warnings, detail };
}

function firstLine(message) {
  return String(message).split("\n").map((line) => line.trim()).filter(Boolean)[0] || String(message);
}
