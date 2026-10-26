#!/bin/bash
set -e
pnpm install --frozen-lockfile
cat <<'EOF'
Database schema changes are not applied automatically after merge.
Review and back up the target database, then apply checked-in migrations with:
  pnpm --filter @workspace/db run migrate
EOF
