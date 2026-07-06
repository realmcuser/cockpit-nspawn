#!/bin/bash
# snapshot-db.sh <container-name>
#
# Only ever invoked by dispatch.sh (the name is already validated there,
# but re-checked here defensively since this script could in principle be
# run directly). Best-effort application-consistent DB dump, taken *inside*
# the container via systemd-run so the DB password never has to leave this
# host (see ../pull-backup-threat-model.md section 3.3) - the vault never
# sees or sends any DB credential.
#
# Containers with no DB configured here are a normal, supported case - this
# just no-ops (exit 0) for them, it does not treat "no DB" as a failure.
#
# Credentials file: /etc/cockpit-nspawn/pull/<name>.cnf, a mysql [client]
# section with the DB password, mode 600, created once by whoever sets up
# pull backups for this container (see example.cnf in this directory).
#
# The dump lands inside the container's own tree so it rides along with the
# rsync pull.sh triggers right after this; restore-after-backup.sh removes
# it again afterwards so a stale plaintext dump doesn't sit around on disk
# between pulls.

set -euo pipefail

NAME_RE='^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
name="${1:-}"
[[ "$name" =~ $NAME_RE ]] || { echo "snapshot-db.sh: invalid container name: '$name'" >&2; exit 1; }

MYCNF_SRC="/etc/cockpit-nspawn/pull/${name}.cnf"
if [ ! -f "$MYCNF_SRC" ]; then
    echo "snapshot-db.sh: no DB configured for '$name' ($MYCNF_SRC missing) - skipping DB dump" >&2
    exit 0
fi

if ! machinectl show "$name" --property=State 2>/dev/null | grep -q '^State=running'; then
    echo "snapshot-db.sh: container '$name' is not running - cannot dump its DB" >&2
    exit 1
fi

# Paths as seen from inside the container's own namespace.
CREDS_IN_CONTAINER="/root/.np-mycnf"
DUMP_IN_CONTAINER="/var/tmp/cockpit-nspawn-db.sql"
# Same paths as seen from out here, via the container's on-disk tree.
dest_creds="/var/lib/machines/${name}${CREDS_IN_CONTAINER}"
dest_dump="/var/lib/machines/${name}${DUMP_IN_CONTAINER}"

install -m600 "$MYCNF_SRC" "$dest_creds"
trap 'rm -f "$dest_creds"' EXIT

systemd-run --machine="$name" --wait --quiet -- \
    bash -c "mysqldump --defaults-extra-file=$CREDS_IN_CONTAINER --single-transaction --routines --events --all-databases > $DUMP_IN_CONTAINER"

echo "snapshot-db.sh: db dump ready for '$name' ($dest_dump)" >&2
