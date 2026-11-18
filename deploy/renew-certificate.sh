#!/bin/sh
set -eu
DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DEPLOY_DIR"
exec 9>"$DEPLOY_DIR/.certificate-renew.lock"
flock -n 9 || exit 0
docker compose --project-name shop-agent-showcase --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yaml" run --rm certbot renew --webroot --webroot-path /var/www/acme --quiet
docker compose --project-name shop-agent-showcase --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yaml" exec -T web nginx -t
docker compose --project-name shop-agent-showcase --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yaml" exec -T web nginx -s reload
