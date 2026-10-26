#!/usr/bin/env bash
set -euo pipefail

# Gemini CLI does not need DINAR's runtime credentials to inspect project source.
# Enumerate names only, then remove credentials and database connection settings before
# starting the CLI. Authentication is the user's separate Google sign-in in the CLI.
while IFS= read -r name; do
  case "$name" in
    *_API_KEY|*_SECRET|*_TOKEN|*_PASSWORD|*_DATABASE_URL|*_PRIVATE_KEY|*_CREDENTIALS|\
    DATABASE_URL|PGHOST|PGHOSTADDR|PGPORT|PGUSER|PGDATABASE|PGPASSWORD|\
    SESSION_SECRET|PRIVATE_OBJECT_DIR|PUBLIC_OBJECT_SEARCH_PATHS|\
    DEFAULT_OBJECT_STORAGE_BUCKET_ID|GOOGLE_APPLICATION_CREDENTIALS)
      unset "$name"
      ;;
  esac
done < <(compgen -e)

if [[ "${1:-}" == "--version" && "$#" == 1 ]]; then
  exec gemini --version
fi
if [[ "$#" -ne 0 ]]; then
  printf '%s\n' "This safe launcher accepts no options; use it for an interactive read-only session." >&2
  exit 64
fi

# Keep the first interactive session read-only.
exec gemini --approval-mode=plan
