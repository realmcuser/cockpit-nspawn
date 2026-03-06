/* SPDX-License-Identifier: LGPL-2.1-or-later */

import React, { useState, useEffect } from 'react';
import {
    Alert,
    Button,
    FormGroup,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Radio,
    Spinner,
    TextInput,
} from '@patternfly/react-core';

import cockpit from 'cockpit';

const { gettext: _, format } = cockpit;

export function EditNetworkDialog({ machineName, onClose }) {
    const [networkMode, setNetworkMode] = useState(null); // null = loading
    const [bridgeName, setBridgeName] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        cockpit.file(`/etc/systemd/nspawn/${machineName}.nspawn`, { superuser: 'require' }).read()
            .then(content => {
                if (content) {
                    const m = content.match(/^Bridge=(.+)$/m);
                    if (m) {
                        const bridge = m[1].trim();
                        if (bridge === 'br-nspawn') {
                            setNetworkMode('nat');
                            setBridgeName('');
                        } else {
                            setNetworkMode('bridge');
                            setBridgeName(bridge);
                        }
                    } else {
                        setNetworkMode('bridge');
                        setBridgeName('');
                    }
                } else {
                    setNetworkMode('bridge');
                    setBridgeName('');
                }
            })
            .catch(err => {
                setError(err.message);
                setNetworkMode('bridge');
            });
    }, [machineName]);

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            const nspawnFile = cockpit.file(
                `/etc/systemd/nspawn/${machineName}.nspawn`,
                { superuser: 'require' }
            );
            const content = await nspawnFile.read();

            let newBridge;
            if (networkMode === 'nat') {
                newBridge = 'br-nspawn';
                // Ensure NAT bridge exists
                await cockpit.file('/etc/sysctl.d/90-nspawn-nat.conf', { superuser: 'require' })
                    .replace('net.ipv4.ip_forward = 1\n');
                await cockpit.spawn(
                    ['sysctl', '-p', '/etc/sysctl.d/90-nspawn-nat.conf'],
                    { superuser: 'require', err: 'message' }
                );
                let natBridgeExists = false;
                try {
                    await cockpit.spawn(
                        ['nmcli', '-t', 'con', 'show', 'cockpit-nspawn'],
                        { superuser: 'require', err: 'out' }
                    );
                    natBridgeExists = true;
                } catch (checkErr) { /* doesn't exist yet */ }

                if (!natBridgeExists) {
                    await cockpit.spawn(
                        ['nmcli', 'con', 'add', 'type', 'bridge',
                         'con-name', 'cockpit-nspawn', 'ifname', 'br-nspawn'],
                        { superuser: 'require', err: 'message' }
                    );
                    await cockpit.spawn(
                        ['nmcli', 'con', 'modify', 'cockpit-nspawn',
                         'ipv4.method', 'shared',
                         'ipv4.addresses', '10.99.0.1/24',
                         'ipv6.method', 'disabled',
                         'connection.autoconnect', 'yes'],
                        { superuser: 'require', err: 'message' }
                    );
                    await cockpit.spawn(
                        ['nmcli', 'con', 'up', 'cockpit-nspawn'],
                        { superuser: 'require', err: 'message' }
                    );
                }
            } else {
                newBridge = bridgeName.trim();
            }

            // Update Bridge= line in .nspawn file
            let updated;
            if (content && content.match(/^Bridge=.+$/m)) {
                updated = content.replace(/^Bridge=.+$/m, `Bridge=${newBridge}`);
            } else if (content && content.match(/^\[Network\]/m)) {
                updated = content.replace(/^\[Network\]/m, `[Network]\nBridge=${newBridge}`);
            } else {
                updated = (content || '') + `\n[Network]\nBridge=${newBridge}\n`;
            }

            await nspawnFile.replace(updated);
            await cockpit.spawn(['systemctl', 'daemon-reload'], { superuser: 'require', err: 'message' });

            onClose(true);
        } catch (err) {
            setError(err.message);
            setSaving(false);
        }
    };

    const loading = networkMode === null;

    return (
        <Modal isOpen onClose={() => onClose(false)} variant="small">
            <ModalHeader title={format(_("Change network: $0"), machineName)} />
            <ModalBody>
                {error && (
                    <Alert isInline variant="danger" title={_("Error")} style={{ marginBottom: '1rem' }}>
                        {error}
                    </Alert>
                )}

                {loading && <Spinner size="lg" />}

                {!loading && (
                    <FormGroup role="group" isInline fieldId="edit-network" label={_("Network")}>
                        <Radio
                            id="net-nat" name="edit-network" label={_("Private (NAT)")}
                            isChecked={networkMode === 'nat'} onChange={() => setNetworkMode('nat')}
                        />
                        <Radio
                            id="net-bridge" name="edit-network" label={_("Bridge (own LAN IP)")}
                            isChecked={networkMode === 'bridge'} onChange={() => setNetworkMode('bridge')}
                        />
                    </FormGroup>
                )}

                {!loading && networkMode === 'bridge' && (
                    <FormGroup label={_("Bridge name")} fieldId="edit-bridge-name" style={{ marginTop: '1rem' }}>
                        <TextInput
                            id="edit-bridge-name"
                            value={bridgeName}
                            onChange={(_ev, val) => setBridgeName(val)}
                            placeholder="br0"
                        />
                    </FormGroup>
                )}

                {!loading && networkMode === 'nat' && (
                    <Alert isInline variant="info" style={{ marginTop: '1rem' }}
                        title={_("NAT networking via NetworkManager")}
                    >
                        {_("A shared NAT bridge (br-nspawn, 10.99.0.1/24) will be created on the host if it does not already exist.")}
                    </Alert>
                )}

                {!loading && networkMode === 'bridge' && bridgeName && (
                    <Alert isInline variant="info" style={{ marginTop: '1rem' }}
                        title={_("The network bridge must exist on the host")}
                    >
                        {format(_("The bridge $0 must be configured before the container starts."), <strong>{bridgeName}</strong>)}
                    </Alert>
                )}
            </ModalBody>
            <ModalFooter>
                <Button
                    variant="primary"
                    onClick={handleSave}
                    isDisabled={loading || saving || (networkMode === 'bridge' && !bridgeName.trim())}
                    isLoading={saving}
                >
                    {_("Save")}
                </Button>
                <Button variant="link" onClick={() => onClose(false)} isDisabled={saving}>
                    {_("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
}
