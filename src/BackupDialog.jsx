import React, { useState, useEffect, useRef } from 'react';
import {
    Alert,
    Button,
    Checkbox,
    Divider,
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

// Python3 GFS retention script sent to remote via SSH heredoc (python3 -).
// No $ signs → safe inside JS template literals without escaping.
// Mode 'incremental': prunes YYYYMMDD-HHMMSS snapshot dirs under base.
// Mode 'full': prunes <prefix>YYYYMMDD-HHMMSS.tar.gz files under base.
const GFS_PYTHON = `import sys,os,shutil
from datetime import datetime,timedelta,timezone
base=sys.argv[1];gh=int(sys.argv[2]);gd=int(sys.argv[3])
gw=int(sys.argv[4]);gm=int(sys.argv[5]);gy=int(sys.argv[6])
mode=sys.argv[7] if len(sys.argv)>7 else 'incremental'
pfx=sys.argv[8] if len(sys.argv)>8 else ''
now=datetime.now(timezone.utc);keep={}
if mode=='incremental':
    try:entries=sorted([d for d in os.listdir(base) if d[:1].isdigit()],reverse=True)
    except:entries=[]
    def get_ts(n):return n[:15]
    def get_path(n):return os.path.join(base,n)
    def do_rm(p):shutil.rmtree(p,ignore_errors=True)
else:
    sfx='.tar.gz'
    try:entries=sorted([f for f in os.listdir(base) if f.startswith(pfx) and f.endswith(sfx)],reverse=True)
    except:entries=[]
    def get_ts(n):return n[len(pfx):-len(sfx)]
    def get_path(n):return os.path.join(base,n)
    def do_rm(p):
        try:os.remove(p)
        except:pass
for e in entries:
    try:dt=datetime.strptime(get_ts(e)[:15],'%Y%m%d-%H%M%S').replace(tzinfo=timezone.utc)
    except:continue
    p=get_path(e)
    if gh and dt>=now-timedelta(hours=gh):
        b='H'+dt.strftime('%Y%m%d%H')
        if b not in keep:keep[b]=p
    if gd and dt>=now-timedelta(days=gd):
        b='D'+dt.strftime('%Y%m%d')
        if b not in keep:keep[b]=p
    if gw and dt>=now-timedelta(weeks=gw):
        b='W'+dt.strftime('%G%V')
        if b not in keep:keep[b]=p
    if gm and dt>=now-timedelta(days=gm*30):
        b='M'+dt.strftime('%Y%m')
        if b not in keep:keep[b]=p
    if gy and dt>=now-timedelta(days=gy*365):
        b='Y'+dt.strftime('%Y')
        if b not in keep:keep[b]=p
keepers=set(keep.values())
for e in entries:
    p=get_path(e)
    if p not in keepers:do_rm(p)
`;

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

// Returns the bash variable declarations, send_notification(), and write_status()
// definitions to embed at the top of each generated backup script.
// \${...} in the template → ${...} in bash output (parameter expansion).
function makeNotifyBlock(cfg) {
    const onFail    = cfg.notify_on_failure !== false ? 'true' : 'false';
    const onSuccess = cfg.notify_on_success === true  ? 'true' : 'false';
    return `NOTIFY_ON_FAILURE=${onFail}
NOTIFY_ON_SUCCESS=${onSuccess}
NOTIFY_SMTP_HOST='${shq(cfg.notify_smtp_host || '')}'
NOTIFY_SMTP_USER='${shq(cfg.notify_smtp_user || '')}'
NOTIFY_SMTP_PASS='${shq(cfg.notify_smtp_pass || '')}'
NOTIFY_SMTP_TO='${shq(cfg.notify_smtp_to   || '')}'
NOTIFY_SLACK='${shq(cfg.notify_slack || '')}'
NOTIFY_PUSHOVER_USER='${shq(cfg.notify_pushover_user  || '')}'
NOTIFY_PUSHOVER_TOKEN='${shq(cfg.notify_pushover_token || '')}'

send_notification() {
    local result="$1"
    local msg="\${2:-}"
    [ "$result" = "failed" ]  && [ "$NOTIFY_ON_FAILURE" != true ] && return 0
    [ "$result" = "success" ] && [ "$NOTIFY_ON_SUCCESS" != true ] && return 0
    local subject="Backup $result: $NAME"
    local body
    body="Container: $NAME
Host: $(hostname -s)
Time: $(date -Iseconds)
Result: $result"
    [ -n "$msg" ] && body="$body
Message: $msg"
    if [ -n "$NOTIFY_SMTP_HOST" ] && [ -n "$NOTIFY_SMTP_TO" ]; then
        local curl_auth=()
        [ -n "$NOTIFY_SMTP_USER" ] && curl_auth=(--user "$NOTIFY_SMTP_USER:$NOTIFY_SMTP_PASS")
        curl -s --ssl-reqd "\${curl_auth[@]}" \\
            --url "$NOTIFY_SMTP_HOST" \\
            --mail-from "\${NOTIFY_SMTP_USER:-noreply@localhost}" \\
            --mail-rcpt "$NOTIFY_SMTP_TO" \\
            --upload-file - 2>/dev/null << MAILEOF || true
From: cockpit-nspawn <$NOTIFY_SMTP_USER>
To: $NOTIFY_SMTP_TO
Subject: $subject

$body
MAILEOF
    fi
    if [ -n "$NOTIFY_SLACK" ]; then
        local slack_json
        slack_json=$(printf '%s' "$subject\${msg:+ — $msg}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])' 2>/dev/null || printf '%s' "$subject")
        curl -s -X POST -H 'Content-type: application/json' \\
            --data "{\\"text\\":\\"$slack_json\\"}" \\
            "$NOTIFY_SLACK" >/dev/null 2>&1 || true
    fi
    if [ -n "$NOTIFY_PUSHOVER_USER" ] && [ -n "$NOTIFY_PUSHOVER_TOKEN" ]; then
        curl -s https://api.pushover.net/1/messages.json \\
            -F "token=$NOTIFY_PUSHOVER_TOKEN" \\
            -F "user=$NOTIFY_PUSHOVER_USER" \\
            -F "title=$subject" \\
            -F "message=$body" >/dev/null 2>&1 || true
    fi
}

write_status() {
    printf '{"result":"%s","timestamp":"%s","size_bytes":%s,"message":"%s"}\\n' \\
        "$1" "$(date -Iseconds)" "\${3:-0}" "\${2:-}" > "$STATUS_FILE"
    send_notification "$1" "\${2:-}"
}
`;
}

function makeScript(name, cfg) {
    const ret       = parseInt(cfg.retention, 10);
    const stopDuring = cfg.stop_during_backup ? 'true' : 'false';
    const dbBlock   = mysqldumpBlock(cfg);
    const dbCleanup = cfg.mariadb_backup
        ? `rm -f "/var/lib/machines/$NAME/var/tmp/cockpit-nspawn-db.sql"\n` : '';
    const notifyBlock = makeNotifyBlock(cfg);

    const useGfs = cfg.retention_mode === 'gfs';
    const gh = parseInt(cfg.gfs_hourly,  10) || 0;
    const gd = parseInt(cfg.gfs_daily,   10) || 0;
    const gw = parseInt(cfg.gfs_weekly,  10) || 0;
    const gm = parseInt(cfg.gfs_monthly, 10) || 0;
    const gy = parseInt(cfg.gfs_yearly,  10) || 0;

    if (cfg.backup_type === 'incremental') {
        const retentionCmd = useGfs
            ? `ssh -i "$KEY" "$RUSER@$HOST" python3 - "$REMOTE_BASE" ${gh} ${gd} ${gw} ${gm} ${gy} incremental 2>/dev/null << 'PYEOF' || true
${GFS_PYTHON}PYEOF`
            : `if [ "$RETENTION" -gt 0 ]; then
    ssh -i "$KEY" "$RUSER@$HOST" \\
        "ls -1d '$REMOTE_BASE'/[0-9]* 2>/dev/null | sort -r | tail -n +\$((RETENTION+1)) | xargs -r rm -rf" || true
fi`;

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

${notifyBlock}
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

${retentionCmd}

write_status "success"
`;
    }

    // Full (tar.gz) backup
    const retentionCmd = useGfs
        ? `ssh -i "$KEY" "$RUSER@$HOST" python3 - "$RPATH" ${gh} ${gd} ${gw} ${gm} ${gy} full '${shq(name)}-' 2>/dev/null << 'PYEOF' || true
${GFS_PYTHON}PYEOF`
        : `if [ "$RETENTION" -gt 0 ]; then
    ssh -i "$KEY" "$RUSER@$HOST" \\
        "cd '$RPATH' && ls -1 ${name}-*.tar.gz 2>/dev/null | sort -r | tail -n +\$((RETENTION+1)) | xargs -r rm -f" || true
fi`;

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

${notifyBlock}
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

${retentionCmd}

write_status "success" "" "$SIZE"
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

const GFS_TIERS = [
    { key: 'gfs_hourly',  label: 'Hourly',  hint: 'hours',  max: 168 },
    { key: 'gfs_daily',   label: 'Daily',   hint: 'days',   max: 31  },
    { key: 'gfs_weekly',  label: 'Weekly',  hint: 'weeks',  max: 52  },
    { key: 'gfs_monthly', label: 'Monthly', hint: 'months', max: 60  },
    { key: 'gfs_yearly',  label: 'Yearly',  hint: 'years',  max: 10  },
];

export function BackupDialog({ machineName, onClose, onAddNotification }) {
    const [host, setHost]                         = useState('');
    const [user, setUser]                         = useState('root');
    const [remotePath, setRemotePath]             = useState('/backups');
    const [keyPath, setKeyPath]                   = useState('/root/.ssh/id_rsa');
    const [scheduleFreq, setScheduleFreq]         = useState('daily');
    const [scheduleTime, setScheduleTime]         = useState('02:00');
    const [retentionMode, setRetentionMode]       = useState('simple');
    const [retention, setRetention]               = useState(3);
    const [gfs, setGfs]                           = useState({ gfs_hourly: 24, gfs_daily: 7, gfs_weekly: 4, gfs_monthly: 12, gfs_yearly: 3 });
    const [stopDuring, setStopDuring]             = useState(true);
    const [backupType, setBackupType]             = useState('full');
    const [mariadbBackup, setMariadbBackup]       = useState(false);
    const [mariadbPassword, setMariadbPassword]   = useState('');
    const [notifyOnFailure, setNotifyOnFailure]   = useState(true);
    const [notifyOnSuccess, setNotifyOnSuccess]   = useState(false);
    const [notifySmtpHost, setNotifySmtpHost]     = useState('');
    const [notifySmtpUser, setNotifySmtpUser]     = useState('');
    const [notifySmtpPass, setNotifySmtpPass]     = useState('');
    const [notifySmtpTo, setNotifySmtpTo]         = useState('');
    const [notifySlack, setNotifySlack]           = useState('');
    const [notifyPushoverUser, setNotifyPushoverUser]   = useState('');
    const [notifyPushoverToken, setNotifyPushoverToken] = useState('');
    const [status, setStatus]       = useState(null);
    const [hasConfig, setHasConfig] = useState(false);
    const [saving, setSaving]       = useState(false);
    const [testing, setTesting]     = useState(false);
    const [backingUp, setBackingUp] = useState(false);
    const [error, setError]         = useState(null);
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
                    setScheduleFreq(cfg.schedule_freq || 'daily');
                    setScheduleTime(cfg.schedule_time || cfg.schedule || '02:00');
                    setRetentionMode(cfg.retention_mode || 'simple');
                    setRetention(cfg.retention ?? 3);
                    setGfs({
                        gfs_hourly:  cfg.gfs_hourly  ?? 24,
                        gfs_daily:   cfg.gfs_daily   ?? 7,
                        gfs_weekly:  cfg.gfs_weekly  ?? 4,
                        gfs_monthly: cfg.gfs_monthly ?? 12,
                        gfs_yearly:  cfg.gfs_yearly  ?? 3,
                    });
                    setStopDuring(cfg.stop_during_backup || false);
                    setBackupType(cfg.backup_type || 'full');
                    setMariadbBackup(cfg.mariadb_backup || false);
                    setMariadbPassword(cfg.mariadb_password || '');
                    setNotifyOnFailure(cfg.notify_on_failure !== false);
                    setNotifyOnSuccess(cfg.notify_on_success === true);
                    setNotifySmtpHost(cfg.notify_smtp_host || '');
                    setNotifySmtpUser(cfg.notify_smtp_user || '');
                    setNotifySmtpPass(cfg.notify_smtp_pass || '');
                    setNotifySmtpTo(cfg.notify_smtp_to || '');
                    setNotifySlack(cfg.notify_slack || '');
                    setNotifyPushoverUser(cfg.notify_pushover_user || '');
                    setNotifyPushoverToken(cfg.notify_pushover_token || '');
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
            retention_mode: retentionMode,
            retention,
            ...gfs,
            stop_during_backup: stopDuring,
            backup_type: backupType,
            mariadb_backup: mariadbBackup,
            mariadb_password: mariadbBackup ? mariadbPassword : '',
            notify_on_failure: notifyOnFailure,
            notify_on_success: notifyOnSuccess,
            notify_smtp_host: notifySmtpHost.trim(),
            notify_smtp_user: notifySmtpUser.trim(),
            notify_smtp_pass: notifySmtpPass,
            notify_smtp_to: notifySmtpTo.trim(),
            notify_slack: notifySlack.trim(),
            notify_pushover_user: notifyPushoverUser.trim(),
            notify_pushover_token: notifyPushoverToken.trim(),
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

    function setGfsTier(key, val) {
        setGfs(prev => ({ ...prev, [key]: val }));
    }

    const hasNotify = notifySmtpHost.trim() || notifySlack.trim() || notifyPushoverUser.trim();

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
                        <Radio
                            id="retention-simple"
                            name="retention-mode"
                            label={_("Simple — keep a fixed number of copies")}
                            isChecked={retentionMode === 'simple'}
                            onChange={() => setRetentionMode('simple')}
                        />
                        {retentionMode === 'simple' && (
                            <div style={{ marginLeft: '1.75rem', marginTop: '0.5rem' }}>
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
                            </div>
                        )}
                        <Radio
                            id="retention-gfs"
                            name="retention-mode"
                            label={_("GFS — Grandfather-Father-Son tiers")}
                            isChecked={retentionMode === 'gfs'}
                            onChange={() => setRetentionMode('gfs')}
                            style={{ marginTop: '0.5rem' }}
                        />
                        {retentionMode === 'gfs' && (
                            <div style={{ marginLeft: '1.75rem', marginTop: '0.5rem', display: 'grid', gridTemplateColumns: 'repeat(3, max-content)', gap: '0.5rem 2rem', alignItems: 'center' }}>
                                {GFS_TIERS.map(({ key, label, hint, max }) => (
                                    <React.Fragment key={key}>
                                        <span style={{ fontWeight: 500 }}>{_(label)}</span>
                                        <NumberInput
                                            value={gfs[key]}
                                            min={0}
                                            max={max}
                                            onMinus={() => setGfsTier(key, Math.max(0, gfs[key] - 1))}
                                            onPlus={() => setGfsTier(key, Math.min(max, gfs[key] + 1))}
                                            onChange={e => setGfsTier(key, Math.max(0, parseInt(e.target.value, 10) || 0))}
                                        />
                                        <span style={{ color: 'var(--pf-v5-global--Color--200)', fontSize: '0.875rem' }}>{hint}</span>
                                    </React.Fragment>
                                ))}
                                <HelperText style={{ gridColumn: '1 / -1' }}>
                                    <HelperTextItem>{_("Set a tier to 0 to disable it. Requires python3 on the backup server.")}</HelperTextItem>
                                </HelperText>
                            </div>
                        )}
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

                    <Divider style={{ gridColumn: '1 / -1', marginTop: '0.5rem' }} />

                    <FormGroup label={_("Notify on")}>
                        <Checkbox
                            id="notify-on-failure"
                            label={_("Failure")}
                            isChecked={notifyOnFailure}
                            onChange={(_e, v) => setNotifyOnFailure(v)}
                        />
                        <Checkbox
                            id="notify-on-success"
                            label={_("Success")}
                            isChecked={notifyOnSuccess}
                            onChange={(_e, v) => setNotifyOnSuccess(v)}
                            style={{ marginTop: '0.25rem' }}
                        />
                        {!hasNotify && (
                            <HelperText>
                                <HelperTextItem>{_("Configure at least one channel below to enable notifications")}</HelperTextItem>
                            </HelperText>
                        )}
                    </FormGroup>

                    <FormGroup label={_("Email (SMTP)")}>
                        <TextInput
                            value={notifySmtpHost}
                            onChange={(_e, v) => setNotifySmtpHost(v)}
                            placeholder="smtp://smtp.example.com:587 or smtps://smtp.gmail.com:465"
                        />
                        <TextInput
                            value={notifySmtpUser}
                            onChange={(_e, v) => setNotifySmtpUser(v)}
                            placeholder={_("SMTP username (e.g. user@gmail.com)")}
                            style={{ marginTop: '0.5rem' }}
                        />
                        <TextInput
                            type="password"
                            value={notifySmtpPass}
                            onChange={(_e, v) => setNotifySmtpPass(v)}
                            placeholder={_("SMTP password")}
                            style={{ marginTop: '0.5rem' }}
                        />
                        <TextInput
                            value={notifySmtpTo}
                            onChange={(_e, v) => setNotifySmtpTo(v)}
                            placeholder={_("Recipient address")}
                            style={{ marginTop: '0.5rem' }}
                        />
                        <HelperText>
                            <HelperTextItem>{_("Leave all four fields blank to disable email. Uses curl with STARTTLS/SSL — no local MTA required.")}</HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    <FormGroup label={_("Slack webhook URL")}>
                        <TextInput
                            value={notifySlack}
                            onChange={(_e, v) => setNotifySlack(v)}
                            placeholder="https://hooks.slack.com/services/T.../B..."
                        />
                        <HelperText>
                            <HelperTextItem>{_("Leave blank to disable. Create at api.slack.com/apps → Incoming Webhooks.")}</HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    <FormGroup label={_("Pushover")}>
                        <TextInput
                            value={notifyPushoverUser}
                            onChange={(_e, v) => setNotifyPushoverUser(v)}
                            placeholder={_("User key")}
                        />
                        <TextInput
                            value={notifyPushoverToken}
                            onChange={(_e, v) => setNotifyPushoverToken(v)}
                            placeholder={_("App token")}
                            style={{ marginTop: '0.5rem' }}
                        />
                        <HelperText>
                            <HelperTextItem>{_("Leave both blank to disable. Create an app at pushover.net to get an app token.")}</HelperTextItem>
                        </HelperText>
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
