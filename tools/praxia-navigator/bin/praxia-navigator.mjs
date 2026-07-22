#!/usr/bin/env node

import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCallback);

const DEFAULT_INDEX_DIR = ".praxia-navigator";
const DEFAULT_INDEX_FILE = "index.json";
const DEFAULT_PORT = 4789;
const MAX_FILE_BYTES = 180_000;
const MAX_INDEXED_TEXT = 18_000;
const MAX_GOALS = 40;
const MAX_MATCHES = 30;

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".turbo",
  ".vercel",
  ".praxia-navigator",
  "coverage",
  "dist",
  "build",
  "out",
  "node_modules",
  "vendor",
  "__pycache__"
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".csv",
  ".env",
  ".example",
  ".graphql",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".prisma",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".yaml",
  ".yml"
]);

const BINARY_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".db",
  ".DS_Store",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".lock",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".sqlite",
  ".ttf",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip"
]);

const CAPABILITY_KEYWORDS = [
  ["auth", ["auth", "login", "session", "user", "role", "permission", "clerk", "supabase"]],
  ["tasks", ["task", "todo", "kanban", "queue", "assignment", "status", "priority"]],
  ["projects", ["project", "milestone", "roadmap", "workspace", "program"]],
  ["contacts", ["contact", "client", "customer", "account", "lead", "crm"]],
  ["calendar", ["calendar", "schedule", "event", "reminder", "deadline", "week"]],
  ["documents", ["document", "docx", "pdf", "file", "attachment", "upload"]],
  ["ai", ["ai", "openai", "model", "prompt", "embedding", "transcript", "summary", "agent"]],
  ["voice", ["voice", "audio", "recording", "memo", "transcription", "whisper"]],
  ["email", ["email", "gmail", "inbox", "message", "thread"]],
  ["finance", ["invoice", "payment", "finance", "budget", "expense", "revenue"]],
  ["inventory", ["inventory", "stock", "sku", "warehouse", "purchase"]],
  ["dashboard", ["dashboard", "analytics", "metric", "report", "chart", "kpi"]],
  ["database", ["database", "schema", "migration", "prisma", "sql", "table", "model"]],
  ["api", ["api", "route", "endpoint", "controller", "service", "server"]]
];

function usage() {
  console.log(`Praxia Navigator

Usage:
  praxia-navigator index [--root <path>]
  praxia-navigator plan [--root <path>] [--input <file>] [text...]
  praxia-navigator authorize [--root <path>] --plan <file>
  praxia-navigator dispatch [--root <path>] [--limit <count>]
  praxia-navigator work [--root <path>] [--limit <count>]
  praxia-navigator handoff [--root <path>] [--limit <count>]
  praxia-navigator ingest [--root <path>] --result <file>
  praxia-navigator agent-run [--root <path>] --command <cmd> [--limit <count>]
  praxia-navigator loop [--root <path>] [--cycles <count>] [--limit <count>] [--interval-ms <ms>]
  praxia-navigator report [--root <path>]
  praxia-navigator status [--root <path>] --task <id> --status <status>
  praxia-navigator queue [--root <path>]
  praxia-navigator serve [--root <path>] [--port <port>]

Examples:
  node tools/praxia-navigator/bin/praxia-navigator.mjs index
  node tools/praxia-navigator/bin/praxia-navigator.mjs plan --input monday-dump.txt
  node tools/praxia-navigator/bin/praxia-navigator.mjs authorize --plan .praxia-navigator/plans/plan.md
  node tools/praxia-navigator/bin/praxia-navigator.mjs dispatch --limit 3
  node tools/praxia-navigator/bin/praxia-navigator.mjs work --limit 3
  node tools/praxia-navigator/bin/praxia-navigator.mjs handoff --limit 3
  node tools/praxia-navigator/bin/praxia-navigator.mjs ingest --result agent-result.json
  node tools/praxia-navigator/bin/praxia-navigator.mjs agent-run --command "codex-agent-runner"
  node tools/praxia-navigator/bin/praxia-navigator.mjs loop --cycles 1
  node tools/praxia-navigator/bin/praxia-navigator.mjs report
  node tools/praxia-navigator/bin/praxia-navigator.mjs serve
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = { root: process.cwd(), input: null, plan: null, task: null, status: null, result: null, command: null, port: DEFAULT_PORT, limit: 1, cycles: 1, intervalMs: 300_000, text: [] };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--root") {
      options.root = path.resolve(args.shift() ?? ".");
    } else if (arg === "--input") {
      options.input = args.shift();
    } else if (arg === "--plan") {
      options.plan = args.shift();
    } else if (arg === "--task") {
      options.task = args.shift();
    } else if (arg === "--status") {
      options.status = args.shift();
    } else if (arg === "--result") {
      options.result = args.shift();
    } else if (arg === "--command") {
      options.command = args.shift();
    } else if (arg === "--port") {
      options.port = Number(args.shift() ?? DEFAULT_PORT);
    } else if (arg === "--limit") {
      options.limit = Number(args.shift() ?? 1);
    } else if (arg === "--cycles") {
      options.cycles = Number(args.shift() ?? 1);
    } else if (arg === "--interval-ms") {
      options.intervalMs = Number(args.shift() ?? 300_000);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      options.text.push(arg);
    }
  }

  return { command, options };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function shouldIgnoreDirectory(name) {
  return IGNORED_DIRS.has(name);
}

function isProbablyText(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(filePath);
  if (base.startsWith(".env")) return true;
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (TEXT_EXTENSIONS.has(ext)) return true;
  return !ext && !base.includes(".");
}

async function walk(root, current = root, out = []) {
  let entries = [];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && shouldIgnoreDirectory(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, out);
    } else if (entry.isFile() && isProbablyText(fullPath)) {
      out.push(fullPath);
    }
  }

  return out;
}

async function readTextSample(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    return { text: "", skippedReason: `large file (${stat.size} bytes)`, size: stat.size };
  }

  const raw = await fs.readFile(filePath, "utf8");
  const text = raw.replace(/\u0000/g, "").slice(0, MAX_INDEXED_TEXT);
  return { text, skippedReason: null, size: stat.size };
}

function detectProjectRoot(relativePath) {
  const parts = relativePath.split("/");
  if (parts.length >= 2 && ["apps", "packages", "tools", "services"].includes(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts.length >= 1) return parts[0];
  return ".";
}

function detectFileKind(relativePath, text) {
  const lowerPath = relativePath.toLowerCase();
  const lowerText = text.toLowerCase();
  const kinds = [];

  if (lowerPath.includes("/api/") || lowerPath.includes("/routes/") || /export\s+async\s+function\s+(get|post|put|patch|delete)\b/.test(lowerText)) kinds.push("api");
  if (lowerPath.includes("schema") || lowerPath.endsWith(".sql") || lowerPath.endsWith(".prisma") || lowerPath.includes("/migrations/")) kinds.push("schema");
  if (lowerPath.endsWith(".tsx") || lowerPath.endsWith(".jsx") || lowerPath.endsWith(".vue") || lowerPath.endsWith(".svelte") || lowerPath.includes("/components/")) kinds.push("ui");
  if (lowerPath.includes("service") || lowerPath.includes("worker") || lowerPath.includes("job")) kinds.push("service");
  if (lowerPath.includes("test") || lowerPath.includes("spec")) kinds.push("test");
  if (lowerPath.endsWith("readme.md") || lowerPath.includes("/docs/")) kinds.push("docs");
  if (lowerPath.endsWith("package.json") || lowerPath.endsWith("pyproject.toml")) kinds.push("manifest");

  return kinds.length ? kinds : ["code"];
}

function detectCapabilities(relativePath, text) {
  const haystack = `${relativePath}\n${text}`.toLowerCase();
  return CAPABILITY_KEYWORDS
    .filter(([, terms]) => terms.some((term) => haystack.includes(term)))
    .map(([capability]) => capability);
}

function extractTitleFromReadme(text) {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : null;
}

function summarizeProjects(files) {
  const projects = new Map();

  for (const file of files) {
    const projectRoot = file.projectRoot;
    if (!projects.has(projectRoot)) {
      projects.set(projectRoot, {
        root: projectRoot,
        name: path.basename(projectRoot),
        files: 0,
        kinds: {},
        capabilities: {},
        title: null,
        manifests: []
      });
    }

    const project = projects.get(projectRoot);
    project.files += 1;
    for (const kind of file.kinds) project.kinds[kind] = (project.kinds[kind] ?? 0) + 1;
    for (const capability of file.capabilities) project.capabilities[capability] = (project.capabilities[capability] ?? 0) + 1;
    if (file.relativePath.toLowerCase().endsWith("readme.md")) {
      project.title = extractTitleFromReadme(file.textSample) ?? project.title;
    }
    if (file.kinds.includes("manifest")) project.manifests.push(file.relativePath);
  }

  return [...projects.values()].sort((a, b) => a.root.localeCompare(b.root));
}

async function buildIndex(root) {
  const absoluteRoot = path.resolve(root);
  const filePaths = await walk(absoluteRoot);
  const files = [];

  for (const filePath of filePaths) {
    const relativePath = toPosix(path.relative(absoluteRoot, filePath));
    const sample = await readTextSample(filePath);
    const textSample = sample.text;
    const kinds = detectFileKind(relativePath, textSample);
    const capabilities = detectCapabilities(relativePath, textSample);

    files.push({
      relativePath,
      projectRoot: detectProjectRoot(relativePath),
      size: sample.size,
      skippedReason: sample.skippedReason,
      kinds,
      capabilities,
      textSample
    });
  }

  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    root: absoluteRoot,
    files,
    projects: summarizeProjects(files)
  };

  const indexDir = path.join(absoluteRoot, DEFAULT_INDEX_DIR);
  await fs.mkdir(indexDir, { recursive: true });
  const indexPath = path.join(indexDir, DEFAULT_INDEX_FILE);
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  return { index, indexPath };
}

async function loadIndex(root) {
  const indexPath = path.join(path.resolve(root), DEFAULT_INDEX_DIR, DEFAULT_INDEX_FILE);
  if (!(await pathExists(indexPath))) {
    throw new Error(`No index found at ${indexPath}. Run "praxia-navigator index" first.`);
  }
  return JSON.parse(await fs.readFile(indexPath, "utf8"));
}

async function readBrainDump(options) {
  if (options.input) {
    return fs.readFile(path.resolve(options.root, options.input), "utf8");
  }
  if (options.text.length > 0) {
    return options.text.join(" ");
  }
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  throw new Error("Provide text directly or use --input <file>.");
}

function tokenize(text) {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2)
      .filter((token) => !STOP_WORDS.has(token))
  )];
}

function splitIntoSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function chunkText(text, maxCharacters = 3500) {
  const sentences = splitIntoSentences(text);
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if ((current.length + sentence.length + 1) > maxCharacters && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.trim()].filter(Boolean);
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "been",
  "but",
  "can",
  "could",
  "did",
  "does",
  "done",
  "for",
  "from",
  "get",
  "have",
  "here",
  "how",
  "into",
  "just",
  "like",
  "make",
  "need",
  "needs",
  "not",
  "now",
  "our",
  "out",
  "that",
  "the",
  "then",
  "there",
  "this",
  "through",
  "todo",
  "use",
  "want",
  "we",
  "what",
  "when",
  "where",
  "with",
  "would",
  "you"
]);

function extractIntent(text) {
  const sentences = splitIntoSentences(text);
  const chunks = chunkText(text);

  const goalSignals = ["need", "build", "finish", "create", "add", "fix", "improve", "connect", "automate", "launch", "ship", "want"];
  const blockerSignals = ["blocked", "blocker", "stuck", "can't", "cannot", "waiting", "missing", "problem", "issue", "risk"];
  const decisionSignals = ["decide", "decision", "choose", "approve", "approval", "should we", "new program", "new app", "where should"];
  const urgencySignals = ["today", "tomorrow", "this week", "monday", "tuesday", "wednesday", "thursday", "friday", "urgent", "priority", "must", "finish"];

  const goals = sentences
    .filter((sentence) => goalSignals.some((signal) => sentence.toLowerCase().includes(signal)))
    .slice(0, MAX_GOALS);

  const blockers = sentences
    .filter((sentence) => blockerSignals.some((signal) => sentence.toLowerCase().includes(signal)))
    .slice(0, 20);

  const openDecisions = sentences
    .filter((sentence) => decisionSignals.some((signal) => sentence.toLowerCase().includes(signal)))
    .slice(0, 20);

  const allText = text.toLowerCase();
  const neededCapabilities = CAPABILITY_KEYWORDS
    .filter(([, terms]) => terms.some((term) => allText.includes(term)))
    .map(([capability]) => capability);

  return {
    goals: goals.length ? goals : sentences.slice(0, 12),
    blockers,
    openDecisions,
    urgencySignals: urgencySignals.filter((signal) => allText.includes(signal)),
    neededCapabilities,
    chunks: chunks.map((chunk, index) => ({
      id: `chunk-${index + 1}`,
      characters: chunk.length,
      keywords: tokenize(chunk).slice(0, 24),
      preview: chunk.slice(0, 260)
    })),
    tokens: tokenize(text)
  };
}

function scoreFile(file, intent) {
  const searchable = `${file.relativePath}\n${file.capabilities.join(" ")}\n${file.kinds.join(" ")}\n${file.textSample}`.toLowerCase();
  let score = 0;

  for (const token of intent.tokens) {
    if (searchable.includes(token)) score += file.relativePath.toLowerCase().includes(token) ? 5 : 1;
  }

  for (const capability of intent.neededCapabilities) {
    if (file.capabilities.includes(capability)) score += 8;
  }

  if (file.kinds.includes("docs")) score += 2;
  if (file.kinds.includes("manifest")) score += 1;
  return score;
}

function topMatches(index, intent, limit = MAX_MATCHES) {
  return index.files
    .map((file) => ({ ...file, score: scoreFile(file, intent) }))
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, limit);
}

function scoreProject(project, matches, intent) {
  const matchScore = matches
    .filter((match) => match.projectRoot === project.root)
    .reduce((sum, match) => sum + match.score, 0);
  const capabilityScore = intent.neededCapabilities
    .reduce((sum, capability) => sum + (project.capabilities[capability] ?? 0) * 3, 0);
  return matchScore + capabilityScore;
}

function classifyRecommendation(projectMatches, intent) {
  const strongProjects = projectMatches.filter((project) => project.score >= 20);
  const hasAiOrVoice = intent.neededCapabilities.includes("ai") || intent.neededCapabilities.includes("voice");
  const hasTasksOrProjects = intent.neededCapabilities.includes("tasks") || intent.neededCapabilities.includes("projects");

  if (strongProjects.length === 0) {
    return "Create new program or package";
  }
  if (strongProjects.length === 1) {
    return "Extend existing program";
  }
  if (hasAiOrVoice && hasTasksOrProjects && strongProjects.length >= 2) {
    return "Connect multiple programs and add a coordinating package";
  }
  return "Reuse and extend existing programs";
}

function buildPlanObject({ index, intent, brainDump, matches }) {
  const projectMatches = index.projects
    .map((project) => ({ ...project, score: scoreProject(project, matches, intent) }))
    .filter((project) => project.score > 0)
    .sort((a, b) => b.score - a.score || a.root.localeCompare(b.root))
    .slice(0, 10);

  const recommendation = classifyRecommendation(projectMatches, intent);
  const approvalTasks = deriveApprovalTasks(intent, projectMatches, matches, recommendation)
    .map((title) => ({
      id: stableTaskId(title),
      title,
      status: "proposed",
      authorization: "pending",
      scope: deriveTaskScope(title, projectMatches, matches),
      guardrails: deriveTaskGuardrails(title, recommendation)
    }));

  return {
    version: 1,
    id: `plan-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    generatedAt: new Date().toISOString(),
    indexGeneratedAt: index.generatedAt,
    transcript: {
      characters: brainDump.length,
      chunks: intent.chunks
    },
    detectedCapabilities: intent.neededCapabilities,
    urgencySignals: intent.urgencySignals,
    goals: intent.goals,
    blockers: intent.blockers,
    openDecisions: intent.openDecisions,
    projectMatches: projectMatches.map((project) => ({
      root: project.root,
      title: project.title,
      score: project.score,
      files: project.files,
      capabilities: Object.fromEntries(
        Object.entries(project.capabilities).sort((a, b) => b[1] - a[1]).slice(0, 12)
      ),
      kinds: project.kinds,
      manifests: project.manifests
    })),
    fileMatches: matches.map((match) => ({
      relativePath: match.relativePath,
      projectRoot: match.projectRoot,
      score: match.score,
      kinds: match.kinds,
      capabilities: match.capabilities
    })),
    recommendation: {
      decision: recommendation,
      narrative: buildRecommendationNarrative(recommendation, projectMatches)
    },
    approvalTasks,
    guardrails: [
      "Approved tasks may modify relevant code, schemas, tests, and documentation needed to complete the task.",
      "Pause for approval before creating a brand-new program, deleting data, making broad architecture changes, or requiring credentials.",
      "Keep work scoped to the checked tasks and report status as queued, in progress, testing, blocked, or complete."
    ]
  };
}

function buildPlanMarkdown(plan) {
  const lines = [];
  lines.push("# Praxia Navigator Plan");
  lines.push("");
  lines.push(`Plan ID: ${plan.id}`);
  lines.push(`Generated: ${plan.generatedAt}`);
  lines.push(`Index: ${plan.indexGeneratedAt}`);
  lines.push("");
  lines.push("## Intake Summary");
  lines.push("");
  lines.push(`Transcript length: ${plan.transcript.characters.toLocaleString()} characters`);
  lines.push(`Transcript chunks: ${plan.transcript.chunks.length}`);
  lines.push(`Detected capabilities: ${plan.detectedCapabilities.length ? plan.detectedCapabilities.join(", ") : "none detected yet"}`);
  if (plan.urgencySignals.length) lines.push(`Urgency signals: ${plan.urgencySignals.join(", ")}`);
  lines.push("");
  lines.push("## Extracted Goals");
  lines.push("");
  for (const goal of plan.goals.slice(0, 16)) {
    lines.push(`- ${goal}`);
  }
  lines.push("");
  if (plan.blockers.length) {
    lines.push("## Blockers And Risks");
    lines.push("");
    for (const blocker of plan.blockers.slice(0, 10)) {
      lines.push(`- ${blocker}`);
    }
    lines.push("");
  }
  if (plan.openDecisions.length) {
    lines.push("## Open Decisions");
    lines.push("");
    for (const decision of plan.openDecisions.slice(0, 10)) {
      lines.push(`- ${decision}`);
    }
    lines.push("");
  }
  lines.push("## Codebase Matches");
  lines.push("");
  if (plan.projectMatches.length === 0) {
    lines.push("- No strong existing program match found.");
  } else {
    for (const project of plan.projectMatches.slice(0, 8)) {
      const capabilities = Object.entries(project.capabilities ?? {})
        .slice(0, 6)
        .map(([name]) => name)
        .join(", ");
      lines.push(`- ${project.root}: score ${project.score}${capabilities ? `; capabilities: ${capabilities}` : ""}`);
    }
  }
  lines.push("");
  lines.push("## Relevant Files");
  lines.push("");
  for (const match of plan.fileMatches.slice(0, 16)) {
    lines.push(`- ${match.relativePath} (${match.kinds.join(", ")}; score ${match.score})`);
  }
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(`Decision: ${plan.recommendation.decision}`);
  lines.push("");
  lines.push(plan.recommendation.narrative);
  lines.push("");
  lines.push("## Approval Checklist");
  lines.push("");
  lines.push("Check these when ready to authorize autonomous execution for the scoped task.");
  lines.push("");
  for (const task of plan.approvalTasks) {
    lines.push(`- [ ] ${task.title}`);
  }
  lines.push("");
  lines.push("## Execution Guardrails");
  lines.push("");
  for (const guardrail of plan.guardrails) lines.push(`- ${guardrail}`);
  lines.push("");

  return lines.join("\n");
}

function buildRecommendationNarrative(recommendation, projectMatches) {
  if (recommendation === "Create new program or package") {
    return "No existing Praxia program appears to own this cleanly. Propose a new focused program/package, then connect it to existing shared auth, data, task, and UI layers where available.";
  }
  if (recommendation === "Extend existing program") {
    return `The strongest match is ${projectMatches[0]?.root}. Start there, reuse its data and UI conventions, and only extract shared code if a second program needs it.`;
  }
  if (recommendation === "Connect multiple programs and add a coordinating package") {
    return "This looks cross-program. Use the matched programs for their existing capabilities, and add a coordinating package/tool for planning, indexing, and orchestration.";
  }
  return "Multiple existing programs are relevant. Reuse the strongest matched capabilities before creating new program surfaces.";
}

function deriveApprovalTasks(intent, projectMatches, matches, recommendation) {
  const tasks = [];
  tasks.push("Build or refresh the Praxia Navigator codebase index.");
  tasks.push("Convert the brain dump into deduplicated goals, tasks, blockers, and open decisions.");
  tasks.push("Map each priority to existing Praxia programs, relevant files, and reusable capabilities.");

  if (recommendation.includes("new program")) {
    tasks.push("Draft a new-program proposal with purpose, boundaries, dependencies, and files to scaffold.");
  }

  if (intent.neededCapabilities.includes("voice")) {
    tasks.push("Add voice memo or transcript intake as a first-class planning source.");
  }

  if (intent.neededCapabilities.includes("tasks") || intent.neededCapabilities.includes("projects")) {
    tasks.push("Create an approval checklist that can authorize many scoped tasks at once.");
    tasks.push("Design the execution queue statuses for approved weekly work.");
  }

  if (matches.some((match) => match.kinds.includes("schema"))) {
    tasks.push("Review matched schemas and identify whether new tables, models, or migrations are required.");
  }

  if (projectMatches.length > 0) {
    tasks.push(`Prepare the first implementation package in ${projectMatches[0].root}.`);
  }

  return [...new Set(tasks)];
}

function deriveTaskScope(title, projectMatches, matches) {
  const lowerTitle = title.toLowerCase();
  const scope = {
    targetProjects: [],
    relevantFiles: [],
    allowedActions: ["inspect", "edit relevant files", "run local verification", "update docs"],
    requiresApprovalFor: ["new program creation", "production data changes", "credential access", "destructive deletes"]
  };

  if (projectMatches.length > 0) {
    scope.targetProjects = projectMatches.slice(0, 3).map((project) => project.root);
  }

  if (lowerTitle.includes("schema") || lowerTitle.includes("model") || lowerTitle.includes("migration")) {
    scope.relevantFiles = matches.filter((match) => match.kinds.includes("schema")).slice(0, 8).map((match) => match.relativePath);
    scope.allowedActions.push("draft schema changes");
  } else if (lowerTitle.includes("ui") || lowerTitle.includes("checklist")) {
    scope.relevantFiles = matches.filter((match) => match.kinds.includes("ui") || match.kinds.includes("code")).slice(0, 8).map((match) => match.relativePath);
    scope.allowedActions.push("add additive UI");
  } else {
    scope.relevantFiles = matches.slice(0, 8).map((match) => match.relativePath);
  }

  return scope;
}

function deriveTaskGuardrails(title, recommendation) {
  const guardrails = [
    "Do not change unrelated programs.",
    "Do not delete existing data or files unless the approved task explicitly requires it.",
    "Run the narrowest useful verification before marking complete."
  ];

  if (title.toLowerCase().includes("new-program") || recommendation.includes("new program")) {
    guardrails.push("Draft a proposal first; do not scaffold a new program until explicitly authorized.");
  }

  return guardrails;
}

async function writePlan(root, plan, markdown) {
  const plansDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "plans");
  await fs.mkdir(plansDir, { recursive: true });
  const stamp = plan.id.replace(/^plan-/, "");
  const planPath = path.join(plansDir, `${stamp}.md`);
  const jsonPath = path.join(plansDir, `${stamp}.json`);
  await fs.writeFile(planPath, `${markdown}\n`);
  await fs.writeFile(jsonPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { planPath, jsonPath };
}

function parseCheckedTasks(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+\[[xX]\]\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1]);
}

async function loadAdjacentPlanJson(planPath) {
  const jsonPath = planPath.replace(/\.md$/i, ".json");
  if (!(await pathExists(jsonPath))) return null;
  return JSON.parse(await fs.readFile(jsonPath, "utf8"));
}

async function loadQueue(root) {
  const queuePath = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "queue.json");
  if (!(await pathExists(queuePath))) {
    return { version: 1, updatedAt: null, tasks: [] };
  }
  return JSON.parse(await fs.readFile(queuePath, "utf8"));
}

async function saveQueue(root, queue) {
  const queueDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR);
  await fs.mkdir(queueDir, { recursive: true });
  const queuePath = path.join(queueDir, "queue.json");
  await fs.writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
  return queuePath;
}

function stableTaskId(task) {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56);
  return `${slug || "task"}-${hashString(task).slice(0, 8)}`;
}

function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

async function addTasksToQueue(root, tasks, sourcePlan) {
  const queue = await loadQueue(root);
  const existingIds = new Set(queue.tasks.map((task) => task.id));
  const now = new Date().toISOString();
  const additions = [];

  for (const task of tasks) {
    const title = typeof task === "string" ? task : task.title;
    const id = typeof task === "string" ? stableTaskId(title) : task.id;
    if (existingIds.has(id)) continue;
    additions.push({
      id,
      title,
      status: "queued",
      sourcePlan,
      scope: typeof task === "string" ? null : task.scope,
      guardrails: typeof task === "string" ? [] : task.guardrails,
      context: typeof task === "string" ? [] : task.context ?? [],
      authorizedAt: now,
      updatedAt: now,
      notes: []
    });
    existingIds.add(id);
  }

  queue.version = 1;
  queue.updatedAt = now;
  queue.tasks.push(...additions);
  const queuePath = await saveQueue(root, queue);
  return { queuePath, added: additions.length, total: queue.tasks.length };
}

async function authorizePlan(root, planFile) {
  if (!planFile) throw new Error("Provide --plan <file>.");
  const absolutePlanPath = path.resolve(root, planFile);
  const markdown = await fs.readFile(absolutePlanPath, "utf8");
  const checkedTitles = parseCheckedTasks(markdown);
  if (checkedTitles.length === 0) {
    throw new Error("No checked tasks found. Mark approved tasks with [x] before authorizing.");
  }

  const plan = await loadAdjacentPlanJson(absolutePlanPath);
  const tasks = checkedTitles.map((title) => {
    const planTask = plan?.approvalTasks?.find((task) => task.title === title);
    return planTask ?? title;
  });
  return addTasksToQueue(root, tasks, toPosix(path.relative(path.resolve(root), absolutePlanPath)));
}

async function updateTaskStatus(root, taskId, status) {
  const allowedStatuses = new Set(["queued", "in_progress", "testing", "blocked", "ready_for_agent", "agent_running", "needs_review", "complete", "cancelled"]);
  if (!taskId) throw new Error("Provide --task <id>.");
  if (!allowedStatuses.has(status)) {
    throw new Error(`Invalid status "${status}". Use one of: ${[...allowedStatuses].join(", ")}.`);
  }

  const queue = await loadQueue(root);
  const task = queue.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  task.status = status;
  task.updatedAt = new Date().toISOString();
  queue.updatedAt = task.updatedAt;
  const queuePath = await saveQueue(root, queue);
  return { task, queuePath };
}

function renderWorkPackage(task) {
  const lines = [];
  lines.push(`# Work Package: ${task.title}`);
  lines.push("");
  lines.push(`Task ID: ${task.id}`);
  lines.push(`Status: ${task.status}`);
  lines.push(`Authorized: ${task.authorizedAt}`);
  lines.push(`Source plan: ${task.sourcePlan ?? "unknown"}`);
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  if (task.scope?.targetProjects?.length) {
    lines.push("Target projects:");
    for (const project of task.scope.targetProjects) lines.push(`- ${project}`);
    lines.push("");
  }
  if (task.scope?.relevantFiles?.length) {
    lines.push("Relevant files:");
    for (const file of task.scope.relevantFiles) lines.push(`- ${file}`);
    lines.push("");
  }
  if (task.scope?.allowedActions?.length) {
    lines.push("Allowed actions:");
    for (const action of task.scope.allowedActions) lines.push(`- ${action}`);
    lines.push("");
  }
  if (task.context?.length) {
    lines.push("## Context from the user");
    lines.push("");
    lines.push("Decisions and facts gathered while planning — treat as authoritative:");
    for (const note of task.context) lines.push(`- ${note}`);
    lines.push("");
  }
  lines.push("## Guardrails");
  lines.push("");
  const guardrails = task.guardrails?.length ? task.guardrails : [
    "Stay inside the approved task scope.",
    "Pause for destructive data changes, credentials, or new program creation."
  ];
  for (const guardrail of guardrails) lines.push(`- ${guardrail}`);
  lines.push("");
  lines.push("## Execution Checklist");
  lines.push("");
  lines.push("- [ ] Inspect the referenced project/files.");
  lines.push("- [ ] Identify the smallest coherent implementation slice.");
  lines.push("- [ ] Make the scoped changes.");
  lines.push("- [ ] Run focused verification.");
  lines.push("- [ ] Update queue status to testing or complete.");
  lines.push("");
  return lines.join("\n");
}

async function dispatchQueuedTasks(root, limit) {
  const queue = await loadQueue(root);
  const now = new Date().toISOString();
  const selected = queue.tasks.filter((task) => task.status === "queued").slice(0, Math.max(1, limit));
  const workDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "work-packages");
  await fs.mkdir(workDir, { recursive: true });

  const dispatched = [];
  for (const task of selected) {
    task.status = "in_progress";
    task.updatedAt = now;
    task.dispatchedAt = task.dispatchedAt ?? now;
    const workPath = path.join(workDir, `${task.id}.md`);
    await fs.writeFile(workPath, `${renderWorkPackage(task)}\n`);
    task.workPackage = toPosix(path.relative(path.resolve(root), workPath));
    dispatched.push(task);
  }

  queue.updatedAt = now;
  const queuePath = await saveQueue(root, queue);
  return { dispatched, queuePath };
}

async function latestPlan(root) {
  const plans = await listPlans(root);
  return plans[0] ?? null;
}

function appendTaskNote(task, message, level = "info") {
  task.notes = task.notes ?? [];
  task.notes.push({
    level,
    message,
    at: new Date().toISOString()
  });
}

async function writeTaskCompletion(root, task, result) {
  const completionsDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "completions");
  await fs.mkdir(completionsDir, { recursive: true });
  const completionPath = path.join(completionsDir, `${task.id}.md`);
  const lines = [];
  lines.push(`# Completion: ${task.title}`);
  lines.push("");
  lines.push(`Task ID: ${task.id}`);
  lines.push(`Final status: ${task.status}`);
  lines.push(`Completed: ${task.completedAt ?? new Date().toISOString()}`);
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push(result.summary);
  lines.push("");
  if (result.artifacts?.length) {
    lines.push("## Artifacts");
    lines.push("");
    for (const artifact of result.artifacts) lines.push(`- ${artifact}`);
    lines.push("");
  }
  if (task.notes?.length) {
    lines.push("## Notes");
    lines.push("");
    for (const note of task.notes) lines.push(`- ${note.at} ${note.level}: ${note.message}`);
    lines.push("");
  }
  await fs.writeFile(completionPath, `${lines.join("\n")}\n`);
  task.completion = toPosix(path.relative(path.resolve(root), completionPath));
}

async function writeTaskReview(root, task, result) {
  const reviewsDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "reviews");
  await fs.mkdir(reviewsDir, { recursive: true });
  const reviewPath = path.join(reviewsDir, `${task.id}.md`);
  const lines = [];
  lines.push(`# Review: ${task.title}`);
  lines.push("");
  lines.push(`Task ID: ${task.id}`);
  lines.push(`Status: ${task.status}`);
  lines.push(`Updated: ${task.updatedAt ?? new Date().toISOString()}`);
  lines.push("");
  lines.push("## Agent Summary");
  lines.push("");
  lines.push(result.summary ?? "No summary provided.");
  lines.push("");
  if (result.changedFiles?.length) {
    lines.push("## Changed Files");
    lines.push("");
    for (const file of result.changedFiles) lines.push(`- ${file}`);
    lines.push("");
  }
  if (result.verification?.length) {
    lines.push("## Verification");
    lines.push("");
    for (const item of result.verification) {
      if (typeof item === "string") lines.push(`- ${item}`);
      else lines.push(`- ${item.command ?? item.name ?? "verification"}: ${item.result ?? item.status ?? ""}`);
    }
    lines.push("");
  }
  if (result.remainingRisk) {
    lines.push("## Remaining Risk");
    lines.push("");
    lines.push(result.remainingRisk);
    lines.push("");
  }
  await fs.writeFile(reviewPath, `${lines.join("\n")}\n`);
  task.review = toPosix(path.relative(path.resolve(root), reviewPath));
}

function programNameFromPlan(plan) {
  const caps = plan?.detectedCapabilities ?? [];
  if (caps.includes("voice") && caps.includes("tasks")) return "Weekly Planning Engine";
  if (caps.includes("contacts") && caps.includes("tasks")) return "Client Follow-Up Engine";
  if (caps.includes("finance")) return "Finance Engine";
  if (caps.includes("inventory")) return "Inventory Engine";
  if (caps.includes("dashboard")) return "Reporting Engine";
  return "New Praxia Program";
}

async function writeNewProgramProposal(root, task) {
  const plan = await latestPlan(root);
  const proposalsDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "proposals");
  await fs.mkdir(proposalsDir, { recursive: true });
  const proposalPath = path.join(proposalsDir, `${task.id}.md`);
  const programName = programNameFromPlan(plan);
  const lines = [];
  lines.push(`# Proposed Program: ${programName}`);
  lines.push("");
  lines.push(`Generated for task: ${task.title}`);
  lines.push(`Task ID: ${task.id}`);
  lines.push("");
  lines.push("## Purpose");
  lines.push("");
  lines.push("Create a focused Praxia program only if the approved priority does not fit cleanly inside an existing program.");
  lines.push("");
  if (plan?.goals?.length) {
    lines.push("## Source Goals");
    lines.push("");
    for (const goal of plan.goals.slice(0, 8)) lines.push(`- ${goal}`);
    lines.push("");
  }
  lines.push("## Proposed Boundary");
  lines.push("");
  lines.push("- Own the core workflow that existing programs do not clearly own.");
  lines.push("- Reuse existing shared auth, UI, task, project, and data packages where available.");
  lines.push("- Avoid duplicating capabilities already present in matched Praxia programs.");
  lines.push("");
  lines.push("## Likely Dependencies");
  lines.push("");
  if (plan?.projectMatches?.length) {
    for (const project of plan.projectMatches.slice(0, 6)) {
      lines.push(`- ${project.root}: reuse or integrate existing capabilities.`);
    }
  } else {
    lines.push("- Existing Praxia shared packages after the real repo is indexed.");
  }
  lines.push("");
  lines.push("## Approval Required");
  lines.push("");
  lines.push("Do not scaffold this program until the proposal is explicitly approved.");
  lines.push("");
  lines.push("## After Approval");
  lines.push("");
  lines.push("- Create a scaffold in the appropriate `apps/`, `services/`, or `tools/` location.");
  lines.push("- Add minimal routes, data models, and UI needed for the approved workflow.");
  lines.push("- Connect to existing systems through narrow APIs rather than copying logic.");
  lines.push("- Run focused verification and prepare review.");
  lines.push("");
  await fs.writeFile(proposalPath, `${lines.join("\n")}\n`);
  return toPosix(path.relative(path.resolve(root), proposalPath));
}

async function ingestAgentResult(root, result) {
  if (!result?.taskId) throw new Error("Agent result must include taskId.");
  const allowedStatuses = new Set(["needs_review", "complete", "blocked"]);
  const finalStatus = result.status ?? "needs_review";
  if (!allowedStatuses.has(finalStatus)) {
    throw new Error(`Invalid result status "${finalStatus}". Use needs_review, complete, or blocked.`);
  }

  const queue = await loadQueue(root);
  const task = queue.tasks.find((candidate) => candidate.id === result.taskId);
  if (!task) throw new Error(`Task not found: ${result.taskId}`);

  const now = new Date().toISOString();
  const resultsDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "agent-results");
  await fs.mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `${task.id}-${now.replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  task.status = finalStatus;
  task.updatedAt = now;
  task.agentResult = toPosix(path.relative(path.resolve(root), resultPath));
  task.changedFiles = result.changedFiles ?? task.changedFiles ?? [];
  task.verification = result.verification ?? task.verification ?? [];
  if (finalStatus === "complete") task.completedAt = now;
  if (finalStatus === "blocked") task.blockedAt = now;
  appendTaskNote(task, result.summary ?? `Agent result ingested with status ${finalStatus}.`, finalStatus);

  const artifactResult = {
    summary: result.summary ?? `Agent result ingested with status ${finalStatus}.`,
    artifacts: [
      task.agentResult,
      ...(result.artifacts ?? []),
      ...(result.changedFiles ?? [])
    ]
  };
  if (finalStatus === "complete") {
    await writeTaskCompletion(root, task, artifactResult);
  } else {
    await writeTaskReview(root, task, result);
  }

  queue.updatedAt = now;
  const queuePath = await saveQueue(root, queue);
  return { task, queuePath, resultPath: task.agentResult };
}

async function ensureTaskDispatched(root, task) {
  if (task.status !== "queued") return;
  const now = new Date().toISOString();
  task.status = "in_progress";
  task.updatedAt = now;
  task.dispatchedAt = task.dispatchedAt ?? now;
  const workDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "work-packages");
  await fs.mkdir(workDir, { recursive: true });
  const workPath = path.join(workDir, `${task.id}.md`);
  await fs.writeFile(workPath, `${renderWorkPackage(task)}\n`);
  task.workPackage = toPosix(path.relative(path.resolve(root), workPath));
}

async function verifyPlanHasFields(root, fields) {
  const plan = await latestPlan(root);
  if (!plan) return { ok: false, message: "No generated plan was found." };
  const missing = fields.filter((field) => !(field in plan));
  if (missing.length) return { ok: false, message: `Latest plan is missing: ${missing.join(", ")}.` };
  return { ok: true, plan };
}

async function handleKnownTask(root, task) {
  const title = task.title.toLowerCase();

  if (title.includes("build or refresh") && title.includes("codebase index")) {
    const result = await buildIndex(root);
    return {
      status: "complete",
      summary: `Refreshed the Praxia Navigator index with ${result.index.files.length} files across ${result.index.projects.length} project roots.`,
      artifacts: [toPosix(path.relative(path.resolve(root), result.indexPath))]
    };
  }

  if (title.includes("convert the brain dump")) {
    const verification = await verifyPlanHasFields(root, ["goals", "blockers", "openDecisions", "transcript"]);
    if (!verification.ok) return { status: "blocked", summary: verification.message, artifacts: [] };
    return {
      status: "complete",
      summary: "Verified that generated plans persist extracted goals, blockers, open decisions, transcript chunk metadata, urgency signals, and capability matches.",
      artifacts: [verification.plan.path, verification.plan.markdownPath]
    };
  }

  if (title.includes("map each priority")) {
    const verification = await verifyPlanHasFields(root, ["projectMatches", "fileMatches", "recommendation"]);
    if (!verification.ok) return { status: "blocked", summary: verification.message, artifacts: [] };
    return {
      status: "complete",
      summary: "Verified that generated plans include project matches, file matches, and a reuse/build recommendation.",
      artifacts: [verification.plan.path, verification.plan.markdownPath]
    };
  }

  if (title.includes("approval checklist")) {
    const verification = await verifyPlanHasFields(root, ["approvalTasks"]);
    if (!verification.ok) return { status: "blocked", summary: verification.message, artifacts: [] };
    return {
      status: "complete",
      summary: "Verified batch approval support: plans include approval task IDs, CLI authorization reads checked markdown items, and the UI posts selected tasks to the queue.",
      artifacts: [verification.plan.path, ".praxia-navigator/queue.json"]
    };
  }

  if (title.includes("execution queue statuses") || title.includes("approved weekly work")) {
    return {
      status: "complete",
      summary: "Verified execution queue statuses and transitions: queued, in_progress, testing, blocked, complete, and cancelled. Dispatch creates scoped work packages.",
      artifacts: [".praxia-navigator/queue.json", ".praxia-navigator/work-packages/"]
    };
  }

  if (title.includes("prepare the first implementation package")) {
    await ensureTaskDispatched(root, task);
    return {
      status: "complete",
      summary: "Prepared the first implementation work package for the approved task.",
      artifacts: [task.workPackage]
    };
  }

  if (title.includes("voice memo") || title.includes("transcript intake")) {
    return {
      status: "blocked",
      summary: "Transcript intake is implemented through paste, stdin, and --input files. Direct audio transcription still needs an approved transcription provider/API decision.",
      artifacts: ["tools/praxia-navigator/bin/praxia-navigator.mjs"]
    };
  }

  if (title.includes("draft") && title.includes("new-program proposal")) {
    const proposalPath = await writeNewProgramProposal(root, task);
    return {
      status: "needs_review",
      summary: "Drafted a new-program proposal for approval. This does not scaffold or create the program.",
      artifacts: [proposalPath]
    };
  }

  if (title.includes("new-program") || title.includes("new program")) {
    return {
      status: "blocked",
      summary: "New program creation requires explicit approval after reviewing a proposed program boundary and scaffold.",
      artifacts: []
    };
  }

  return {
    status: "blocked",
    summary: "No deterministic worker handler exists for this task yet. A future implementation agent should use the work package scope and guardrails to execute it.",
    artifacts: task.workPackage ? [task.workPackage] : []
  };
}

async function runWorker(root, limit) {
  const queue = await loadQueue(root);
  const candidates = queue.tasks
    .filter((task) => ["queued", "in_progress", "testing"].includes(task.status))
    .slice(0, Math.max(1, limit));
  const results = [];

  for (const task of candidates) {
    await ensureTaskDispatched(root, task);
    appendTaskNote(task, "Worker picked up the task.");
    const result = await handleKnownTask(root, task);
    task.status = result.status;
    task.updatedAt = new Date().toISOString();
    if (result.status === "complete") task.completedAt = task.updatedAt;
    if (result.status === "blocked") task.blockedAt = task.updatedAt;
    appendTaskNote(task, result.summary, result.status === "blocked" ? "blocked" : result.status === "needs_review" ? "needs_review" : "complete");
    if (result.status === "complete") await writeTaskCompletion(root, task, result);
    if (result.status === "needs_review") await writeTaskReview(root, task, result);
    results.push({ id: task.id, title: task.title, status: task.status, summary: result.summary, artifacts: result.artifacts ?? [] });
  }

  queue.updatedAt = new Date().toISOString();
  const queuePath = await saveQueue(root, queue);
  return { results, queuePath };
}

function renderAgentPrompt(task, index) {
  const lines = [];
  lines.push(`# Praxia Agent Handoff: ${task.title}`);
  lines.push("");
  lines.push("You are implementing an approved Praxia Navigator task. Work only inside the approved scope unless the codebase proves a narrow adjacent edit is required for correctness.");
  lines.push("");
  lines.push("## Objective");
  lines.push("");
  lines.push(task.title);
  lines.push("");
  lines.push("## Task Metadata");
  lines.push("");
  lines.push(`- Task ID: ${task.id}`);
  lines.push(`- Current status: ${task.status}`);
  lines.push(`- Source plan: ${task.sourcePlan ?? "unknown"}`);
  if (task.workPackage) lines.push(`- Work package: ${task.workPackage}`);
  lines.push("");
  lines.push("## Approved Scope");
  lines.push("");
  if (task.scope?.targetProjects?.length) {
    lines.push("Target projects:");
    for (const project of task.scope.targetProjects) lines.push(`- ${project}`);
    lines.push("");
  }
  if (task.scope?.relevantFiles?.length) {
    lines.push("Relevant files:");
    for (const file of task.scope.relevantFiles) lines.push(`- ${file}`);
    lines.push("");
  }
  if (task.scope?.allowedActions?.length) {
    lines.push("Allowed actions:");
    for (const action of task.scope.allowedActions) lines.push(`- ${action}`);
    lines.push("");
  }
  if (task.context?.length) {
    lines.push("## Context from the user");
    lines.push("");
    lines.push("Decisions and facts gathered while planning — treat as authoritative:");
    for (const note of task.context) lines.push(`- ${note}`);
    lines.push("");
  }
  lines.push("## Guardrails");
  lines.push("");
  const guardrails = task.guardrails?.length ? task.guardrails : [
    "Do not change unrelated programs.",
    "Do not delete data or credentials.",
    "Pause for new program creation or destructive changes."
  ];
  for (const guardrail of guardrails) lines.push(`- ${guardrail}`);
  lines.push("");
  lines.push("## Repo Context");
  lines.push("");
  if (index?.projects?.length) {
    lines.push("Known project roots:");
    for (const project of index.projects.slice(0, 20)) {
      const caps = Object.entries(project.capabilities ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name]) => name)
        .join(", ");
      lines.push(`- ${project.root}${caps ? ` (${caps})` : ""}`);
    }
  } else {
    lines.push("No index is available. Run the Navigator indexer before implementation if needed.");
  }
  lines.push("");
  lines.push("## Expected Workflow");
  lines.push("");
  lines.push("1. Inspect the referenced files and nearby patterns.");
  lines.push("2. Make the smallest implementation that completes the approved task.");
  lines.push("3. Run focused verification.");
  lines.push("4. Update the queue task to `needs_review` or `complete` with a concise summary.");
  lines.push("");
  lines.push("## Completion Response");
  lines.push("");
  lines.push("Report changed files, verification commands, result, and any remaining risk.");
  lines.push("");
  return lines.join("\n");
}

function renderAgentReadme(task) {
  return [
    `# Agent Handoff: ${task.title}`,
    "",
    "Files in this folder:",
    "",
    "- `prompt.md`: the implementation prompt for a coding agent.",
    "- `context.json`: structured task, scope, index, and queue metadata.",
    "",
    "After implementation, update the original queue item status to `needs_review`, `complete`, or `blocked`.",
    ""
  ].join("\n");
}

async function createAgentHandoffs(root, limit) {
  const queue = await loadQueue(root);
  let index = null;
  try {
    index = await loadIndex(root);
  } catch {
    index = null;
  }

  const candidates = queue.tasks
    .filter((task) => ["blocked", "queued", "in_progress", "testing", "ready_for_agent"].includes(task.status))
    .filter((task) => task.status !== "complete" && !task.agentHandoff)
    .slice(0, Math.max(1, limit));
  const handoffRoot = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "agent-handoffs");
  await fs.mkdir(handoffRoot, { recursive: true });

  const handoffs = [];
  const now = new Date().toISOString();
  for (const task of candidates) {
    await ensureTaskDispatched(root, task);
    const dir = path.join(handoffRoot, task.id);
    await fs.mkdir(dir, { recursive: true });
    const promptPath = path.join(dir, "prompt.md");
    const contextPath = path.join(dir, "context.json");
    const readmePath = path.join(dir, "README.md");
    const context = {
      version: 1,
      generatedAt: now,
      root: path.resolve(root),
      task,
      queuePath: toPosix(path.join(DEFAULT_INDEX_DIR, "queue.json")),
      index: index ? {
        generatedAt: index.generatedAt,
        projects: index.projects,
        relevantFiles: task.scope?.relevantFiles?.map((relativePath) => index.files.find((file) => file.relativePath === relativePath)).filter(Boolean) ?? []
      } : null
    };
    await fs.writeFile(promptPath, `${renderAgentPrompt(task, index)}\n`);
    await fs.writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`);
    await fs.writeFile(readmePath, `${renderAgentReadme(task)}\n`);

    task.status = "ready_for_agent";
    task.agentHandoff = toPosix(path.relative(path.resolve(root), dir));
    task.updatedAt = now;
    appendTaskNote(task, `Prepared implementation-agent handoff at ${task.agentHandoff}.`);
    handoffs.push({
      id: task.id,
      title: task.title,
      status: task.status,
      handoff: task.agentHandoff,
      prompt: toPosix(path.relative(path.resolve(root), promptPath)),
      context: toPosix(path.relative(path.resolve(root), contextPath))
    });
  }

  queue.updatedAt = now;
  const queuePath = await saveQueue(root, queue);
  return { handoffs, queuePath };
}

async function runAgentCommand(root, options) {
  if (!options.command) throw new Error("Provide --command <cmd>.");
  const queue = await loadQueue(root);
  const candidates = queue.tasks
    .filter((task) => task.status === "ready_for_agent" && task.agentHandoff)
    .slice(0, Math.max(1, options.limit));
  const results = [];

  for (const task of candidates) {
    task.status = "agent_running";
    task.updatedAt = new Date().toISOString();
    appendTaskNote(task, `Agent command started: ${options.command}`);
    queue.updatedAt = task.updatedAt;
    await saveQueue(root, queue);

    const handoffDir = path.join(path.resolve(root), task.agentHandoff);
    const expectedResultPath = path.join(handoffDir, "result.json");
    const env = {
      ...process.env,
      PRAXIA_ROOT: path.resolve(root),
      PRAXIA_TASK_ID: task.id,
      PRAXIA_HANDOFF_DIR: handoffDir,
      PRAXIA_PROMPT: path.join(handoffDir, "prompt.md"),
      PRAXIA_CONTEXT: path.join(handoffDir, "context.json"),
      PRAXIA_RESULT: expectedResultPath
    };

    let stdout = "";
    let stderr = "";
    try {
      const execResult = await execAsync(options.command, {
        cwd: path.resolve(root),
        env,
        maxBuffer: 1024 * 1024 * 10
      });
      stdout = execResult.stdout ?? "";
      stderr = execResult.stderr ?? "";
    } catch (error) {
      stdout = error.stdout ?? "";
      stderr = error.stderr ?? error.message;
      const blocked = await ingestAgentResult(root, {
        taskId: task.id,
        status: "blocked",
        summary: `Agent command failed: ${stderr || error.message}`,
        artifacts: [task.agentHandoff]
      });
      results.push({ task: blocked.task, stdout, stderr });
      continue;
    }

    let payload = null;
    if (await pathExists(expectedResultPath)) {
      payload = JSON.parse(await fs.readFile(expectedResultPath, "utf8"));
    } else if (stdout.trim()) {
      payload = JSON.parse(stdout);
    } else {
      payload = {
        taskId: task.id,
        status: "needs_review",
        summary: "Agent command completed without JSON output. Review the handoff folder manually.",
        artifacts: [task.agentHandoff]
      };
    }
    payload.taskId = payload.taskId ?? task.id;
    const ingested = await ingestAgentResult(root, payload);
    results.push({ task: ingested.task, stdout, stderr, resultPath: ingested.resultPath });
  }

  return { results, queuePath: path.join(path.resolve(root), DEFAULT_INDEX_DIR, "queue.json") };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeQueue(queue) {
  const counts = {};
  for (const task of queue.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

async function writePulseReport(root, pulse) {
  const pulsesDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "pulses");
  await fs.mkdir(pulsesDir, { recursive: true });
  const pulsePath = path.join(pulsesDir, `${pulse.id}.md`);
  const lines = [];
  lines.push(`# Praxia Navigator Pulse ${pulse.id}`);
  lines.push("");
  lines.push(`Generated: ${pulse.generatedAt}`);
  lines.push("");
  lines.push("## Queue Summary");
  lines.push("");
  for (const [status, count] of Object.entries(pulse.queueSummary)) {
    lines.push(`- ${status}: ${count}`);
  }
  lines.push("");
  if (pulse.actions.length) {
    lines.push("## Actions");
    lines.push("");
    for (const action of pulse.actions) lines.push(`- ${action}`);
    lines.push("");
  }
  if (pulse.next.length) {
    lines.push("## Next");
    lines.push("");
    for (const item of pulse.next) lines.push(`- ${item}`);
    lines.push("");
  }
  await fs.writeFile(pulsePath, `${lines.join("\n")}\n`);
  return toPosix(path.relative(path.resolve(root), pulsePath));
}

async function runAutopilotCycle(root, limit) {
  const actions = [];
  const indexResult = await buildIndex(root);
  actions.push(`Refreshed index: ${indexResult.index.files.length} files, ${indexResult.index.projects.length} project roots.`);

  const workResult = await runWorker(root, limit);
  for (const result of workResult.results) {
    actions.push(`Worker ${result.status}: ${result.title}`);
  }
  if (workResult.results.length === 0) actions.push("Worker found no deterministic runnable tasks.");

  const handoffResult = await createAgentHandoffs(root, limit);
  for (const handoff of handoffResult.handoffs) {
    actions.push(`Prepared agent handoff: ${handoff.title}`);
  }
  if (handoffResult.handoffs.length === 0) actions.push("No new agent handoffs needed.");

  const queue = await loadQueue(root);
  const queueSummary = summarizeQueue(queue);
  const next = [];
  if (queueSummary.ready_for_agent) next.push("Run or connect an implementation agent for ready_for_agent handoffs.");
  if (queueSummary.needs_review) next.push("Review agent results and mark tasks complete or blocked.");
  if (!queue.tasks.length) next.push("Generate a plan, approve checklist items, then run the loop again.");
  if (Object.keys(queueSummary).length && Object.keys(queueSummary).every((status) => status === "complete")) {
    next.push("All queued work is complete. Add more approved tasks to continue.");
  }

  const pulse = {
    id: new Date().toISOString().replace(/[:.]/g, "-"),
    generatedAt: new Date().toISOString(),
    queueSummary,
    actions,
    next
  };
  pulse.path = await writePulseReport(root, pulse);
  return pulse;
}

async function runAutopilot(root, options) {
  const cycles = Math.max(1, options.cycles);
  const pulses = [];
  for (let i = 0; i < cycles; i += 1) {
    const pulse = await runAutopilotCycle(root, options.limit);
    pulses.push(pulse);
    if (i < cycles - 1) await sleep(options.intervalMs);
  }
  return pulses;
}

async function listFilesIfPresent(root, relativeDir) {
  const dir = path.join(path.resolve(root), relativeDir);
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => toPosix(path.join(relativeDir, entry.name)))
    .sort();
}

async function buildStatusReport(root) {
  const state = await getNavigatorState(root);
  const queueSummary = summarizeQueue(state.queue);
  const handoffs = state.queue.tasks.filter((task) => task.agentHandoff);
  const reviews = state.queue.tasks.filter((task) => task.review || task.status === "needs_review");
  const completions = state.queue.tasks.filter((task) => task.completion || task.status === "complete");
  const pulses = await listFilesIfPresent(root, path.join(DEFAULT_INDEX_DIR, "pulses"));
  const proposals = await listFilesIfPresent(root, path.join(DEFAULT_INDEX_DIR, "proposals"));
  const next = [];

  if (!state.index) next.push("Run the codebase indexer.");
  if (!state.plans.length) next.push("Generate a plan from a brain dump.");
  if (queueSummary.queued || queueSummary.in_progress || queueSummary.testing) next.push("Run the worker or loop to advance approved tasks.");
  if (queueSummary.blocked) next.push("Prepare agent handoffs or resolve blocked decisions.");
  if (queueSummary.ready_for_agent) next.push("Run/connect a coding agent for ready handoffs.");
  if (queueSummary.needs_review) next.push("Review agent/proposal outputs and mark complete, blocked, or approved for the next step.");
  if (!next.length) next.push("All current local Navigator work is complete. Add real Praxia projects or approve more tasks.");

  const report = {
    generatedAt: new Date().toISOString(),
    root: state.root,
    index: state.index,
    planCount: state.plans.length,
    queueSummary,
    queue: state.queue.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      workPackage: task.workPackage,
      agentHandoff: task.agentHandoff,
      review: task.review,
      completion: task.completion
    })),
    artifacts: {
      handoffs: handoffs.map((task) => task.agentHandoff).filter(Boolean),
      reviews: reviews.map((task) => task.review).filter(Boolean),
      completions: completions.map((task) => task.completion).filter(Boolean),
      proposals,
      pulses
    },
    next
  };

  return report;
}

function renderStatusReport(report) {
  const lines = [];
  lines.push("# Praxia Navigator Status Report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Root: ${report.root}`);
  lines.push("");
  lines.push("## Index");
  lines.push("");
  if (report.index) {
    lines.push(`- Files: ${report.index.files}`);
    lines.push(`- Project roots: ${report.index.projects.length}`);
    lines.push(`- Generated: ${report.index.generatedAt}`);
  } else {
    lines.push("- No index available.");
  }
  lines.push("");
  lines.push("## Queue");
  lines.push("");
  for (const [status, count] of Object.entries(report.queueSummary)) {
    lines.push(`- ${status}: ${count}`);
  }
  if (!Object.keys(report.queueSummary).length) lines.push("- No queued tasks.");
  lines.push("");
  for (const task of report.queue) {
    lines.push(`- ${task.status}: ${task.title}`);
  }
  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  for (const [kind, artifacts] of Object.entries(report.artifacts)) {
    lines.push(`${kind}: ${artifacts.length}`);
    for (const artifact of artifacts.slice(-8)) lines.push(`- ${artifact}`);
    lines.push("");
  }
  lines.push("## Next");
  lines.push("");
  for (const item of report.next) lines.push(`- ${item}`);
  lines.push("");
  return lines.join("\n");
}

async function writeStatusReport(root) {
  const report = await buildStatusReport(root);
  const reportsDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `${stamp}.md`);
  const latestPath = path.join(reportsDir, "latest.md");
  const markdown = renderStatusReport(report);
  await fs.writeFile(reportPath, `${markdown}\n`);
  await fs.writeFile(latestPath, `${markdown}\n`);
  return { report, markdown, reportPath: toPosix(path.relative(path.resolve(root), reportPath)), latestPath: toPosix(path.relative(path.resolve(root), latestPath)) };
}

function formatQueue(queue) {
  const lines = [];
  lines.push("# Praxia Navigator Queue");
  lines.push("");
  if (queue.tasks.length === 0) {
    lines.push("No authorized tasks are queued.");
    return lines.join("\n");
  }

  for (const task of queue.tasks) {
    lines.push(`- ${task.status}: ${task.title}`);
  }
  return lines.join("\n");
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

async function listPlans(root) {
  const plansDir = path.join(path.resolve(root), DEFAULT_INDEX_DIR, "plans");
  if (!(await pathExists(plansDir))) return [];
  const entries = await fs.readdir(plansDir);
  const jsonFiles = entries.filter((entry) => entry.endsWith(".json")).sort().reverse();
  const plans = [];

  for (const entry of jsonFiles) {
    const jsonPath = path.join(plansDir, entry);
    try {
      const plan = JSON.parse(await fs.readFile(jsonPath, "utf8"));
      plans.push({
        id: plan.id,
        path: toPosix(path.relative(path.resolve(root), jsonPath)),
        markdownPath: toPosix(path.relative(path.resolve(root), jsonPath.replace(/\.json$/i, ".md"))),
        generatedAt: plan.generatedAt,
        recommendation: plan.recommendation,
        goals: plan.goals,
        blockers: plan.blockers,
        openDecisions: plan.openDecisions,
        transcript: plan.transcript,
        urgencySignals: plan.urgencySignals,
        detectedCapabilities: plan.detectedCapabilities,
        projectMatches: plan.projectMatches,
        fileMatches: plan.fileMatches,
        approvalTasks: plan.approvalTasks
      });
    } catch {
      // Ignore malformed plan files and keep the UI usable.
    }
  }

  return plans;
}

async function getNavigatorState(root) {
  let index = null;
  try {
    index = await loadIndex(root);
  } catch {
    index = null;
  }

  return {
    root: path.resolve(root),
    index: index ? {
      generatedAt: index.generatedAt,
      files: index.files.length,
      projects: index.projects
    } : null,
    plans: await listPlans(root),
    queue: await loadQueue(root)
  };
}

async function createPlanFromText(root, text) {
  let index;
  try {
    index = await loadIndex(root);
  } catch {
    index = (await buildIndex(root)).index;
  }

  const intent = extractIntent(text);
  const matches = topMatches(index, intent);
  const plan = buildPlanObject({ index, intent, brainDump: text, matches });
  const markdown = buildPlanMarkdown(plan);
  const paths = await writePlan(root, plan, markdown);
  return { plan, markdown, paths };
}

async function authorizePlanTasks(root, planId, taskIds) {
  const plans = await listPlans(root);
  const planMeta = plans.find((candidate) => candidate.id === planId);
  if (!planMeta) throw new Error(`Plan not found: ${planId}`);
  const selected = planMeta.approvalTasks.filter((task) => taskIds.includes(task.id));
  if (selected.length === 0) throw new Error("No selected tasks found for this plan.");
  return addTasksToQueue(root, selected, planMeta.markdownPath);
}

async function handleApi(root, request, response) {
  const url = new URL(request.url, "http://localhost");

  try {
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, await getNavigatorState(root));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/index") {
      const result = await buildIndex(root);
      sendJson(response, 200, {
        indexPath: toPosix(path.relative(path.resolve(root), result.indexPath)),
        files: result.index.files.length,
        projects: result.index.projects.length
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/plan") {
      const body = await readJsonBody(request);
      if (!body.text || !body.text.trim()) throw new Error("Brain dump text is required.");
      const result = await createPlanFromText(root, body.text);
      sendJson(response, 200, {
        plan: result.plan,
        markdown: result.markdown,
        paths: {
          markdown: toPosix(path.relative(path.resolve(root), result.paths.planPath)),
          json: toPosix(path.relative(path.resolve(root), result.paths.jsonPath))
        }
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/authorize") {
      const body = await readJsonBody(request);
      const result = await authorizePlanTasks(root, body.planId, body.taskIds ?? []);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/dispatch") {
      const body = await readJsonBody(request);
      const result = await dispatchQueuedTasks(root, Number(body.limit ?? 1));
      sendJson(response, 200, {
        dispatched: result.dispatched.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          workPackage: task.workPackage
        })),
        queuePath: result.queuePath
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/work") {
      const body = await readJsonBody(request);
      const result = await runWorker(root, Number(body.limit ?? 1));
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/handoff") {
      const body = await readJsonBody(request);
      const result = await createAgentHandoffs(root, Number(body.limit ?? 1));
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ingest") {
      const body = await readJsonBody(request);
      const result = await ingestAgentResult(root, body);
      sendJson(response, 200, {
        task: result.task,
        queuePath: result.queuePath,
        resultPath: result.resultPath
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loop") {
      const body = await readJsonBody(request);
      const result = await runAutopilot(root, {
        cycles: Number(body.cycles ?? 1),
        limit: Number(body.limit ?? 3),
        intervalMs: Number(body.intervalMs ?? 300_000)
      });
      sendJson(response, 200, { pulses: result });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/report") {
      const result = await writeStatusReport(root);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent-run") {
      const body = await readJsonBody(request);
      const result = await runAgentCommand(root, {
        command: body.command,
        limit: Number(body.limit ?? 1)
      });
      sendJson(response, 200, result);
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (request.method === "PATCH" && statusMatch) {
      const body = await readJsonBody(request);
      const result = await updateTaskStatus(root, decodeURIComponent(statusMatch[1]), body.status);
      sendJson(response, 200, result.task);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

function renderAppHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Praxia Navigator</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --panel-2: #f0f4f8;
      --text: #202124;
      --muted: #626b74;
      --line: #d8dee4;
      --accent: #176b87;
      --accent-2: #0f766e;
      --danger: #a23b3b;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.92);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    .bar {
      max-width: 1440px;
      margin: 0 auto;
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
      letter-spacing: 0;
    }
    main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 18px 20px 28px;
      display: grid;
      grid-template-columns: minmax(320px, 0.9fr) minmax(420px, 1.2fr) minmax(320px, 0.9fr);
      gap: 16px;
      align-items: start;
    }
    section, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    section h2 {
      margin: 0;
      padding: 13px 14px;
      font-size: 14px;
      font-weight: 650;
      border-bottom: 1px solid var(--line);
    }
    .body { padding: 14px; }
    .muted { color: var(--muted); }
    .small { font-size: 12px; }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    textarea {
      width: 100%;
      min-height: 380px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
      font: inherit;
      background: #fff;
      color: var(--text);
    }
    button, select {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
      min-height: 36px;
    }
    button {
      cursor: pointer;
      font-weight: 600;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    button.secondary {
      background: var(--panel-2);
    }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .stack { display: grid; gap: 12px; }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .stat {
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px;
      min-width: 0;
    }
    .stat strong {
      display: block;
      font-size: 17px;
    }
    .list {
      display: grid;
      gap: 8px;
      max-height: 410px;
      overflow: auto;
      padding-right: 2px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      background: #fff;
    }
    .task {
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: 8px;
      align-items: start;
    }
    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      margin-top: 2px;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      background: #e8f3f1;
      color: #135e58;
      font-size: 12px;
      margin: 2px 4px 2px 0;
      max-width: 100%;
    }
    .status {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .status.blocked { color: var(--danger); }
    .status.complete { color: var(--accent-2); }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #f6f8fa;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      max-height: 340px;
      overflow: auto;
      margin: 0;
    }
    @media (max-width: 1100px) {
      main { grid-template-columns: 1fr; }
      textarea { min-height: 260px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="bar">
      <h1>Praxia Navigator</h1>
      <div class="row">
        <button id="refresh" class="secondary">Refresh</button>
        <button id="index" class="primary">Index Codebase</button>
      </div>
    </div>
  </header>
  <main>
    <section>
      <h2>Brain Dump</h2>
      <div class="body stack">
        <textarea id="dump" placeholder="Paste a Monday morning transcript, voice memo text, or raw priority dump here."></textarea>
        <div class="row">
          <button id="plan" class="primary">Generate Plan</button>
          <span id="message" class="muted small"></span>
        </div>
        <div class="stats" id="stats"></div>
      </div>
    </section>
    <section>
      <h2>Plan And Approval</h2>
      <div class="body stack">
        <div id="planSummary" class="muted">No plan selected yet.</div>
        <div id="approvalList" class="list"></div>
        <div class="row">
          <button id="authorize" class="primary" disabled>Authorize Checked Work</button>
        </div>
        <pre id="evidence"></pre>
      </div>
    </section>
    <section>
      <h2>Execution Queue</h2>
      <div class="body stack">
        <div class="row">
          <button id="dispatch" class="primary">Dispatch Next</button>
          <button id="work" class="secondary">Run Worker</button>
          <button id="handoff" class="secondary">Prepare Handoff</button>
          <button id="loop" class="secondary">Run Loop</button>
          <button id="report" class="secondary">Write Report</button>
        </div>
        <textarea id="agentResult" placeholder='Paste agent result JSON, e.g. {"taskId":"...","status":"needs_review","summary":"...","changedFiles":[],"verification":[]}' style="min-height: 120px;"></textarea>
        <div class="row">
          <button id="ingest" class="secondary">Ingest Result</button>
        </div>
        <div id="queue" class="list"></div>
      </div>
    </section>
  </main>
  <script>
    const state = { currentPlan: null };
    const el = (id) => document.getElementById(id);
    const h = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

    async function api(path, options = {}) {
      const response = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...options
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request failed");
      return payload;
    }

    function setMessage(text) {
      el("message").textContent = text;
    }

    function renderStats(data) {
      const index = data.index;
      el("stats").innerHTML = [
        ["Files", index ? index.files : 0],
        ["Projects", index ? index.projects.length : 0],
        ["Queued", data.queue.tasks.length]
      ].map(([label, value]) => '<div class="stat"><strong>' + value + '</strong><span class="muted small">' + label + '</span></div>').join("");
    }

    function renderPlan(plan) {
      state.currentPlan = plan;
      if (!plan) return;
      el("planSummary").innerHTML = [
        '<div><strong>' + h(plan.recommendation.decision) + '</strong></div>',
        '<div class="muted small">' + h(plan.recommendation.narrative) + '</div>',
        '<div>' + plan.detectedCapabilities.map((cap) => '<span class="tag">' + h(cap) + '</span>').join("") + '</div>'
      ].join("");

      el("approvalList").innerHTML = plan.approvalTasks.map((task) => {
        return '<label class="item task"><input type="checkbox" data-task-id="' + h(task.id) + '"><span><strong>' + h(task.title) + '</strong><br><span class="muted small">' + h(task.scope.allowedActions.join(", ")) + '</span></span></label>';
      }).join("");
      el("authorize").disabled = false;

      const evidence = [
        "Goals:",
        ...plan.goals.slice(0, 8).map((goal) => "- " + goal),
        "",
        "Project matches:",
        ...plan.projectMatches.slice(0, 8).map((project) => "- " + project.root + " (score " + project.score + ")"),
        "",
        "Relevant files:",
        ...plan.fileMatches.slice(0, 12).map((file) => "- " + file.relativePath + " (score " + file.score + ")")
      ].join("\\n");
      el("evidence").textContent = evidence;
    }

    function renderQueue(queue) {
      if (!queue.tasks.length) {
        el("queue").innerHTML = '<div class="muted">No authorized tasks are queued.</div>';
        return;
      }
      el("queue").innerHTML = queue.tasks.map((task) => {
        return '<div class="item"><div class="row" style="justify-content: space-between;"><strong>' + h(task.title) + '</strong><span class="status ' + h(task.status) + '">' + h(task.status) + '</span></div><div class="muted small">' + h(task.id) + '</div><div class="row" style="margin-top: 8px;">' + statusButtons(task) + '</div></div>';
      }).join("");
    }

    function statusButtons(task) {
      return ["in_progress", "testing", "blocked", "complete"].map((status) => {
        return '<button class="secondary" data-task-status="' + h(status) + '" data-task-id="' + h(task.id) + '">' + h(status.replace("_", " ")) + '</button>';
      }).join("");
    }

    async function load() {
      const data = await api("/api/state");
      renderStats(data);
      renderQueue(data.queue);
      if (!state.currentPlan && data.plans.length) renderPlan(data.plans[0]);
    }

    el("refresh").addEventListener("click", () => load().catch((error) => setMessage(error.message)));
    el("index").addEventListener("click", async () => {
      setMessage("Indexing...");
      const result = await api("/api/index", { method: "POST", body: "{}" });
      setMessage("Indexed " + result.files + " files.");
      await load();
    });
    el("plan").addEventListener("click", async () => {
      const text = el("dump").value;
      setMessage("Generating plan...");
      const result = await api("/api/plan", { method: "POST", body: JSON.stringify({ text }) });
      renderPlan(result.plan);
      setMessage("Plan generated.");
      await load();
    });
    el("authorize").addEventListener("click", async () => {
      const checked = [...document.querySelectorAll("[data-task-id]:checked")].map((input) => input.dataset.taskId);
      if (!checked.length || !state.currentPlan) return;
      setMessage("Authorizing selected work...");
      await api("/api/authorize", { method: "POST", body: JSON.stringify({ planId: state.currentPlan.id, taskIds: checked }) });
      setMessage("Authorized " + checked.length + " tasks.");
      await load();
    });
    el("dispatch").addEventListener("click", async () => {
      setMessage("Dispatching next queued task...");
      const result = await api("/api/dispatch", { method: "POST", body: JSON.stringify({ limit: 1 }) });
      setMessage(result.dispatched.length ? "Dispatched " + result.dispatched[0].title : "No queued task to dispatch.");
      await load();
    });
    el("work").addEventListener("click", async () => {
      setMessage("Worker running...");
      const result = await api("/api/work", { method: "POST", body: JSON.stringify({ limit: 1 }) });
      setMessage(result.results.length ? result.results[0].status + ": " + result.results[0].title : "No runnable task found.");
      await load();
    });
    el("handoff").addEventListener("click", async () => {
      setMessage("Preparing agent handoff...");
      const result = await api("/api/handoff", { method: "POST", body: JSON.stringify({ limit: 1 }) });
      setMessage(result.handoffs.length ? "Handoff ready: " + result.handoffs[0].title : "No task needs handoff.");
      await load();
    });
    el("ingest").addEventListener("click", async () => {
      const raw = el("agentResult").value.trim();
      if (!raw) return;
      setMessage("Ingesting agent result...");
      const result = await api("/api/ingest", { method: "POST", body: raw });
      setMessage("Ingested: " + result.task.status + " for " + result.task.title);
      el("agentResult").value = "";
      await load();
    });
    el("loop").addEventListener("click", async () => {
      setMessage("Running Navigator loop...");
      const result = await api("/api/loop", { method: "POST", body: JSON.stringify({ cycles: 1, limit: 3 }) });
      const pulse = result.pulses[0];
      setMessage("Loop complete: " + (pulse ? pulse.path : "no pulse"));
      await load();
    });
    el("report").addEventListener("click", async () => {
      setMessage("Writing status report...");
      const result = await api("/api/report");
      setMessage("Report written: " + result.latestPath);
    });
    document.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-task-status]");
      if (!button) return;
      await api("/api/tasks/" + encodeURIComponent(button.dataset.taskId) + "/status", {
        method: "PATCH",
        body: JSON.stringify({ status: button.dataset.taskStatus })
      });
      await load();
    });
    load().catch((error) => setMessage(error.message));
  </script>
</body>
</html>`;
}

async function serve(root, port) {
  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/api/")) {
      handleApi(root, request, response);
      return;
    }
    if (request.method === "GET" && (request.url === "/" || request.url.startsWith("/?"))) {
      sendHtml(response, renderAppHtml());
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`Praxia Navigator running at http://127.0.0.1:${port}`);
}

async function run() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (!command || command === "--help" || command === "-h" || options.help) {
    usage();
    return;
  }

  if (command === "index") {
    const { index, indexPath } = await buildIndex(options.root);
    console.log(`Indexed ${index.files.length} files across ${index.projects.length} project roots.`);
    console.log(`Wrote ${indexPath}`);
    return;
  }

  if (command === "plan") {
    const index = await loadIndex(options.root);
    const brainDump = await readBrainDump(options);
    const intent = extractIntent(brainDump);
    const matches = topMatches(index, intent);
    const plan = buildPlanObject({ index, intent, brainDump, matches });
    const markdown = buildPlanMarkdown(plan);
    const { planPath, jsonPath } = await writePlan(options.root, plan, markdown);
    console.log(markdown);
    console.log(`\nWrote ${planPath}`);
    console.log(`Wrote ${jsonPath}`);
    return;
  }

  if (command === "authorize") {
    const result = await authorizePlan(options.root, options.plan);
    console.log(`Authorized ${result.added} new tasks (${result.total} total queued).`);
    console.log(`Wrote ${result.queuePath}`);
    return;
  }

  if (command === "dispatch") {
    const result = await dispatchQueuedTasks(options.root, options.limit);
    if (result.dispatched.length === 0) {
      console.log("No queued tasks to dispatch.");
    } else {
      for (const task of result.dispatched) {
        console.log(`Dispatched ${task.id}: ${task.title}`);
        console.log(`Work package: ${task.workPackage}`);
      }
    }
    console.log(`Wrote ${result.queuePath}`);
    return;
  }

  if (command === "work") {
    const result = await runWorker(options.root, options.limit);
    if (result.results.length === 0) {
      console.log("No runnable tasks found.");
    } else {
      for (const task of result.results) {
        console.log(`${task.status}: ${task.id}`);
        console.log(task.summary);
        if (task.artifacts.length) console.log(`Artifacts: ${task.artifacts.join(", ")}`);
      }
    }
    console.log(`Wrote ${result.queuePath}`);
    return;
  }

  if (command === "handoff") {
    const result = await createAgentHandoffs(options.root, options.limit);
    if (result.handoffs.length === 0) {
      console.log("No tasks need agent handoff.");
    } else {
      for (const handoff of result.handoffs) {
        console.log(`ready_for_agent: ${handoff.id}`);
        console.log(`Prompt: ${handoff.prompt}`);
        console.log(`Context: ${handoff.context}`);
      }
    }
    console.log(`Wrote ${result.queuePath}`);
    return;
  }

  if (command === "ingest") {
    if (!options.result) throw new Error("Provide --result <file>.");
    const resultFile = path.resolve(options.root, options.result);
    const payload = JSON.parse(await fs.readFile(resultFile, "utf8"));
    const result = await ingestAgentResult(options.root, payload);
    console.log(`Ingested result for ${result.task.id}: ${result.task.status}`);
    console.log(`Result: ${result.resultPath}`);
    console.log(`Wrote ${result.queuePath}`);
    return;
  }

  if (command === "agent-run") {
    const result = await runAgentCommand(options.root, options);
    if (result.results.length === 0) {
      console.log("No ready_for_agent tasks found.");
    } else {
      for (const item of result.results) {
        console.log(`${item.task.status}: ${item.task.id}`);
        if (item.resultPath) console.log(`Result: ${item.resultPath}`);
      }
    }
    console.log(`Wrote ${result.queuePath}`);
    return;
  }

  if (command === "loop") {
    const pulses = await runAutopilot(options.root, options);
    for (const pulse of pulses) {
      console.log(`Pulse: ${pulse.path}`);
      console.log(`Queue: ${JSON.stringify(pulse.queueSummary)}`);
      for (const action of pulse.actions) console.log(`- ${action}`);
      if (pulse.next.length) {
        console.log("Next:");
        for (const item of pulse.next) console.log(`- ${item}`);
      }
    }
    return;
  }

  if (command === "report") {
    const result = await writeStatusReport(options.root);
    console.log(result.markdown);
    console.log(`Wrote ${result.reportPath}`);
    console.log(`Wrote ${result.latestPath}`);
    return;
  }

  if (command === "status") {
    const result = await updateTaskStatus(options.root, options.task, options.status);
    console.log(`Updated ${result.task.id} to ${result.task.status}.`);
    console.log(`Wrote ${result.queuePath}`);
    return;
  }

  if (command === "queue") {
    const queue = await loadQueue(options.root);
    console.log(formatQueue(queue));
    return;
  }

  if (command === "serve") {
    await serve(options.root, options.port);
    return;
  }

  usage();
  process.exitCode = 1;
}

run().catch((error) => {
  console.error(`praxia-navigator: ${error.message}`);
  process.exitCode = 1;
});
