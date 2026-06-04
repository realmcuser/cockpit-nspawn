import React, { useState } from 'react';
import {
    Alert,
    Button,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
} from '@patternfly/react-core';
import cockpit from 'cockpit';

const { gettext: _ } = cockpit;

const INSTALL_SCRIPT = [
    'set -euo pipefail',
    'echo "Installing cockpit and crypto-policies-scripts..."',
    'dnf install -y cockpit crypto-policies-scripts',
    'echo "Applying crypto policies..."',
    'update-crypto-policies --set DEFAULT',
    'echo "Creating service users..."',
    'groupadd -r cockpit-wsinstance-socket 2>/dev/null || true',
    'useradd -r -g cockpit-wsinstance-socket -s /sbin/nologin cockpit-wsinstance-socket 2>/dev/null || true',
    'mkdir -p /etc/systemd/system/cockpit-wsinstance-socket-user.service.d/',
    "printf '[Service]\\nDynamicUser=no\\n' > /etc/systemd/system/cockpit-wsinstance-socket-user.service.d/no-dynamic.conf",
    'groupadd -r cockpit-session-socket 2>/dev/null || true',
    'useradd -r -g cockpit-session-socket -s /sbin/nologin cockpit-session-socket 2>/dev/null || true',
    'mkdir -p /etc/systemd/system/cockpit-session-socket-user.service.d/',
    "printf '[Service]\\nDynamicUser=no\\n' > /etc/systemd/system/cockpit-session-socket-user.service.d/no-dynamic.conf",
    'systemctl daemon-reload',
    'systemctl enable --now cockpit.socket',
    'echo "Done! Cockpit is available on port 9090."',
].join('\n');

export function InstallCockpitDialog({ machineName, onClose, onAddNotification }) {
    const [output, setOutput] = useState('');
    const [running, setRunning] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState(null);

    function doInstall() {
        setRunning(true);
        setOutput('');
        setError(null);

        const proc = cockpit.spawn(
            ['machinectl', 'shell', machineName, '/bin/bash', '-c', INSTALL_SCRIPT],
            { superuser: 'require', err: 'out' }
        );

        proc.stream(chunk => setOutput(prev => prev + chunk));

        proc.then(() => {
            setDone(true);
            setRunning(false);
            onAddNotification({ type: 'success', title: _("Cockpit installed successfully") });
        }).catch(ex => {
            setError(ex.message || _("Installation failed"));
            setRunning(false);
        });
    }

    return (
        <Modal isOpen onClose={onClose} variant="medium">
            <ModalHeader title={_("Install Cockpit in container")} />
            <ModalBody>
                {!running && !done && !error && (
                    <Alert
                        variant="info"
                        isInline
                        title={_("Installs Cockpit inside the container and applies the required workarounds for running in a systemd-nspawn environment (static service users, crypto policy).")}
                        style={{ marginBottom: '1rem' }}
                    />
                )}
                {(running || output) && (
                    <pre style={{
                        background: '#1e1e1e',
                        color: '#d4d4d4',
                        padding: '0.75rem',
                        borderRadius: '4px',
                        fontSize: '0.8em',
                        maxHeight: '320px',
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        fontFamily: 'monospace',
                    }}>
                        {output || _("Starting…")}
                    </pre>
                )}
                {error && (
                    <Alert variant="danger" isInline title={error} style={{ marginTop: '1rem' }} />
                )}
                {done && (
                    <Alert
                        variant="success"
                        isInline
                        title={_("Cockpit installed. Connect to port 9090 on the container's IP address.")}
                        style={{ marginTop: '1rem' }}
                    />
                )}
            </ModalBody>
            <ModalFooter>
                {!done && (
                    <Button
                        variant="primary"
                        onClick={doInstall}
                        isDisabled={running}
                        isLoading={running}
                    >
                        {running ? _("Installing…") : _("Install")}
                    </Button>
                )}
                <Button variant="link" onClick={onClose} isDisabled={running}>
                    {done ? _("Close") : _("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
}
