#!/bin/sh
set -eu
umask 077
DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DEPLOY_DIR"
mkdir -p backups
BACKUP_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="backups/database-$BACKUP_STAMP.dump"
docker compose --project-name shop-agent-showcase --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yaml" exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-privileges' > "$TARGET.part"
mv "$TARGET.part" "$TARGET"
# Only this project's dated backup files are eligible for retention cleanup.
find backups -maxdepth 1 -type f -name 'database-????????T??????Z.dump' -mtime +7 -delete
