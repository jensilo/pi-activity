# Configuration

Read `README.md` before installing or changing Activity configuration. Its
configuration reference defines the one global file; `activity.schema.json`
documents advanced settings. Use synthetic fixtures only.

# Privacy and publication boundary

- Never copy real activity logs, runtime arguments, credential values or business data into this worktree, including ignored `out/`, `data/`, temporary files and drafts.
- Keep all real runtime captures outside every Git worktree. Scrubbed captures remain private and must never be published.
- Inspect existing private captures only with local scripts that emit fixed-category aggregate counts. Do not print samples or send log contents to a model provider.
- Use synthetic fixtures only. Never derive committed examples from real credential-bearing or business activity.
- Commit and release only reviewed source, synthetic tests and aggregate metadata. Check the exact staged files and artifact inventory; ignore rules alone are not protection.
- No automatic training ingestion. Any later evaluation, synthesis or training export needs deliberate private sanitization and independent review outside this repository.
- Activity-log cleanup does not authorize changing Pi sessions, MCP-server records, provider data or research archives.
- Do not revert or commit unrelated changes made by parallel agents.
