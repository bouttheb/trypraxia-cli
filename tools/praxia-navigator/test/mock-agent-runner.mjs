import { promises as fs } from "node:fs";

const resultPath = process.env.PRAXIA_RESULT;
const taskId = process.env.PRAXIA_TASK_ID;
if (!resultPath || !taskId) {
  throw new Error("Missing PRAXIA_RESULT or PRAXIA_TASK_ID.");
}

await fs.writeFile(resultPath, `${JSON.stringify({
  taskId,
  status: "needs_review",
  summary: "Mock agent completed the handoff and produced a review-ready result.",
  changedFiles: [],
  verification: [{ command: "mock-agent", result: "passed" }]
}, null, 2)}\n`);
