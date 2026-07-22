import { execFile as execFileCallback, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const EXECUTION_BACKENDS = ["local", "worktree", "docker"];

// Agent processes must not inherit the daemon's ambient production credentials.
// Provider credentials are intentionally absent: subscription-backed CLIs use
// their own credential stores, and API-key-backed execution must opt in by name
// through PRAXIA_AGENT_ENV_ALLOWLIST. Praxia infrastructure credentials can
// never be forwarded, even when accidentally named in that override.
const AGENT_ENV_DEFAULT_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  // A handle to the operator's already-running SSH agent, not a secret in its
  // own right. Without it `git push` over SSH cannot authenticate, which would
  // block the ship step on every host-executed command.
  "SSH_AUTH_SOCK",
]);

const AGENT_ENV_NEVER_FORWARD = /^(?:DATABASE_URL|DASHBOARD_(?:WRITE_KEY|DEVICE_TOKEN)|HOSTED_ADMIN_KEY|COMMAND_KEY|PRAXIA_COMMS_ENC_KEY|PRAXIA_MCP_ENCRYPTION_KEY|STRIPE_.+|RESEND_API_KEY|BLOB_READ_WRITE_TOKEN|VERCEL_.+|GITHUB_ACCESS_TOKEN)$/i;

export function agentProcessEnv(source = process.env) {
  const configured = String(source.PRAXIA_AGENT_ENV_ALLOWLIST || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const allowed = new Set([...AGENT_ENV_DEFAULT_ALLOWLIST, ...configured]);
  const env = {};
  for (const name of allowed) {
    if (AGENT_ENV_NEVER_FORWARD.test(name)) continue;
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  // A stable marker lets child tooling and incident receipts distinguish a
  // Praxia-contained process from an operator's interactive shell.
  env.PRAXIA_CONTAINED_EXECUTION = "1";
  return env;
}

export function normalizeExecutionBackend(value, fallback = "local") {
  return EXECUTION_BACKENDS.includes(value) ? value : fallback;
}

export async function prepareExecutionBackend({ backend, commandId, cwd, allowedPaths = [] }) {
  const selected = normalizeExecutionBackend(backend);
  if (selected !== "worktree") return { backend: selected, commandId, baseCwd: cwd, cwd, allowedPaths };

  const root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], root);
  if (status.trim()) throw new Error("worktree backend requires a clean Git working tree");
  const baseCommit = (await git(["rev-parse", "HEAD"], root)).trim();
  const configuredRoot = process.env.PRAXIA_WORKTREE_ROOT;
  const worktreeRoot = configuredRoot?.startsWith("~/")
    ? join(homedir(), configuredRoot.slice(2))
    : configuredRoot || join(homedir(), ".praxia-cloud", "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const safeId = String(commandId).replace(/[^A-Za-z0-9_-]/g, "-");
  const branch = `praxia/run-${safeId}-${Date.now()}`;
  const workspace = join(worktreeRoot, `${safeId}-${Date.now()}`);
  await git(["worktree", "add", "-b", branch, workspace, baseCommit], root);
  return { backend: selected, commandId, baseCwd: root, cwd: workspace, baseCommit, branch, workspace, allowedPaths };
}

export function wrapExecutionCommand(plan, command, options = {}) {
  if (plan.backend !== "docker") return { ...command, cwd: plan.cwd, env: agentProcessEnv() };
  const image = process.env.PRAXIA_DOCKER_IMAGE;
  if (!image) throw new Error("PRAXIA_DOCKER_IMAGE is required for the Docker execution backend");
  const args = [
    "run", "--rm", "--init", "--name", `praxia-command-${plan.commandId}`,
    "--network", options.networkAccess ? "bridge" : "none",
    "--cpus", process.env.PRAXIA_DOCKER_CPUS || "2",
    "--memory", process.env.PRAXIA_DOCKER_MEMORY || "4g",
    "--pids-limit", process.env.PRAXIA_DOCKER_PIDS || "512",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "-v", `${plan.cwd}:/workspace:rw`, "-w", "/workspace",
  ];
  if (options.outputDir) args.push("-v", `${options.outputDir}:${options.outputDir}:rw`);
  for (const mount of configuredDockerMounts()) args.push("-v", `${mount.host}:${mount.container}:${mount.mode}`);
  args.push(image, basename(command.bin), ...command.args);
  return { bin: process.env.DOCKER_BIN || "docker", args, cwd: plan.baseCwd, env: process.env };
}

export async function finalizeExecutionBackend(plan, { success }) {
  if (plan.backend !== "worktree") return { backend: plan.backend, applied: success, workspacePath: plan.cwd };
  const keepFailed = process.env.PRAXIA_KEEP_FAILED_WORKTREES === "true";
  if (!success) {
    if (keepFailed) return { backend: "worktree", applied: false, preserved: true, workspacePath: plan.workspace };
    await cleanupWorktree(plan);
    return { backend: "worktree", applied: false, preserved: false, workspacePath: null };
  }
  await git(["add", "-N", "."], plan.workspace);
  const changedFiles = (await git(["diff", "--name-only", plan.baseCommit, "--"], plan.workspace))
    .split("\n").map((item) => item.trim()).filter(Boolean);
  const unauthorized = plan.allowedPaths?.length
    ? changedFiles.filter((file) => !plan.allowedPaths.some((scope) => pathAllowed(scope, file)))
    : [];
  if (unauthorized.length) {
    throw new Error(`isolated worker changed files outside its frozen scope: ${unauthorized.join(", ")}; preserved at ${plan.workspace}`);
  }
  const patch = await gitBuffer(["diff", "--binary", plan.baseCommit, "--"], plan.workspace);
  if (patch.length) {
    const baseStatus = await git(["status", "--porcelain=v1", "--untracked-files=all"], plan.baseCwd);
    if (baseStatus.trim()) throw new Error(`base working tree changed during isolated run; preserved at ${plan.workspace}`);
    await gitWithInput(["apply", "--whitespace=nowarn", "-"], plan.baseCwd, patch);
    await git(["add", "-A"], plan.baseCwd);
    await git([
      "-c", "user.name=Praxia Operator", "-c", "user.email=operator@trypraxia.local",
      "commit", "-m", `Praxia command #${plan.commandId}`,
    ], plan.baseCwd);
  }
  await cleanupWorktree(plan);
  return { backend: "worktree", applied: true, patchBytes: patch.length, changedFiles, workspacePath: null };
}

function pathAllowed(scope, file) {
  const normalized = String(scope).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/\*\*$/, "/");
  return normalized.endsWith("/") ? file.startsWith(normalized) : file === normalized || file.startsWith(`${normalized}/`);
}

function configuredDockerMounts() {
  if (!process.env.PRAXIA_DOCKER_MOUNTS) return [];
  let parsed;
  try { parsed = JSON.parse(process.env.PRAXIA_DOCKER_MOUNTS); }
  catch { throw new Error("PRAXIA_DOCKER_MOUNTS must be valid JSON"); }
  if (!Array.isArray(parsed)) throw new Error("PRAXIA_DOCKER_MOUNTS must be a JSON array");
  return parsed.map((item) => {
    const host = typeof item?.host === "string" ? item.host : "";
    const container = typeof item?.container === "string" ? item.container : "";
    const mode = item?.mode === "rw" ? "rw" : "ro";
    if (!host.startsWith("/") || !container.startsWith("/") || !existsSync(host)) {
      throw new Error("Docker mounts require existing absolute host paths and absolute container paths");
    }
    return { host, container, mode };
  });
}

async function cleanupWorktree(plan) {
  try { await git(["worktree", "remove", "--force", plan.workspace], plan.baseCwd); }
  catch {
    rmSync(plan.workspace, { recursive: true, force: true });
    await git(["worktree", "prune"], plan.baseCwd).catch(() => {});
  }
  await git(["branch", "-D", plan.branch], plan.baseCwd).catch(() => {});
}

async function git(args, cwd) {
  const { stdout } = await execFile("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

async function gitBuffer(args, cwd) {
  const { stdout } = await execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 100 * 1024 * 1024 });
  return stdout;
}

function gitWithInput(args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `git exited ${code}`)));
    child.stdin.end(input);
  });
}
