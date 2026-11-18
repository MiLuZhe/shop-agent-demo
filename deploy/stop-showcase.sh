#!/bin/sh
set -eu
DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DEPLOY_DIR"
docker compose --project-name shop-agent-showcase --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yaml" stop --timeout 20 web api postgres
