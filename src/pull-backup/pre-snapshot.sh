#!/bin/bash
# pre-snapshot.sh <container-name>
#
# Only ever invoked by dispatch.sh (the name is already validated there,
# but re-checked here defensively since this script could in principle be
# run directly). Optional, generic pre-snapshot hook - runs one
# operator-defined command *inside* the container via systemd-run, right
# before the vault's rsync pull. Exists so services with their own backup
# tooling (FreeIPA's ipa-backup, postgres's pg_dump, anything else) can
# hook into pull-backup without dispatch.sh/nspawn-vault having to know
# anything about databases - see snapshot-db.sh for the MariaDB-specific
# equivalent, kept as its own thing since it's widely used enough on its
# own to be worth keeping as a first-class option rather than folding into
# this generic mechanism.
#
# Hook command: /etc/cockpit-nspawn/pull/<name>.hook, a single shell
# command (or short script), mode 600 if it contains anything sensitive,
# created once by whoever sets up pull backups for this container (see
# example.hook in this directory). Root-authored locally on this host and
# never sent by the vault - same trust boundary as snapshot-db.sh's own
# <name>.cnf DB-credentials file: dispatch.sh only ever runs this one
# fixed, whitelisted script name, the actual command text is local config
# the vault never sees or sends.
#
# Containers with no hook configured here are a normal, supported case -
# this just no-ops (exit 0) for them, it does not treat "no hook" as a
# failure.

set -euo pipefail

NAME_RE='^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
name="${1:-}"
[[ "$name" =~ $NAME_RE ]] || { echo "pre-snapshot.sh: invalid container name: '$name'" >&2; exit 1; }

STATUS_DIR="/etc/cockpit-nspawn/backup-status"
STATUS_FILE="$STATUS_DIR/${name}-presnapshot.json"

write_status() {
    mkdir -p "$STATUS_DIR"
    printf '{"result":"%s","timestamp":"%s","message":"%s"}\n' \
        "$1" "$(date -Iseconds)" "$(printf '%s' "${2:-}" | tr '"' "'" | tr '\n' ' ')" > "$STATUS_FILE"
}

HOOK_FILE="/etc/cockpit-nspawn/pull/${name}.hook"
if [ ! -f "$HOOK_FILE" ]; then
    echo "pre-snapshot.sh: no hook configured for '$name' ($HOOK_FILE missing) - skipping" >&2
    exit 0
fi

if ! machinectl show "$name" --property=State 2>/dev/null | grep -q '^State=running'; then
    write_status "failed" "container is not running - cannot run pre-snapshot hook"
    echo "pre-snapshot.sh: container '$name' is not running - cannot run pre-snapshot hook" >&2
    exit 1
fi

hook_cmd=$(cat "$HOOK_FILE")

# --pipe connects the hook's stdio so its own stdout/stderr is actually
# captured here (--quiet alone only suppresses systemd-run's own noise) -
# without it a failing hook would only ever be visible as a bare exit
# code, with no way to tell the vault (or an admin reading the pull log)
# what actually went wrong.
if ! hook_out=$(systemd-run --machine="$name" --pipe --wait --quiet -- bash -c "$hook_cmd" 2>&1); then
    write_status "failed" "hook command failed: ${hook_out:-no output}"
    echo "pre-snapshot.sh: hook command failed for '$name': ${hook_out:-no output}" >&2
    exit 1
fi

write_status "success" ""
echo "pre-snapshot.sh: hook completed for '$name'" >&2
