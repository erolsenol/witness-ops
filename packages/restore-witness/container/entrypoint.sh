#!/bin/sh
set -eu
case "${RW_POSTGRES_MAJOR:-18}" in
  16|17|18) ;;
  *) printf '%s\n' 'RW_POSTGRES_MAJOR must be 16, 17, or 18.' >&2; exit 2 ;;
esac
PATH="/usr/lib/postgresql/${RW_POSTGRES_MAJOR:-18}/bin:$PATH"
export PATH
exec node /app/dist/cli.js "$@"
