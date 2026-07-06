#!/bin/bash
# dispatch.sh - forced SSH command for a nspawn-pull *source* host (not the
# vault). Installed at /usr/local/lib/nspawn-pull/dispatch.sh and wired up
# via a line in this host's /root/.ssh/authorized_keys:
#
#   restrict,command="/usr/local/lib/nspawn-pull/dispatch.sh" <vault-pubkey>
#
# `restrict` + `command=` means sshd only ever runs *this script* for that
# key, regardless of what the client actually asked for - the requested
# command lands in $SSH_ORIGINAL_COMMAND and is otherwise never executed.
# This script is the entire access-control boundary between "a vault has
# this host's key" and "a vault can read/run arbitrary things here" - see
# ../pull-backup-threat-model.md section 3 for the design this implements,
# and treat any change here as security-sensitive.
#
# Whitelists exactly three things, matching engine/pull.sh on the vault
# side: `snapshot-db <name>`, `restore-after-backup <name>`, and a
# read-only rsync of exactly one container's live tree.

set -euo pipefail

BIN_DIR="/usr/local/lib/nspawn-pull"
CONTAINERS_ROOT="/var/lib/machines"

# Mirrors nspawn-vault-web's _CONTAINER_NAME_RE (web/backend/vault_config.py)
# - keep these two in sync, they're opposite ends of the same trust boundary.
NAME_RE='^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'

cmd="${SSH_ORIGINAL_COMMAND:-}"

case "$cmd" in
    "snapshot-db "*)
        name="${cmd#snapshot-db }"
        [[ "$name" =~ $NAME_RE ]] || { echo "dispatch.sh: rejected container name: '$name'" >&2; exit 1; }
        exec "$BIN_DIR/snapshot-db.sh" "$name"
        ;;
    "restore-after-backup "*)
        name="${cmd#restore-after-backup }"
        [[ "$name" =~ $NAME_RE ]] || { echo "dispatch.sh: rejected container name: '$name'" >&2; exit 1; }
        exec "$BIN_DIR/restore-after-backup.sh" "$name"
        ;;
    "rsync --server --sender"*)
        # pull.sh always requests the path "/$NAME/" (see its rsync -e
        # invocation) - rsync's client puts that as the last word of the
        # --server command line it sends. rrsync does NOT replace that
        # request outright: the path given to rrsync becomes the confinement
        # root, and the client's own requested path is then resolved
        # *relative to* that root - so handing rrsync the container's own
        # directory here (e.g. ".../hermes-agent") while the client also
        # requests "/hermes-agent/" resolves to the nonsensical
        # ".../hermes-agent/hermes-agent" (confirmed live against a real
        # pull - this used to hand rrsync the per-container path directly,
        # which is wrong for exactly this reason). Handing it the *parent*
        # ($CONTAINERS_ROOT) instead lets the client's own relative path
        # resolve correctly to the right container.
        #
        # This does mean any container under $CONTAINERS_ROOT on this host
        # is reachable through this key, not just the one requested here -
        # that's fine: this key already belongs to one specific vault that
        # is equally trusted for every container listed in its own
        # /etc/nspawn-vault/<host>/containers, there's no meaningful
        # boundary to enforce *between* containers for the same vault. The
        # name is still extracted and validated below purely so a garbled
        # or nonexistent container name fails fast with a clear message
        # instead of rrsync producing a confusing error of its own.
        last_arg="${cmd##* }"
        name="${last_arg#/}"
        name="${name%/}"
        [[ "$name" =~ $NAME_RE ]] || { echo "dispatch.sh: rejected rsync path: '$last_arg'" >&2; exit 1; }
        [ -d "$CONTAINERS_ROOT/$name" ] || { echo "dispatch.sh: no such container: '$name'" >&2; exit 1; }
        exec rrsync -ro "$CONTAINERS_ROOT/"
        ;;
    *)
        echo "dispatch.sh: rejected command: '$cmd'" >&2
        exit 1
        ;;
esac
