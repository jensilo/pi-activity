# Configuration

Read `README.md` before you install or configure Activity. `activity.schema.json`
lists all settings. Use synthetic fixtures only.

# Data rules

- Never copy real activity logs, runtime arguments, credentials or business data into this worktree. This includes ignored folders, temporary files and drafts.
- Keep real logs outside every Git worktree. Do not publish them, even after scrubbing.
- Inspect real logs only with local scripts that print fixed-category counts. Do not print samples or send log contents to a model provider.
- Do not derive committed examples from real data.
- Commit and release only source, synthetic tests and aggregate counts. Check the staged files and the package inventory. Ignore rules alone do not protect you.
- Log cleanup does not include Pi sessions, MCP-server records or provider data.
- Do not change or commit work that is not yours.
