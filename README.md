# TryPraxia CLI

The TryPraxia CLI pairs a local machine with Praxia Cloud and runs the local
daemon that claims queued project commands.

The daemon sends each local agent the current project scope docs and requires a
structured Praxia progress report so the dashboard can update project status and
completion percentage after each run.

## Usage

```bash
npx --yes trypraxia daemon login --url https://app.trypraxia.com --code <code>
gh auth login --hostname github.com --git-protocol https --web
gh auth status --hostname github.com
npx --yes trypraxia daemon doctor
npx --yes trypraxia daemon backfill-sessions
npx --yes trypraxia daemon start
```

The daemon stores its device token in `~/.praxia-cloud/dashboard.env`. Keep
that file private. Set `PRAXIA_NAVIGATOR_ROOT` there to the local folder the
Navigator should index, such as `~/Documents/Claude Code`.

GitHub credentials remain in GitHub CLI on the paired computer. Praxia Cloud
receives only the authenticated username and connection state in daemon
heartbeats; it never receives the GitHub token.

The running daemon synchronizes changed Codex and Claude Code sessions every
five seconds. Run `daemon backfill-sessions` once after pairing to import all
existing local session history through the same organization-scoped route.
