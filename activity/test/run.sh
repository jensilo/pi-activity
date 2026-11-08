#!/usr/bin/env bash
# Offline synthetic fixtures only. Never use real logs, credentials or providers.
set -euo pipefail
export npm_config_update_notifier=false
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MODE="${1:---all}"
if [[ $# -gt 1 || ! "$MODE" =~ ^--(all|tests|tools)$ ]]; then
  printf 'Usage: bash activity/test/run.sh [--all|--tests|--tools]\n' >&2
  exit 1
fi
umask 077  # Fixtures must match the private modes that setup requires.
# Find the Pi host: PI_GLOBAL, then a managed install (~/.pi/agent), then npm -g.
if [[ -z "${PI_GLOBAL:-}" ]]; then
  PI_MANAGED="$HOME/.pi/agent/install"
  if [[ -r "$PI_MANAGED/current-version" ]]; then
    PI_GLOBAL="$PI_MANAGED/releases/$(<"$PI_MANAGED/current-version")/node_modules/@earendil-works/pi-coding-agent"
  fi
  if [[ ! -d "${PI_GLOBAL:-}" ]]; then PI_GLOBAL="$(npm root -g)/@earendil-works/pi-coding-agent"; fi
fi
export PI_GLOBAL
JITI="$PI_GLOBAL/node_modules/.bin/jiti"
# Native Pi installs can hoist dependencies beside the scoped host package.
if [[ ! -x "$JITI" ]]; then JITI="$(dirname "$(dirname "$PI_GLOBAL")")/.bin/jiti"; fi
if [[ ! -x "$JITI" ]]; then
  printf 'Cannot find Pi host jiti: %s\nSet PI_GLOBAL to your installed Pi package root.\n' "$JITI" >&2
  exit 1
fi
export NODE_PATH="$(dirname "$(dirname "$PI_GLOBAL")"):$PI_GLOBAL/node_modules${NODE_PATH:+:$NODE_PATH}"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--conditions=import"
# Keep the synthetic home outside the OS tmp allow-scope: gate fixtures must
# distinguish home writes from routine tmp writes.
SANDBOX="$(mktemp -d "$HERE/.fixtures.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
export HOME="$SANDBOX/home"
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
export npm_config_cache="$SANDBOX/npm-cache"
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0
mkdir -p "$PI_CODING_AGENT_DIR"
unset ACCLASS_TEST_MODEL ACCLASS_TEST_BINARY ACCLASS_TEST_EXTENSION_ROOT ACCLASS_TEST_JUDGE ACCLASS_TEST_JUDGE_THINKING
unset ACCLASS_PERMISSION_JUDGE ACCLASS_PERMISSION_JUDGE_THINKING ACCLASS_PERMISSION_SUMMARY ACCLASS_PERMISSION_SUMMARY_THINKING
unset ACCLASS_PERMISSION_START ACCLASS_PERMISSION_END ACCLASS_PERMISSION_MAX_DISPATCHES
unset PI_SUBAGENT_TASK PI_SUBAGENT_POLICY_CONTEXT_FD PI_ACTIVITY_AUTO_MODE
cd "$ROOT"
if [[ "$MODE" != --tools ]]; then
  for test in "$HERE"/*.test.mjs; do
    printf '\n%s\n' "$(basename "$test")"
    "$JITI" "$test"
  done
fi
if [[ "$MODE" != --tests ]]; then
  "$JITI" tools/test_activity_engine_e2e.mjs --fixture
  node tools/test_audit_activity.mjs
  "$JITI" tools/test_activity_judge_live.mjs
  "$JITI" activity/test/live-permissions.mjs
  "$JITI" tools/bench_activity_runtime.mjs
  node tools/test_activity_mcp_live.mjs
  node tools/test_standalone_sdk.mjs --fixture
  node tools/check_package_inventory.mjs
fi
