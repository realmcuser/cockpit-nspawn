#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install npm dependencies
npm install

# Fetch cockpit lib files required for building (pkg/lib)
if [ ! -d "pkg/lib" ]; then
    git fetch https://github.com/cockpit-project/cockpit main
    git archive FETCH_HEAD -- pkg/lib | tar -x
fi
