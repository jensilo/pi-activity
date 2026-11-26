# Activity fixtures

Run `npm test` from the package root. This uses the installed Pi host and an
isolated synthetic HOME, without installation, providers, real logs or acclass
source checkout. See [testing](../../docs/testing.md) for loader setup, tool checks
and explicit live opt-ins.

Fixtures preserve the gate's safety contracts: hard guards are non-overridable;
full arguments/provenance reach review; only direct human instructions and verified
questionnaire receipts supply authorization evidence; cancellation cannot admit a
late allow; missing or unavailable judges block without a prompt;
privacy/storage errors have no raw logging fallback.
Managed setup tests use synthetic manifests, install files and injected network/
process seams; they perform no live download or installation. Gate fixtures inject
synthetic classifier adapters where needed. Model tests cover current registered
chat-model selection for summaries, exact classifier targets, and null disabling.
Registry tests exercise physical and virtual dispatch without bypassing authentication.
The example config contains only managed acclass settings and no judge target.

Unit fixtures establish routing and prompt contracts, not live-model correctness,
real-backend safety or calibrated classifier accuracy. Only synthetic fixtures
belong here. Never derive examples from private runtime captures.
