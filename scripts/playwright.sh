#!/usr/bin/env bash
set -euo pipefail

NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  detected_node="$(command -v node)"
  if [[ "$detected_node" == /tmp/bun-node-* ]]; then
    if [[ -n "${NVM_BIN:-}" && -x "${NVM_BIN}/node" ]]; then
      NODE_BIN="${NVM_BIN}/node"
    elif [[ -x "/usr/bin/node" ]]; then
      NODE_BIN="/usr/bin/node"
    else
      NODE_BIN="$detected_node"
    fi
  else
    NODE_BIN="$detected_node"
  fi
fi

exec "$NODE_BIN" ./node_modules/.bin/playwright "$@"
