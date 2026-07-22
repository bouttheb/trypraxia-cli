import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "tools/praxia-navigator/bin/praxia-navigator.mjs");

async function run(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? repoRoot,
    maxBuffer: 1024 * 1024 * 5
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "praxia-navigator-"));
  await fs.mkdir(path.join(root, "apps/admin-engine/src"), { recursive: true });
  await fs.mkdir(path.join(root, "apps/operations-engine/src"), { recursive: true });

  await fs.writeFile(
    path.join(root, "apps/admin-engine/README.md"),
    "# Admin Engine\n\nHandles clients, contacts, dashboards, and user permissions.\n"
  );
  await fs.writeFile(
    path.join(root, "apps/admin-engine/src/contacts.ts"),
    "export function listContacts() { return ['client', 'lead', 'account']; }\n"
  );
  await fs.writeFile(
    path.join(root, "apps/operations-engine/README.md"),
    "# Operations Engine\n\nHandles projects, tasks, reminders, queues, and weekly status.\n"
  );
  await fs.writeFile(
    path.join(root, "apps/operations-engine/src/tasks.ts"),
    "export function createTask(title) { return { title, status: 'queued' }; }\n"
  );

  await run(["index", "--root", root]);
  const index = JSON.parse(await fs.readFile(path.join(root, ".praxia-navigator/index.json"), "utf8"));
  assert.equal(index.projects.length, 2);
  assert.ok(index.projects.some((project) => project.root === "apps/admin-engine"));
  assert.ok(index.projects.some((project) => project.root === "apps/operations-engine"));

  const { stdout } = await run([
    "plan",
    "--root",
    root,
    "This week I need to build client follow-up tasks with contacts, projects, reminders, and approval checkboxes."
  ]);
  assert.match(stdout, /Approval Checklist/);
  assert.match(stdout, /apps\/operations-engine|apps\/admin-engine/);

  const planFiles = await fs.readdir(path.join(root, ".praxia-navigator/plans"));
  const markdownFile = planFiles.find((file) => file.endsWith(".md"));
  assert.ok(markdownFile);
  const markdownPath = path.join(root, ".praxia-navigator/plans", markdownFile);
  const markdown = await fs.readFile(markdownPath, "utf8");
  await fs.writeFile(markdownPath, markdown.replace("- [ ] Build or refresh", "- [x] Build or refresh"));

  await run(["authorize", "--root", root, "--plan", path.relative(root, markdownPath)]);
  let queue = JSON.parse(await fs.readFile(path.join(root, ".praxia-navigator/queue.json"), "utf8"));
  assert.equal(queue.tasks.length, 1);
  assert.equal(queue.tasks[0].status, "queued");

  await run(["dispatch", "--root", root, "--limit", "1"]);
  queue = JSON.parse(await fs.readFile(path.join(root, ".praxia-navigator/queue.json"), "utf8"));
  assert.equal(queue.tasks[0].status, "in_progress");
  assert.ok(queue.tasks[0].workPackage);

  await run(["work", "--root", root, "--limit", "1"]);
  queue = JSON.parse(await fs.readFile(path.join(root, ".praxia-navigator/queue.json"), "utf8"));
  assert.equal(queue.tasks[0].status, "complete");
  assert.ok(queue.tasks[0].completion);
  assert.ok(await fs.readFile(path.join(root, queue.tasks[0].completion), "utf8"));

  queue.tasks.push({
    id: "custom-cross-program-task-test",
    title: "Build a custom cross-program workflow that needs implementation agent work.",
    status: "blocked",
    sourcePlan: "manual-test",
    scope: {
      targetProjects: ["apps/admin-engine", "apps/operations-engine"],
      relevantFiles: ["apps/admin-engine/src/contacts.ts", "apps/operations-engine/src/tasks.ts"],
      allowedActions: ["inspect", "edit relevant files", "run local verification"],
      requiresApprovalFor: ["new program creation", "production data changes"]
    },
    guardrails: ["Do not change unrelated programs."],
    authorizedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: []
  });
  await fs.writeFile(path.join(root, ".praxia-navigator/queue.json"), `${JSON.stringify(queue, null, 2)}\n`);

  await run(["handoff", "--root", root, "--limit", "1"]);
  queue = JSON.parse(await fs.readFile(path.join(root, ".praxia-navigator/queue.json"), "utf8"));
  const customTask = queue.tasks.find((task) => task.id === "custom-cross-program-task-test");
  assert.equal(customTask.status, "ready_for_agent");
  assert.ok(customTask.agentHandoff);
  assert.ok(await fs.readFile(path.join(root, customTask.agentHandoff, "prompt.md"), "utf8"));
  assert.ok(await fs.readFile(path.join(root, customTask.agentHandoff, "context.json"), "utf8"));

  const resultPath = path.join(root, "agent-result.json");
  await fs.writeFile(resultPath, `${JSON.stringify({
    taskId: customTask.id,
    status: "needs_review",
    summary: "Implemented the custom workflow in the approved files.",
    changedFiles: ["apps/admin-engine/src/contacts.ts", "apps/operations-engine/src/tasks.ts"],
    verification: [{ command: "node --check", result: "passed" }],
    remainingRisk: "Needs product review before marking complete."
  }, null, 2)}\n`);
  await run(["ingest", "--root", root, "--result", path.relative(root, resultPath)]);
  queue = JSON.parse(await fs.readFile(path.join(root, ".praxia-navigator/queue.json"), "utf8"));
  const reviewedTask = queue.tasks.find((task) => task.id === customTask.id);
  assert.equal(reviewedTask.status, "needs_review");
  assert.ok(reviewedTask.agentResult);
  assert.ok(reviewedTask.review);
  assert.ok(await fs.readFile(path.join(root, reviewedTask.review), "utf8"));

  queue.tasks.push({
    id: "agent-run-command-test",
    title: "Run a mock implementation agent against this ready handoff.",
    status: "ready_for_agent",
    sourcePlan: "manual-test",
    scope: {
      targetProjects: ["apps/admin-engine"],
      relevantFiles: ["apps/admin-engine/src/contacts.ts"],
      allowedActions: ["inspect", "edit relevant files", "run local verification"],
      requiresApprovalFor: ["new program creation"]
    },
    guardrails: ["Only use the mock agent in tests."],
    authorizedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: []
  });
  await fs.writeFile(path.join(root, ".praxia-navigator/queue.json"), `${JSON.stringify(queue, null, 2)}\n`);
  await run(["handoff", "--root", root, "--limit", "1"]);
  const mockAgent = path.join(repoRoot, "tools/praxia-navigator/test/mock-agent-runner.mjs");
  await run(["agent-run", "--root", root, "--command", `${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgent)}`, "--limit", "1"]);
  queue = JSON.parse(await fs.readFile(path.join(root, ".praxia-navigator/queue.json"), "utf8"));
  const agentRunTask = queue.tasks.find((task) => task.id === "agent-run-command-test");
  assert.equal(agentRunTask.status, "needs_review");
  assert.ok(agentRunTask.agentResult);

  await run(["loop", "--root", root, "--cycles", "1", "--limit", "3"]);
  const pulses = await fs.readdir(path.join(root, ".praxia-navigator/pulses"));
  assert.ok(pulses.some((file) => file.endsWith(".md")));

  queue = JSON.parse(await fs.readFile(path.join(root, ".praxia-navigator/queue.json"), "utf8"));
  queue.tasks.push({
    id: "draft-new-program-proposal-test",
    title: "Draft a new-program proposal with purpose, boundaries, dependencies, and files to scaffold.",
    status: "queued",
    sourcePlan: "manual-test",
    scope: {
      targetProjects: [],
      relevantFiles: [],
      allowedActions: ["inspect", "update docs"],
      requiresApprovalFor: ["new program creation"]
    },
    guardrails: ["Do not scaffold the new program before approval."],
    authorizedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: []
  });
  await fs.writeFile(path.join(root, ".praxia-navigator/queue.json"), `${JSON.stringify(queue, null, 2)}\n`);
  await run(["work", "--root", root, "--limit", "10"]);
  queue = JSON.parse(await fs.readFile(path.join(root, ".praxia-navigator/queue.json"), "utf8"));
  const proposalTask = queue.tasks.find((task) => task.id === "draft-new-program-proposal-test");
  assert.equal(proposalTask.status, "needs_review");
  assert.ok(proposalTask.review);
  const proposals = await fs.readdir(path.join(root, ".praxia-navigator/proposals"));
  assert.ok(proposals.some((file) => file.endsWith(".md")));

  await run(["report", "--root", root]);
  assert.ok(await fs.readFile(path.join(root, ".praxia-navigator/reports/latest.md"), "utf8"));

  console.log("navigator tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
