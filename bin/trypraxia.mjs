#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const daemonPath = join(repoRoot, "daemon", "dashboard-daemon.mjs");
const daemonEnvPath = join(homedir(), ".praxia-cloud", "dashboard.env");

const args = process.argv.slice(2);

function printHelp() {
  console.log(`Praxia CLI

Usage:
  npx --yes trypraxia daemon login --url https://app.trypraxia.com --code ABCD-EFGH-IJKL
  npx --yes trypraxia daemon start
  npx --yes trypraxia daemon backfill-sessions
  npx --yes trypraxia daemon doctor
  npx --yes trypraxia github login
  npx --yes trypraxia github status

Commands:
  daemon login    Pair this machine with a Praxia Cloud workspace.
  daemon start    Start the foreground daemon polling loop.
  daemon backfill-sessions  Upload all local Codex/Claude session history once.
  daemon doctor   Check local daemon config and installed agent CLIs.
  github login    Sign this machine into your own GitHub account.
  github status   Show the GitHub account available to local Praxia workers.

Options for daemon login:
  --url <url>          Praxia Cloud app URL.
  --code <code>        Pairing code from the hosted dashboard.
  --daemon-id <id>     Optional machine id. Defaults to this host name.
  --label <label>      Optional display label for this machine.
`);
}

function runDaemon(command, extraArgs = []) {
  const result = spawnSync(process.execPath, [daemonPath, command, ...extraArgs], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.signal) process.exit(1);
  process.exit(result.status ?? 0);
}

function readEnvMap(path) {
  const values = new Map();
  if (!existsSync(path)) return values;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    values.set(key, value);
  }
  return values;
}

function envValue(values, key, fallback = "") {
  return process.env[key] || values.get(key) || fallback;
}

function commandPath(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function githubIdentity() {
  const cliPath = commandPath("gh");
  if (!cliPath) return { cliPath: null, login: null };
  const result = spawnSync("gh", ["api", "user", "--jq", ".login"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return {
    cliPath,
    login: result.status === 0 ? result.stdout.trim() || null : null,
  };
}

function printGithubStatus({ failIfDisconnected = true } = {}) {
  const identity = githubIdentity();
  if (!identity.cliPath) {
    console.error("GitHub CLI is not installed. Install it from https://cli.github.com/ and try again.");
    if (failIfDisconnected) process.exitCode = 1;
    return null;
  }
  if (!identity.login) {
    console.error("GitHub CLI is installed, but this machine is not signed in.");
    console.error("Run `npx --yes trypraxia github login`.");
    if (failIfDisconnected) process.exitCode = 1;
    return null;
  }
  console.log(`GitHub connected: @${identity.login}`);
  console.log("Credentials remain in GitHub CLI on this machine; Praxia Cloud receives only this username and connection state.");
  return identity.login;
}

function loginGithub() {
  if (!commandPath("gh")) {
    console.error("GitHub CLI is not installed. Install it from https://cli.github.com/ and run this command again.");
    process.exit(1);
  }

  const login = spawnSync("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], {
    stdio: "inherit",
    env: process.env,
  });
  if (login.error) {
    console.error(login.error.message);
    process.exit(1);
  }
  if (login.status !== 0) process.exit(login.status ?? 1);

  const setup = spawnSync("gh", ["auth", "setup-git", "--hostname", "github.com"], {
    stdio: "inherit",
    env: process.env,
  });
  if (setup.error || setup.status !== 0) {
    console.error("GitHub sign-in succeeded, but Git credential setup did not complete.");
    process.exit(1);
  }
  printGithubStatus();
}

function printDoctor() {
  const env = readEnvMap(daemonEnvPath);
  const url = envValue(env, "DASHBOARD_URL", "not set");
  const daemonId = envValue(env, "DAEMON_ID", "not set");
  const navigatorRoot = envValue(env, "PRAXIA_NAVIGATOR_ROOT", process.cwd());
  const hasFleetToken = Boolean(envValue(env, "DASHBOARD_FLEET_TOKEN"));
  const fleetOrganizationIds = (envValue(env, "DASHBOARD_FLEET_ORG_IDS") || "").split(",").filter(Boolean);
  const hasUsableFleetConfig = hasFleetToken && fleetOrganizationIds.length > 0;
  const hasDeviceToken = Boolean(envValue(env, "DASHBOARD_DEVICE_TOKEN"));
  const hasLegacyKey = Boolean(envValue(env, "DASHBOARD_WRITE_KEY"));
  const dockerImage = envValue(env, "PRAXIA_DOCKER_IMAGE");
  const configuredBackend = envValue(env, "PRAXIA_DEFAULT_EXECUTION_BACKEND", dockerImage ? "docker" : "worktree");
  const forwardedAgentEnv = envValue(env, "PRAXIA_AGENT_ENV_ALLOWLIST");

  console.log("Praxia daemon doctor");
  console.log(`- Config file: ${existsSync(daemonEnvPath) ? daemonEnvPath : "missing"}`);
  console.log(`- Dashboard URL: ${url}`);
  console.log(`- Daemon ID: ${daemonId}`);
  console.log(`- Navigator root: ${navigatorRoot}`);
  console.log(`- Fleet token: ${hasFleetToken ? "present" : "missing"}`);
  console.log(`- Organization grants: ${fleetOrganizationIds.length ? fleetOrganizationIds.join(", ") : "none recorded"}`);
  console.log(`- Device token: ${hasDeviceToken ? "present" : "missing"}`);
  console.log(`- Legacy write key: ${hasLegacyKey ? "present" : "missing"}`);
  console.log(`- Execution backend: ${configuredBackend}`);
  console.log(`- Docker agent image: ${dockerImage || "not configured"}`);
  console.log(`- Extra agent environment: ${forwardedAgentEnv || "none"}`);

  if (hasFleetToken && fleetOrganizationIds.length === 0) {
    console.log("- CONFIG ERROR: the fleet token has no recorded organization grants; run daemon login again with an organization pairing code.");
    process.exitCode = 1;
  }
  if (url.startsWith("https://") && !hasUsableFleetConfig && !hasDeviceToken) {
    console.log("- SECURITY ERROR: Praxia Cloud requires a fleet or legacy device token; the write key is self-hosted only.");
    process.exitCode = 1;
  }
  if (configuredBackend === "local") {
    console.log("- SECURITY WARNING: local execution has no process-isolation boundary; prefer worktree or Docker.");
  }

  const agents = [
    ["Claude Code", envValue(env, "CLAUDE_BIN", "claude")],
    ["Codex", envValue(env, "CODEX_BIN", "codex")],
    ["Gemini", envValue(env, "GEMINI_BIN", "gemini")],
    ["OpenCode", envValue(env, "OPENCODE_BIN", "opencode")],
    ["Goose", envValue(env, "GOOSE_BIN", "goose")],
  ];

  console.log("- Agent CLIs:");
  for (const [label, bin] of agents) {
    const found = commandPath(bin);
    console.log(`  - ${label}: ${found ? `${bin} (${found})` : `${bin} missing from PATH`}`);
  }

  const github = githubIdentity();
  console.log("- GitHub:");
  console.log(`  - GitHub CLI: ${github.cliPath ?? "missing from PATH"}`);
  console.log(`  - Account: ${github.login ? `@${github.login}` : "not connected"}`);

  if (!hasUsableFleetConfig && !hasDeviceToken && !hasLegacyKey) {
    console.log("\nRun `npx --yes trypraxia daemon login --url <url> --code <code>` to pair this machine.");
    process.exitCode = 1;
  }
}

function main() {
  const command = args[0];
  if (!command || command === "-h" || command === "--help" || command === "help") {
    printHelp();
    return;
  }

  if (command === "github") {
    const githubCommand = args[1] || "status";
    if (githubCommand === "login" || githubCommand === "connect") {
      loginGithub();
      return;
    }
    if (githubCommand === "status") {
      printGithubStatus();
      return;
    }
    console.error(`Unknown GitHub command: ${githubCommand}`);
    printHelp();
    process.exit(1);
  }

  if (command !== "daemon") {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const daemonCommand = args[1] || "help";
  const daemonArgs = args.slice(2);
  if (daemonCommand === "help" || daemonCommand === "-h" || daemonCommand === "--help") {
    printHelp();
    return;
  }
  if (daemonCommand === "login" || daemonCommand === "pair") {
    runDaemon("pair", daemonArgs);
  }
  if (daemonCommand === "start") {
    runDaemon("start", daemonArgs);
  }
  if (daemonCommand === "backfill-sessions") {
    runDaemon("backfill-sessions", daemonArgs);
  }
  if (daemonCommand === "doctor") {
    printDoctor();
    return;
  }

  console.error(`Unknown daemon command: ${daemonCommand}`);
  printHelp();
  process.exit(1);
}

main();
