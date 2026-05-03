import React, { useState, useEffect, useRef } from 'react';
import {
    Alert,
    Button,
    Checkbox,
    Form,
    FormGroup,
    HelperText,
    HelperTextItem,
    Modal,
    Spinner,
    ModalBody,
    ModalHeader,
    ModalFooter,
    NumberInput,
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

function makeScript(name, cfg) {
    const ret = parseInt(cfg.retention, 10);
    const stopDuring = cfg.stop_during_backup ? 'true' : 'false';
    return `#!/bin/bash
set -euo pipefail
NAME='${name}'
HOST='${cfg.host}'
RUSER='${cfg.user}'
RPATH='${cfg.path}'
KEY='${cfg.key}'
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

export function BackupDialog({ machineName, onClose, onAddNotification }) {
    const [host, setHost] = useState('');
    const [user, setUser] = useState('root');
    const [remotePath, setRemotePath] = useState('/backups');
    const [keyPath, setKeyPath] = useState('/root/.ssh/id_rsa');
    const [schedule, setSchedule] = useState('02:00');
    const [retention, setRetention] = useState(3);
    const [stopDuring, setStopDuring] = useState(true);
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
                    setSchedule(cfg.schedule || '02:00');
                    setRetention(cfg.retention ?? 3);
                    setStopDuring(cfg.stop_during_backup || false);
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
        if (!/^\d{1,2}:\d{2}$/.test(schedule.trim())) {
            setError(_("Schedule must be in HH:MM format (e.g. 02:00)"));
            return;
        }
        setSaving(true);
        setError(null);
        const cfg = {
            host: host.trim(),
            user: user.trim() || 'root',
            path: remotePath.trim() || '/backups',
            key: keyPath.trim(),
            schedule: schedule.trim(),
            retention,
            stop_during_backup: stopDuring,
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
                .replace(`[Unit]\nDescription=Scheduled backup of nspawn container ${machineName}\n\n[Timer]\nOnCalendar=*-*-* ${cfg.schedule}:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
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
                            <HelperTextItem>{_("Backups are stored as NAME-YYYYMMDD-HHMMSS.tar.gz in this directory")}</HelperTextItem>
                        </HelperText>
                    </FormGroup>
                    <FormGroup label={_("SSH private key")}>
                        <TextInput value={keyPath} onChange={(_e, v) => setKeyPath(v)} placeholder="/root/.ssh/id_rsa" />
                        <HelperText>
                            <HelperTextItem>{_("Key must be pre-authorized on the remote host (ssh-copy-id)")}</HelperTextItem>
                        </HelperText>
                    </FormGroup>
                    <FormGroup label={_("Daily schedule")}>
                        <TextInput value={schedule} onChange={(_e, v) => setSchedule(v)} placeholder="02:00" style={{ maxWidth: '8rem' }} />
                        <HelperText>
                            <HelperTextItem>{_("Time in 24-hour format (HH:MM)")}</HelperTextItem>
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
                </Form>

                {backingUp && (
                    <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <Spinner size="md" />
                        <span>{_("Backup in progress — this may take several minutes for large containers…")}</span>
                    </div>
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
