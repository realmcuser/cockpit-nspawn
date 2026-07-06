# Vendored source-host scripts

`dispatch.sh`, `snapshot-db.sh`, and `restore-after-backup.sh` are byte-identical
copies of the same files in the `nspawn-vault` repo
(`nspawn-vault/source-host/*.sh`), which is the canonical source. They're
duplicated here rather than imported from a sibling checkout so this
publicly-listed repo keeps building standalone for anyone who clones it without
also having `nspawn-vault` on disk.

`BackupDialog.jsx` imports these three files as raw text (see the `.sh: 'text'`
loader in `build.js`) and writes them verbatim to
`/usr/local/lib/nspawn-pull/` on the source host when pull-backup mode is
enabled for a container — it does not reimplement any of their logic in JS.

**If `nspawn-vault/source-host/*.sh` changes, re-sync here by hand:**

```bash
cp /root/nspawn-vault/source-host/{dispatch.sh,snapshot-db.sh,restore-after-backup.sh} \
    /root/nspawn-cockpit/src/pull-backup/
```

`dispatch.sh`'s `NAME_RE` must stay in sync with `nspawn-vault`'s
`web/backend/vault_config.py` `_CONTAINER_NAME_RE` and with
`CONTAINER_NAME_RE` in `../BackupDialog.jsx` — all three are the same trust
boundary from different sides. Currently: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
