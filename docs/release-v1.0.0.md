# v1.0.0

This release replaces all earlier settings. Activity rejects old classifier, path and
judge prompt-file settings. Activity has no automatic migration. Tested with Pi 1.5.0.

- **Configuration.** Activity reads one file: `<agent-dir>/config/activity.json`. At
  first start, it creates the file with acclass on and the Q8 model. It does not
  change an existing file. It ignores local and project configuration.
- **acclass.** The settings are `enabled` and `variant` (`q8`, `q5`, `fp32`). A valid
  installation needs no download. Otherwise Activity asks you once for each runtime.
  It uses the network only if you accept. If you decline, the setup fails, or Pi has
  no UI, the judge checks the calls. Activity does not repair a corrupt installation.
  Run `/reload` to get the question again.
- **Judge.** The judge uses your current chat model by default. `null` turns it off.
  `auto.judgeInstructions` holds your additional guidance as one inline string.
- **Install checks.** Activity downloads the v1.0.0 installer over HTTPS, with a 1 MiB
  limit. It checks the pinned SHA-256 hash before it writes or runs the file. The
  package does not include the installer.
- **Runtime checks.** Activity checks all installed files and hashes before each
  classification. Each version and model has its own socket path.

Guards, logs, the UI and parent task context stay available. See the README and
`activity.schema.json`.

## Release limits

Live downloads and real installation were not tested. Release endpoint
availability was not checked. Offline fixtures verify setup, consent, integrity
rejection and judge fallback only.

The release manifest has no signature. The hashes check that files did not change.
They do not prove who published the release. The classifier does not guarantee
safety. Pi installs this package from Git, not from npm.
