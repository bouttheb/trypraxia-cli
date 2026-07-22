# Praxia Navigator

Praxia Navigator is the first slice of the Praxia planning and orchestration layer.

It does two jobs today:

1. Index the local Praxia codebase.
2. Convert a long-form brain dump or transcript into a codebase-grounded execution plan.
3. Let you approve selected tasks in batches.
4. Track authorized tasks in an execution queue.

It is intentionally additive. It does not change the main Praxia UI yet, and it does not execute code changes. The next layer should add approvals, task queueing, and autonomous execution.

## Usage

From the Praxia repo root:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs index
```

Then generate a plan from a transcript:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs plan --input monday-dump.txt
```

Or pass text directly:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs plan "Build a weekly planning tool that can index every project and orchestrate approved tasks."
```

Start the local UI:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs serve
```

Then open:

```text
http://127.0.0.1:4789
```

Approve checked markdown tasks:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs authorize --plan .praxia-navigator/plans/<plan>.md
```

View the queue:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs queue
```

Dispatch the next approved task into an implementation work package:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs dispatch --limit 1
```

Run the worker against approved tasks:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs work --limit 3
```

Prepare implementation-agent handoffs for tasks that need coding-agent work:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs handoff --limit 3
```

Ingest a coding-agent result:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs ingest --result agent-result.json
```

Run a configured implementation-agent command against ready handoffs:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs agent-run --command "your-agent-command" --limit 1
```

The command receives:

```text
PRAXIA_ROOT
PRAXIA_TASK_ID
PRAXIA_HANDOFF_DIR
PRAXIA_PROMPT
PRAXIA_CONTEXT
PRAXIA_RESULT
```

It should either print the result JSON to stdout or write it to `PRAXIA_RESULT`.

Run one Navigator loop cycle:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs loop --cycles 1 --limit 3
```

Write the current status report:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs report
```

Run with a five-minute pulse interval:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs loop --cycles 12 --interval-ms 300000
```

Expected result shape:

```json
{
  "taskId": "task-id",
  "status": "needs_review",
  "summary": "Implemented the scoped change and ran focused tests.",
  "changedFiles": ["apps/example/file.ts"],
  "verification": [
    {
      "command": "npm test",
      "result": "passed"
    }
  ],
  "remainingRisk": "Optional notes."
}
```

Move a task through execution states:

```bash
node tools/praxia-navigator/bin/praxia-navigator.mjs status --task <task-id> --status in_progress
node tools/praxia-navigator/bin/praxia-navigator.mjs status --task <task-id> --status complete
```

The index is written to:

```text
.praxia-navigator/index.json
```

Generated plans are written to:

```text
.praxia-navigator/plans/
```

The execution queue is written to:

```text
.praxia-navigator/queue.json
```

Dispatched work packages are written to:

```text
.praxia-navigator/work-packages/
```

Completed task summaries are written to:

```text
.praxia-navigator/completions/
```

Implementation-agent handoff packages are written to:

```text
.praxia-navigator/agent-handoffs/
```

Raw implementation-agent results are written to:

```text
.praxia-navigator/agent-results/
```

Tasks needing human/code review are written to:

```text
.praxia-navigator/reviews/
```

New-program proposals are written to:

```text
.praxia-navigator/proposals/
```

Pulse reports are written to:

```text
.praxia-navigator/pulses/
```

Status reports are written to:

```text
.praxia-navigator/reports/
```

## Current Scope

This MVP uses local lexical matching and repo metadata. It is designed to be useful before adding embeddings, LLM summarization, direct audio transcription, or background execution.

The current approval model is intentionally scoped:

- Plans propose checkbox tasks.
- Checked tasks become authorized queue items.
- Queue items can move through `queued`, `in_progress`, `testing`, `blocked`, `complete`, or `cancelled`.
- Dispatching a queue item creates a scoped work package and marks it `in_progress`.
- Running the worker completes tasks with deterministic handlers and blocks tasks that require a missing external capability or explicit approval.
- Preparing a handoff writes `prompt.md` and `context.json` for a coding agent and marks the task `ready_for_agent`.
- Ingesting an agent result marks the task `needs_review`, `complete`, or `blocked` and writes a review or completion artifact.
- Running an agent command marks tasks `agent_running`, executes the configured command, then ingests its result.
- New-program creation tasks generate approval proposals and remain review-gated before scaffolding.
- New program creation, destructive data changes, credential access, and broad architecture decisions still require explicit approval.

Planned next steps:

- Add semantic embeddings for stronger matching.
- Add a capability map per Praxia program.
- Add direct audio transcription.
- Add implementation-agent integration so blocked work packages can be picked up and edited automatically.
- Add Codex/GitHub integration for implementation branches and PRs.
