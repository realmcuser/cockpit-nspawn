import React, { useState, useEffect, useRef } from 'react';
import {
    Alert,
    Button,
    Checkbox,
    Form,
    FormGroup,
    FormSelect,
    FormSelectOption,
    HelperText,
    HelperTextItem,
    Modal,
    ModalBody,
    ModalHeader,
    ModalFooter,
    NumberInput,
    Radio,
    TextInput,
} from '@patternfly/react-core';
import cockpit from 'cockpit';

const { gettext: _, format } = cockpit;

const CONFIG_DIR = '/etc/cockpit-nspawn/backup';
const STATUS_DIR = '/etc/cockpit-nspawn/backup-status';
const SYSTEMD_DIR = '/etc/systemd/system';

function formatTs(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '';
    const gb = bytes / (1024 ** 3);
    if (gb >= 0.1) return ` · ${gb.toFixed(1)} GB`;
    return ` · ${Math.round(bytes / (1024 ** 2))} MB`;
}

function shq(s) {
    return String(s).replace(/'/g, "'\\''");
}

// Shared mysqldump block inserted before rsync/tar in both script variants.
// Writes a temp credentials file into the container filesystem (never on argv),
// runs mysqldump inside the running container, then removes credentials.
// Must run BEFORE stop_during_backup so the container is still up.
function mysqldumpBlock(cfg) {
    if (!cfg.mariadb_backup) return '';
    const pw = shq(cfg.mariadb_password || '');
    return `
DB_DUMP="/var/lib/machines/$NAME/var/tmp/cockpit-nspawn-db.sql"
DB_MYCNF="/var/lib/machines/$NAME/root/.cockpit-nspawn-mycnf"

if machinectl show "$NAME" --property=State 2>/dev/null | grep -q "running"; then
    printf '[client]\\npassword=%s\\n' '${pw}' > "$DB_MYCNF"
    chmod 600 "$DB_MYCNF"
    if ! systemd-run --machine="$NAME" --wait -- \\
            bash -c 'mysqldump --defaults-extra-file=/root/.cockpit-nspawn-mycnf --single-transaction --all-databases > /var/tmp/cockpit-nspawn-db.sql 2>/dev/null'; then
        rm -f "$DB_MYCNF"
        write_status "failed" "mysqldump failed — is MariaDB running and password correct?"
        exit 1
    fi
    rm -f "$DB_MYCNF"
else
    write_status "failed" "MariaDB backup enabled but container is not running"
    exit 1
fi
`;
}

function makeScript(name, cfg) {
    const ret = parseInt(cfg.retention, 10);
    const stopDuring = cfg.stop_during_backup ? 'true' : 'false';
    const dbBlock = mysqldumpBlock(cfg);
    const dbCleanup = cfg.mariadb_backup
        ? `rm -f "/var/lib/machines/$NAME/var/tmp/cockpit-nspawn-db.sql"\n` : '';

    if (cfg.backup_type === 'incremental') {
        return `#!/bin/bash
set -euo pipefail
NAME='${shq(name)}'
HOST='${shq(cfg.host)}'
RUSER='${shq(cfg.user)}'
RPATH='${shq(cfg.path)}'
KEY='${shq(cfg.key)}'
RETENTION=${ret}
STOP_DURING_BACKUP=${stopDuring}

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
STATUS_FILE='${STATUS_DIR}/${name}.json'
ERR_FILE="/var/tmp/nspawn-backup-err-${name}"
WAS_RUNNING=false
REMOTE_BASE="$RPATH/$NAME"
REMOTE_DEST="$REMOTE_BASE/$TIMESTAMP"
REMOTE_LATEST="$REMOTE_BASE/latest"

cleanup() { rm -f "$ERR_FILE"; }
trap cleanup EXIT

mkdir -p '${STATUS_DIR}'

write_status() {
    printf '{"result":"%s","timestamp":"%s","size_bytes":0,"message":"%s"}\\n' \\
        "$1" "$(date -Iseconds)" "\${2:-}" > "$STATUS_FILE"
}
${dbBlock}
if [ "$STOP_DURING_BACKUP" = true ] && machinectl show "$NAME" --property=State 2>/dev/null | grep -q "running"; then
    WAS_RUNNING=true
    machinectl poweroff "$NAME" 2>/dev/null || machinectl terminate "$NAME" 2>/dev/null || true
    for _ in $(seq 1 30); do
        machinectl show "$NAME" --property=State 2>/dev/null | grep -q "running" || break
        sleep 1
    done
fi

if ! ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \\
        "$RUSER@$HOST" "mkdir -p '$REMOTE_DEST'" 2>"$ERR_FILE"; then
    write_status "failed" "$(head -1 "$ERR_FILE" | tr '"' "'")"
    [ "$WAS_RUNNING" = true ] && machinectl start "$NAME" || true
    exit 1
fi

LINK_DEST_ARG=""
if ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \\
        "$RUSER@$HOST" "test -e '$REMOTE_LATEST'" 2>/dev/null; then
    LINK_DEST_ARG="--link-dest=$REMOTE_LATEST/"
fi

if ! rsync -az --delete $LINK_DEST_ARG \\
        -e "ssh -i \\"$KEY\\" -o StrictHostKeyChecking=accept-new -o BatchMode=yes" \\
        "/var/lib/machines/$NAME/" \\
        "$RUSER@$HOST:$REMOTE_DEST/" 2>"$ERR_FILE"; then
    write_status "failed" "$(head -1 "$ERR_FILE" | tr '"' "'")"
    [ "$WAS_RUNNING" = true ] && machinectl start "$NAME" || true
    exit 1
fi

[ "$WAS_RUNNING" = true ] && machinectl start "$NAME" || true
${dbCleanup}
ssh -i "$KEY" "$RUSER@$HOST" "ln -sfn '$REMOTE_DEST' '$REMOTE_LATEST'" || true

if [ "$RETENTION" -gt 0 ]; then
    ssh -i "$KEY" "$RUSER@$HOST" \\
        "ls -1d '$REMOTE_BASE'/[0-9]* 2>/dev/null | sort -r | tail -n +\$((RETENTION+1)) | xargs -r rm -rf" || true
fi

printf '{"result":"success","timestamp":"%s","size_bytes":0,"message":""}\\n' \\
    "$(date -Iseconds)" > "$STATUS_FILE"
`;
    }

    return `#!/bin/bash
set -euo pipefail
NAME='${shq(name)}'
HOST='${shq(cfg.host)}'
RUSER='${shq(cfg.user)}'
RPATH='${shq(cfg.path)}'
KEY='${shq(cfg.key)}'
RETENTION=${ret}
STOP_DURING_BACKUP=${stopDuring}

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TMPFILE="/var/tmp/nspawn-backup-${name}-$TIMESTAMP.tar.gz"
STATUS_FILE='${STATUS_DIR}/${name}.json'
ERR_FILE="/var/tmp/nspawn-backup-err-${name}"
WAS_RUNNING=false

cleanup() { rm -f "$TMPFILE" "$ERR_FILE"; }
trap cleanup EXIT

mkdir -p '${STATUS_DIR}'

write_status() {
    printf '{"result":"%s","timestamp":"%s","size_bytes":0,"message":"%s"}\\n' \\
        "$1" "$(date -Iseconds)" "\${2:-}" > "$STATUS_FILE"
}
${dbBlock}
if [ "$STOP_DURING_BACKUP" = true ] && machinectl show "$NAME" --property=State 2>/dev/null | grep -q "running"; then
    WAS_RUNNING=true
    machinectl poweroff "$NAME" 2>/dev/null || machinectl terminate "$NAME" 2>/dev/null || true
    for _ in $(seq 1 30); do
        machinectl show "$NAME" --property=State 2>/dev/null | grep -q "running" || break
        sleep 1
    done
fi

if ! tar -czf "$TMPFILE" -C /var/lib/machines "$NAME" 2>"$ERR_FILE"; then
    write_status "failed" "$(head -1 "$ERR_FILE" | tr '"' "'")"
    [ "$WAS_RUNNING" = true ] && machinectl start "$NAME" || true
    exit 1
fi

SIZE=$(stat -c%s "$TMPFILE")

[ "$WAS_RUNNING" = true ] && machinectl start "$NAME" || true
${dbCleanup}
if ! ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \\
        "$RUSER@$HOST" "mkdir -p '$RPATH'" 2>"$ERR_FILE"; then
    write_status "failed" "$(head -1 "$ERR_FILE" | tr '"' "'")"
    exit 1
fi

DEST="$RPATH/${name}-$TIMESTAMP.tar.gz"
if ! scp -i "$KEY" -o StrictHostKeyChecking=accept-new \\
        "$TMPFILE" "$RUSER@$HOST:$DEST" 2>"$ERR_FILE"; then
    write_status "failed" "$(head -1 "$ERR_FILE" | tr '"' "'")"
    exit 1
fi

if [ "$RETENTION" -gt 0 ]; then
    ssh -i "$KEY" "$RUSER@$HOST" \\
        "cd '$RPATH' && ls -1t ${name}-*.tar.gz 2>/dev/null | tail -n +\$((RETENTION+1)) | xargs -r rm -f" || true
fi

printf '{"result":"success","timestamp":"%s","size_bytes":%d,"message":""}\\n' \\
    "$(date -Iseconds)" "$SIZE" > "$STATUS_FILE"
`;
}

const SCHEDULE_OPTIONS = [
    { value: '1h',    label: 'Every hour' },
    { value: '2h',    label: 'Every 2 hours' },
    { value: '4h',    label: 'Every 4 hours' },
    { value: '6h',    label: 'Every 6 hours' },
    { value: '12h',   label: 'Every 12 hours' },
    { value: 'daily', label: 'Once per day' },
];

function buildOnCalendar(freq, time) {
    switch (freq) {
    case '1h':  return 'hourly';
    case '2h':  return '*-*-* 00/2:00:00';
    case '4h':  return '*-*-* 00/4:00:00';
    case '6h':  return '*-*-* 00/6:00:00';
    case '12h': return '*-*-* 00/12:00:00';
    default:    return `*-*-* ${time}:00`;
    }
}

export function BackupDialog({ machineName, onClose, onAddNotification }) {
    const [host, setHost] = useState('');
    const [user, setUser] = useState('root');
    const [remotePath, setRemotePath] = useState('/backups');
    const [keyPath, setKeyPath] = useState('/root/.ssh/id_rsa');
    const [scheduleFreq, setScheduleFreq] = useState('daily');
    const [scheduleTime, setScheduleTime] = useState('02:00');
    const [retention, setRetention] = useState(3);
    const [stopDuring, setStopDuring] = useState(true);
    const [backupType, setBackupType] = useState('full');
    const [mariadbBackup, setMariadbBackup] = useState(false);
    const [mariadbPassword, setMariadbPassword] = useState('');
    const [status, setStatus] = useState(null);
    const [hasConfig, setHasConfig] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [backingUp, setBackingUp] = useState(false);
    const [error, setError] = useState(null);
    const [testResult, setTestResult] = useState(null);
    const pollRef = useRef(null);

    useEffect(() => {
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }, []);

    useEffect(() => {
        cockpit.file(`${CONFIG_DIR}/${machineName}.json`, { superuser: 'try' })
            .read()
            .then(content => {
                if (!content) return;
                try {
                    const cfg = JSON.parse(content);
                    setHost(cfg.host || '');
                    setUser(cfg.user || 'root');
                    setRemotePath(cfg.path || '/backups');
                    setKeyPath(cfg.key || '/root/.ssh/id_rsa');
                    setScheduleFreq(cfg.schedule_freq || (cfg.schedule ? 'daily' : 'daily'));
                    setScheduleTime(cfg.schedule_time || cfg.schedule || '02:00');
                    setRetention(cfg.retention ?? 3);
                    setStopDuring(cfg.stop_during_backup || false);
                    setBackupType(cfg.backup_type || 'full');
                    setMariadbBackup(cfg.mariadb_backup || false);
                    setMariadbPassword(cfg.mariadb_password || '');
                    setHasConfig(true);
                } catch (_e) {}
            })
            .catch(() => {});

        cockpit.file(`${STATUS_DIR}/${machineName}.json`, { superuser: 'try' })
            .read()
            .then(content => {
                if (!content) return;
                try { setStatus(JSON.parse(content)); } catch (_e) {}
            })
            .catch(() => {});
    }, [machineName]);

    async function doSave() {
        if (!host.trim()) { setError(_("Host is required")); return; }
        if (scheduleFreq === 'daily' && !/^\d{1,2}:\d{2}$/.test(scheduleTime.trim())) {
            setError(_("Time must be in HH:MM format (e.g. 02:00)"));
            return;
        }
        setSaving(true);
        setError(null);
        const onCalendar = buildOnCalendar(scheduleFreq, scheduleTime.trim());
        const cfg = {
            host: host.trim(),
            user: user.trim() || 'root',
            path: remotePath.trim() || '/backups',
            key: keyPath.trim(),
            schedule_freq: scheduleFreq,
            schedule_time: scheduleTime.trim(),
            retention,
            stop_during_backup: stopDuring,
            backup_type: backupType,
            mariadb_backup: mariadbBackup,
            mariadb_password: mariadbBackup ? mariadbPassword : '',
        };
        const scriptPath = `${CONFIG_DIR}/${machineName}.sh`;
        const serviceName = `cockpit-nspawn-backup-${machineName}`;
        try {
            await cockpit.spawn(['mkdir', '-p', CONFIG_DIR], { superuser: 'require' });
            await cockpit.file(`${CONFIG_DIR}/${machineName}.json`, { superuser: 'require' })
                .replace(JSON.stringify(cfg, null, 2) + '\n');
            await cockpit.file(scriptPath, { superuser: 'require' })
                .replace(makeScript(machineName, cfg));
            await cockpit.spawn(['chmod', '+x', scriptPath], { superuser: 'require' });
            await cockpit.file(`${SYSTEMD_DIR}/${serviceName}.service`, { superuser: 'require' })
                .replace(`[Unit]\nDescription=Backup nspawn container ${machineName}\n\n[Service]\nType=oneshot\nExecStart=${scriptPath}\n`);
            await cockpit.file(`${SYSTEMD_DIR}/${serviceName}.timer`, { superuser: 'require' })
                .replace(`[Unit]\nDescription=Scheduled backup of nspawn container ${machineName}\n\n[Timer]\nOnCalendar=${onCalendar}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
            await cockpit.spawn(['systemctl', 'daemon-reload'], { superuser: 'require' });
            await cockpit.spawn(['systemctl', 'enable', '--now', `${serviceName}.timer`], { superuser: 'require' });
            setHasConfig(true);
            onAddNotification({ type: 'success', title: format(_("Backup configured for $0"), machineName) });
            onClose();
        } catch (ex) {
            setError(ex.message || _("Failed to configure backup"));
        } finally {
            setSaving(false);
        }
    }

    async function doDisable() {
        const serviceName = `cockpit-nspawn-backup-${machineName}`;
        try {
            await cockpit.spawn(
                ['systemctl', 'disable', '--now', `${serviceName}.timer`],
                { superuser: 'require', err: 'ignore' }
            );
            await cockpit.spawn(
                ['rm', '-f',
                    `${SYSTEMD_DIR}/${serviceName}.service`,
                    `${SYSTEMD_DIR}/${serviceName}.timer`,
                    `${CONFIG_DIR}/${machineName}.json`,
                    `${CONFIG_DIR}/${machineName}.sh`,
                ],
                { superuser: 'require', err: 'ignore' }
            );
            await cockpit.spawn(['systemctl', 'daemon-reload'], { superuser: 'require' });
            onAddNotification({ type: 'success', title: format(_("Backup disabled for $0"), machineName) });
            onClose();
        } catch (ex) {
            setError(ex.message || _("Failed to disable backup"));
        }
    }

    async function doBackupNow() {
        setBackingUp(true);
        setError(null);
        const serviceName = `cockpit-nspawn-backup-${machineName}.service`;
        try {
            await cockpit.spawn(
                ['systemctl', 'start', '--no-block', serviceName],
                { superuser: 'require' }
            );
            pollRef.current = setInterval(() => {
                cockpit.spawn(
                    ['systemctl', 'show', '--property=ActiveState', serviceName],
                    { superuser: 'try', err: 'ignore' }
                ).then(output => {
                    const state = output.trim().replace('ActiveState=', '');
                    if (state === 'inactive' || state === 'failed') {
                        clearInterval(pollRef.current);
                        pollRef.current = null;
                        setBackingUp(false);
                        cockpit.file(`${STATUS_DIR}/${machineName}.json`, { superuser: 'try' }).read()
                            .then(content => {
                                if (!content) return;
                                try { setStatus(JSON.parse(content)); } catch (_e) {}
                            })
                            .catch(() => {});
                    }
                }).catch(() => {
                    clearInterval(pollRef.current);
                    pollRef.current = null;
                    setBackingUp(false);
                });
            }, 2000);
        } catch (ex) {
            setError(ex.message || _("Failed to start backup"));
            setBackingUp(false);
        }
    }

    async function doTest() {
        setTesting(true);
        setTestResult(null);
        setError(null);
        try {
            await cockpit.spawn(
                ['ssh', '-i', keyPath.trim(),
                    '-o', 'StrictHostKeyChecking=accept-new',
                    '-o', 'BatchMode=yes',
                    '-o', 'ConnectTimeout=10',
                    `${user.trim()}@${host.trim()}`, 'true'],
                { superuser: 'require', err: 'message' }
            );
            setTestResult({ ok: true });
        } catch (ex) {
            setTestResult({ ok: false, message: ex.message });
        } finally {
            setTesting(false);
        }
    }

    return (
        <Modal isOpen onClose={onClose} variant="medium">
            <ModalHeader title={format(_("Backup: $0"), machineName)} />
            <ModalBody>
                {status && (
                    <Alert
                        variant={status.result === 'success' ? 'success' : 'warning'}
                        isInline
                        title={status.result === 'success'
                            ? format(_("Last backup: $0$1"), formatTs(status.timestamp), formatSize(status.size_bytes))
                            : format(_("Last backup failed: $0"), formatTs(status.timestamp))}
                        style={{ marginBottom: '1rem' }}
                    >
                        {status.message && <p>{status.message}</p>}
                    </Alert>
                )}

                <Form isHorizontal>
                    <FormGroup label={_("SSH host")} isRequired>
                        <TextInput value={host} onChange={(_e, v) => setHost(v)} placeholder="backup.example.com" />
                    </FormGroup>
                    <FormGroup label={_("SSH user")}>
                        <TextInput value={user} onChange={(_e, v) => setUser(v)} />
                    </FormGroup>
                    <FormGroup label={_("Remote path")}>
                        <TextInput value={remotePath} onChange={(_e, v) => setRemotePath(v)} placeholder="/backups" />
                        <HelperText>
                            <HelperTextItem>
                                {backupType === 'incremental'
                                    ? _("Incremental snapshots are stored as NAME/YYYYMMDD-HHMMSS/ directories under this path")
                                    : _("Backups are stored as NAME-YYYYMMDD-HHMMSS.tar.gz in this directory")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>
                    <FormGroup label={_("SSH private key")}>
                        <TextInput value={keyPath} onChange={(_e, v) => setKeyPath(v)} placeholder="/root/.ssh/id_rsa" />
                        <HelperText>
                            <HelperTextItem>{_("Key must be pre-authorized on the remote host (ssh-copy-id)")}</HelperTextItem>
                        </HelperText>
                    </FormGroup>
                    <FormGroup label={_("Schedule")}>
                        <FormSelect
                            value={scheduleFreq}
                            onChange={(_e, v) => setScheduleFreq(v)}
                            style={{ maxWidth: '16rem' }}
                        >
                            {SCHEDULE_OPTIONS.map(o => (
                                <FormSelectOption key={o.value} value={o.value} label={_(o.label)} />
                            ))}
                        </FormSelect>
                        {scheduleFreq === 'daily' && (
                            <TextInput
                                value={scheduleTime}
                                onChange={(_e, v) => setScheduleTime(v)}
                                placeholder="02:00"
                                style={{ maxWidth: '8rem', marginTop: '0.5rem' }}
                            />
                        )}
                        <HelperText>
                            <HelperTextItem>
                                {scheduleFreq === 'daily'
                                    ? _("Time in 24-hour format (HH:MM)")
                                    : _("Incremental backup recommended for sub-daily schedules")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>
                    <FormGroup label={_("Retention")}>
                        <NumberInput
                            value={retention}
                            min={1}
                            max={30}
                            onMinus={() => setRetention(v => Math.max(1, v - 1))}
                            onPlus={() => setRetention(v => Math.min(30, v + 1))}
                            onChange={e => setRetention(Math.max(1, parseInt(e.target.value, 10) || 1))}
                        />
                        <HelperText>
                            <HelperTextItem>{_("Number of backup copies to keep on remote")}</HelperTextItem>
                        </HelperText>
                    </FormGroup>
                    <FormGroup label={_("Backup type")}>
                        <Radio
                            id="backup-type-full"
                            name="backup-type"
                            label={_("Full backup")}
                            description={_("Creates a tar.gz archive, transferred via SCP")}
                            isChecked={backupType === 'full'}
                            onChange={() => setBackupType('full')}
                        />
                        <Radio
                            id="backup-type-incremental"
                            name="backup-type"
                            label={_("Incremental backup")}
                            description={_("rsync snapshot with hardlinks — requires rsync on local and remote host")}
                            isChecked={backupType === 'incremental'}
                            onChange={() => setBackupType('incremental')}
                        />
                    </FormGroup>
                    <FormGroup label={_("Options")}>
                        <Checkbox
                            id="stop-during-backup"
                            label={_("Stop container during backup")}
                            isChecked={stopDuring}
                            onChange={(_e, v) => setStopDuring(v)}
                        />
                        <HelperText>
                            <HelperTextItem>{_("Recommended for containers running databases")}</HelperTextItem>
                        </HelperText>
                    </FormGroup>
                    <FormGroup label={_("MariaDB / MySQL")}>
                        <Checkbox
                            id="mariadb-backup"
                            label={_("Run mysqldump before backup (zero-downtime database backup)")}
                            isChecked={mariadbBackup}
                            onChange={(_e, v) => setMariadbBackup(v)}
                        />
                        {mariadbBackup && (
                            <>
                                <TextInput
                                    id="mariadb-password"
                                    type="password"
                                    value={mariadbPassword}
                                    onChange={(_e, v) => setMariadbPassword(v)}
                                    placeholder={_("MariaDB root password")}
                                    style={{ marginTop: '0.5rem', maxWidth: '20rem' }}
                                />
                                <HelperText>
                                    <HelperTextItem>
                                        {_("Uses mysqldump --single-transaction inside the running container. The dump travels with each snapshot and is restored automatically on restore.")}
                                    </HelperTextItem>
                                </HelperText>
                            </>
                        )}
                    </FormGroup>
                </Form>

                {backingUp && (
                    <Alert variant="info" isInline title={_("Backup in progress…")} style={{ marginTop: '1rem' }}>
                        {_("This may take several minutes for large containers.")}
                    </Alert>
                )}

                {testResult && (
                    <Alert
                        variant={testResult.ok ? 'success' : 'danger'}
                        isInline
                        title={testResult.ok ? _("Connection successful") : _("Connection failed")}
                        style={{ marginTop: '1rem' }}
                    >
                        {testResult.message && <p>{testResult.message}</p>}
                    </Alert>
                )}
                {error && (
                    <Alert variant="danger" isInline title={error} style={{ marginTop: '1rem' }} />
                )}
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={doSave} isDisabled={!host.trim() || saving} isLoading={saving}>
                    {_("Save and enable")}
                </Button>
                {hasConfig && (
                    <Button variant="secondary" onClick={doBackupNow} isDisabled={backingUp} isLoading={backingUp}>
                        {_("Backup now")}
                    </Button>
                )}
                <Button variant="secondary" onClick={doTest} isDisabled={testing || !host.trim()} isLoading={testing}>
                    {_("Test connection")}
                </Button>
                {hasConfig && (
                    <Button variant="link" isDanger onClick={doDisable}>
                        {_("Disable backup")}
                    </Button>
                )}
                <Button variant="link" onClick={onClose}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
}
