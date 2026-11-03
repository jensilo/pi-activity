# v1.0.0

**Breaking clean release.** No backward compatibility or automatic migration is
provided. Legacy classifier/path settings and judge prompt-file settings are
rejected. Only the single configuration described in README is supported.
Tested with Pi 1.5.0.

- One global configuration: `<agent-dir>/config/activity.json`. The first
  `session_start` exclusively creates a brief acclass-enabled Q8 file if absent.
  Existing files stay unchanged; local overrides and project config are ignored.
- Managed acclass accepts only `enabled` and `variant` (`q8`, `q5`, `fp32`). A
  valid matching install needs no download. New installation requires one UI
  confirmation before network/install work; no UI, decline or failure uses LLM
  review, never fast allow. Corrupt installs are not silently repaired.
  One setup offer per runtime; `/reload` can retry.
- An omitted judge uses the current registered chat model. Explicit null disables
  it. Additional judge guidance is one inline `auto.judgeInstructions` string.
- After consent and manifest preflight, Activity downloads the upstream v1.0.0
  installer over HTTPS and verifies its pinned SHA-256 before writing or running
  it. The download cap is 1 MiB. The installer runs from private scratch storage
  with a fixed child environment. It is not bundled in the package.
  Each classification rechecks the installed inventory and hashes; daemon paths
  are physical version pins with private version/variant sockets.
- Policy, guards, private logging, UI and inherited-context integration remain
  available. README owns the brief configuration reference; the schema owns
  advanced settings.

## Release limits

Live downloads and real installation were not tested. Release endpoint
availability was not checked. Offline fixtures verify setup, consent, integrity
rejection and judge fallback only.

The release manifest is unsigned. HTTPS-derived manifest and asset hashes are
transport-based integrity checks, not independent signed publisher provenance.
Classification is an optimization, not a safety guarantee. This is a public Pi
Git package, not an npm release. Do not attach private runtime captures.
