import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const CACHE_MS = 5 * 60 * 1000;
let capabilityCache = { checkedAt: 0, rootsKey: "", value: null };

function expandHome(value) {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

export function configuredRepoRoots(env = process.env) {
  const values = (env.PRAXIA_REPO_ROOTS || "~/dev")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(expandHome(value)));
  return [...new Set(values)];
}

export function scanRepoCapabilities(roots = configuredRepoRoots()) {
  const repos = new Map();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const candidates = [root];
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) candidates.push(join(root, entry.name));
      }
    } catch {
      continue;
    }

    for (const candidate of candidates) {
      try {
        if (!existsSync(join(candidate, ".git"))) continue;
        const workingDir = realpathSync(candidate);
        repos.set(workingDir, { name: basename(workingDir), workingDir });
      } catch {
        // A disappearing checkout or unreadable symlink is simply not a
        // capability this daemon should advertise during this scan.
      }
    }
  }

  const inventory = [...repos.values()].sort((a, b) => a.workingDir.localeCompare(b.workingDir));
  return {
    workingDirs: inventory.map((repo) => repo.workingDir),
    repoNames: [...new Set(inventory.map((repo) => repo.name))].sort(),
    repos: inventory,
  };
}

export function fleetRepoCapabilities(now = Date.now()) {
  const roots = configuredRepoRoots();
  const rootsKey = roots.join("\n");
  if (
    capabilityCache.value
    && capabilityCache.rootsKey === rootsKey
    && now - capabilityCache.checkedAt < CACHE_MS
  ) {
    return capabilityCache.value;
  }
  const value = scanRepoCapabilities(roots);
  capabilityCache = { checkedAt: now, rootsKey, value };
  return value;
}
