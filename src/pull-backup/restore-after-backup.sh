#!/bin/bash
# restore-after-backup.sh <container-name>
#
# Always run by the vault's pull.sh via its EXIT trap, right after
# snapshot-db + the rsync - regardless of whether either one succeeded (see
# engine/usr/libexec/nspawn-vault/pull.sh). So this must be safe to call
# even when snapshot-db.sh never got as far as producing a dump.
#
# Removes the temporary DB dump snapshot-db.sh left inside the container -
# the credentials file is already cleaned up by snapshot-db.sh's own trap,
# so this is the only thing left over. Nothing inside the container is ever
# paused/frozen by this design, so there is normally nothing else to
# "restore" - the name just matches what pull.sh calls it.

set -uo pipefail  # not -e: keep going even if one cleanup step fails

NAME_RE='^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
name="${1:-}"
if [[ ! "$name" =~ $NAME_RE ]]; then
    echo "restore-after-backup.sh: invalid container name: '$name'" >&2
    exit 1
fi

dump="/var/lib/machines/${name}/var/tmp/cockpit-nspawn-db.sql"
rm -f "$dump"
echo "restore-after-backup.sh: cleaned up DB dump for '$name'" >&2
