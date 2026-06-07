import React, { useState, useEffect } from 'react';
import {
    Alert,
    Button,
    Form,
    FormGroup,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Radio,
    TextInput,
} from '@patternfly/react-core';
import cockpit from 'cockpit';

const { gettext: _, format } = cockpit;

const CONFIG_DIR = '/etc/cockpit-nspawn/backup';

function parseBackupTs(path) {
    const file = path.replace(/^.*\//, '');
    const m = file.match(/-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tar\.gz$/);
    if (!m) return file;
    try {
        return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toLocaleString();
    } catch { return file; }
}

function parseIncrementalTs(path) {
    const dir = path.replace(/^.*\//, '');
    const m = dir.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
    if (!m) return dir;
    try {
        return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toLocaleString();
    } catch { return dir; }
}

export function RestoreDialog({ machineName, machineState, onClose, onAddNotification, onRefresh }) {
    const [host, setHost] = useState('');
    const [user, setUser] = useState('root');
    const [remotePath, setRemotePath] = useState('/backups');
    const [keyPath, setKeyPath] = useState('/root/.ssh/id_rsa');
    const [backupType, setBackupType] = useState('full');
    const [backups, setBackups] = useState(null);
    const [selected, setSelected] = useState('');
    const [listing, setListing] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const [error, setError] = useState(null);

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
                    setBackupType(cfg.backup_type || 'full');
                } catch (_e) {}
            })
            .catch(() => {});
    }, [machineName]);

    async function doList() {
        if (!host.trim()) { setError(_("Host is required")); return; }
        setListing(true);
        setError(null);
        setBackups(null);
        setSelected('');
        const escapedPath = remotePath.trim().replace(/'/g, "'\\''");
        try {
            const listCmd = backupType === 'incremental'
                ? `ls -1dt '${escapedPath}/${machineName}/'[0-9]* 2>/dev/null || true`
                : `ls -1t '${escapedPath}/${machineName}-'*.tar.gz 2>/dev/null || true`;
            const output = await cockpit.spawn(
                ['ssh', '-i', keyPath.trim(),
                    '-o', 'StrictHostKeyChecking=accept-new',
                    '-o', 'BatchMode=yes',
                    '-o', 'ConnectTimeout=10',
                    `${user.trim()}@${host.trim()}`,
                    listCmd],
                { superuser: 'require', err: 'message' }
            );
            const list = output.trim().split('\n').filter(Boolean);
            setBackups(list);
            if (list.length > 0) setSelected(list[0]);
        } catch (ex) {
            setError(ex.message || _("Failed to list backups"));
        } finally {
            setListing(false);
        }
    }

    async function doRestore() {
        if (!selected) return;
        setRestoring(true);
        setError(null);
        const wasRunning = machineState === 'running';

        try {
            if (wasRunning) {
                await cockpit.spawn(
                    ['machinectl', 'poweroff', machineName],
                    { superuser: 'require', err: 'message' }
                );
                for (let i = 0; i < 30; i++) {
                    const out = await cockpit.spawn(
                        ['machinectl', 'show', '--property=State', machineName],
                        { superuser: 'try', err: 'ignore' }
                    ).catch(() => '');
                    if (!out.includes('running')) break;
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            if (backupType === 'incremental') {
                await cockpit.spawn(
                    ['rsync', '-az', '--delete',
                        '-e', `ssh -i ${keyPath.trim()} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
                        `${user.trim()}@${host.trim()}:${selected}/`,
                        `/var/lib/machines/${machineName}/`],
                    { superuser: 'require', err: 'message' }
                );
            } else {
                const localTmp = `/var/tmp/nspawn-restore-${machineName}.tar.gz`;
                const cleanup = () =>
                    cockpit.spawn(['rm', '-f', localTmp], { superuser: 'require', err: 'ignore' }).catch(() => {});
                try {
                    await cockpit.spawn(
                        ['scp', '-i', keyPath.trim(),
                            '-o', 'StrictHostKeyChecking=accept-new',
                            `${user.trim()}@${host.trim()}:${selected}`, localTmp],
                        { superuser: 'require', err: 'message' }
                    );
                    await cockpit.spawn(
                        ['rm', '-rf', `/var/lib/machines/${machineName}`],
                        { superuser: 'require', err: 'message' }
                    );
                    await cockpit.spawn(
                        ['tar', '-xzf', localTmp, '-C', '/var/lib/machines'],
                        { superuser: 'require', err: 'message' }
                    );
                    await cleanup();
                } catch (ex) {
                    await cleanup();
                    throw ex;
                }
            }

            if (wasRunning) {
                await cockpit.spawn(
                    ['machinectl', 'start', machineName],
                    { superuser: 'require', err: 'ignore' }
                );
            }

            onAddNotification({ type: 'success', title: format(_("$0 restored successfully"), machineName) });
            onRefresh();
            onClose();
        } catch (ex) {
            setError(ex.message || _("Restore failed"));
            setRestoring(false);
        }
    }

    return (
        <Modal isOpen onClose={onClose} variant="medium">
            <ModalHeader title={format(_("Restore: $0"), machineName)} />
            <ModalBody>
                {restoring && (
                    <Alert variant="info" isInline title={_("Restore in progress…")} style={{ marginBottom: '1rem' }}>
                        {_("Downloading and extracting backup. This may take several minutes.")}
                    </Alert>
                )}

                <Form isHorizontal>
                    <FormGroup label={_("SSH host")} isRequired>
                        <TextInput value={host} onChange={(_e, v) => setHost(v)} placeholder="backup.example.com" isDisabled={restoring} />
                    </FormGroup>
                    <FormGroup label={_("SSH user")}>
                        <TextInput value={user} onChange={(_e, v) => setUser(v)} isDisabled={restoring} />
                    </FormGroup>
                    <FormGroup label={_("Remote path")}>
                        <TextInput value={remotePath} onChange={(_e, v) => setRemotePath(v)} placeholder="/backups" isDisabled={restoring} />
                    </FormGroup>
                    <FormGroup label={_("SSH private key")}>
                        <TextInput value={keyPath} onChange={(_e, v) => setKeyPath(v)} isDisabled={restoring} />
                    </FormGroup>
                </Form>

                {backups !== null && backups.length === 0 && (
                    <Alert variant="warning" isInline title={_("No backups found on remote host.")} style={{ marginTop: '1rem' }} />
                )}

                {backups !== null && backups.length > 0 && (
                    <>
                        <p style={{ fontWeight: 600, marginTop: '1.5rem', marginBottom: '0.5rem' }}>
                            {_("Available backups")}
                        </p>
                        {backups.map(b => (
                            <Radio
                                key={b}
                                id={b}
                                name="backup-select"
                                label={backupType === 'incremental'
                                    ? `${parseIncrementalTs(b)}  (${b.replace(/^.*\//, '')})`
                                    : `${parseBackupTs(b)}  (${b.replace(/^.*\//, '')})`}
                                value={b}
                                isChecked={selected === b}
                                onChange={() => setSelected(b)}
                                isDisabled={restoring}
                            />
                        ))}
                        {selected && (
                            <Alert
                                variant="warning"
                                isInline
                                title={_("This will replace the container's current filesystem. This action cannot be undone.")}
                                style={{ marginTop: '1rem' }}
                            />
                        )}
                    </>
                )}

                {error && (
                    <Alert variant="danger" isInline title={error} style={{ marginTop: '1rem' }} />
                )}
            </ModalBody>
            <ModalFooter>
                <Button
                    variant="danger"
                    onClick={doRestore}
                    isDisabled={!selected || restoring}
                    isLoading={restoring}
                >
                    {_("Restore")}
                </Button>
                <Button
                    variant="secondary"
                    onClick={doList}
                    isDisabled={!host.trim() || listing || restoring}
                    isLoading={listing}
                >
                    {_("List backups")}
                </Button>
                <Button variant="link" onClick={onClose} isDisabled={restoring}>
                    {_("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
}
