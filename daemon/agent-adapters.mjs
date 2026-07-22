const adapters = {
  claude: {
    bin: () => process.env.CLAUDE_BIN || "claude",
    args: (body, options = {}) => [
      "-p",
      "--permission-mode",
      options.readOnly ? "plan" : options.isolated ? "bypassPermissions" : "acceptEdits",
      ...(options.readOnly ? ["--tools", "Read,Glob,Grep"] : []),
      ...((options.extraReadDirs || []).flatMap((dir) => ["--add-dir", dir])),
      // Turn/tool-grain capture at the source (docs/TRANSPARENT_RUNS.md).
      // The result event carries the final text runProcess previously read
      // from plain stdout.
      ...(options.streamJson ? ["--output-format", "stream-json", "--verbose"] : []),
      ...(options.model ? ["--model", options.model] : []),
      ...(options.effort ? ["--effort", options.effort] : []),
      body,
    ],
  },
  codex: {
    bin: () => process.env.CODEX_BIN || "codex",
    args: (body, options = {}) => [
      "exec",
      "--ephemeral",
      "--sandbox",
      options.readOnly ? "read-only" : "workspace-write",
      "-c",
      "approval_policy=\"never\"",
      ...(options.streamJson ? ["--json"] : []),
      ...(options.networkAccess ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
      ...((options.extraReadDirs || []).flatMap((dir) => ["--add-dir", dir])),
      ...(options.model ? ["--model", options.model] : []),
      ...(options.effort ? ["-c", `model_reasoning_effort=\"${options.effort}\"`] : []),
      ...(options.outputPath ? ["--output-last-message", options.outputPath] : []),
      body,
    ],
  },
  gemini: {
    bin: () => process.env.GEMINI_BIN || "gemini",
    args: (body, options = {}) => [
      "-p",
      body,
      ...(options.model ? ["--model", options.model] : []),
    ],
  },
  kimi: {
    bin: () => process.env.KIMI_BIN || "kimi",
    args: (body, options = {}) => [
      "-p",
      body,
      ...(options.model ? ["--model", options.model] : []),
      ...(options.streamJson ? ["--output-format", "stream-json"] : []),
    ],
  },
  opencode: {
    bin: () => process.env.OPENCODE_BIN || "opencode",
    args: (body) => ["run", body],
  },
  goose: {
    bin: () => process.env.GOOSE_BIN || "goose",
    args: (body) => ["run", "-t", body],
  },
};

export function commandForAgent(agent, body, options = {}) {
  const adapter = adapters[agent] ?? adapters.claude;
  return { bin: adapter.bin(), args: adapter.args(body, options) };
}

export function requireSiteLauncherCallbackReceipt(result) {
  if (result?.status !== "completed") return result;
  const text = String(result.result || "");
  if (/\b(?:HTTP(?: status)?|status|returned)\s*[:=]?\s*200\b/i.test(text)) return result;
  return {
    ...result,
    status: "failed",
    error: "SiteLauncher agent exited without an HTTP 200 callback receipt.",
  };
}
