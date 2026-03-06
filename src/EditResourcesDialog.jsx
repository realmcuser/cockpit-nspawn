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
    Spinner,
    TextInput,
} from '@patternfly/react-core';

import cockpit from 'cockpit';

const { gettext: _, format } = cockpit;

export function EditResourcesDialog({ machineName, onClose }) {
    const [memoryMax, setMemoryMax] = useState('');
    const [cpuQuota, setCpuQuota] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        cockpit.file(`/etc/systemd/nspawn/${machineName}.nspawn`, { superuser: 'require' }).read()
            .then(content => {
                if (content) {
                    const memMatch = content.match(/^MemoryMax=(.+)$/m);
                    const cpuMatch = content.match(/^CPUQuota=(.+)$/m);
                    if (memMatch) setMemoryMax(memMatch[1].trim());
                    if (cpuMatch) setCpuQuota(cpuMatch[1].trim());
                }
                setLoading(false);
            })
            .catch(err => {
                setError(err.message);
                setLoading(false);
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
            let content = await nspawnFile.read() || '';

            // Remove existing [Resource] section
            content = content.replace(/\n?\[Resource\][^\[]*/s, '');

            // Append new [Resource] section if needed
            if (memoryMax.trim() || cpuQuota.trim()) {
                const lines = ['\n[Resource]'];
                if (memoryMax.trim()) lines.push(`MemoryMax=${memoryMax.trim()}`);
                if (cpuQuota.trim()) lines.push(`CPUQuota=${cpuQuota.trim()}`);
                lines.push('');
                content = content.trimEnd() + lines.join('\n');
            }

            await nspawnFile.replace(content);
            await cockpit.spawn(['systemctl', 'daemon-reload'], { superuser: 'require', err: 'message' });

            onClose(true);
        } catch (err) {
            setError(err.message);
            setSaving(false);
        }
    };

    return (
        <Modal isOpen onClose={() => onClose(false)} variant="small">
            <ModalHeader title={format(_("Resource limits: $0"), machineName)} />
            <ModalBody>
                {error && (
                    <Alert isInline variant="danger" title={_("Error")} style={{ marginBottom: '1rem' }}>
                        {error}
                    </Alert>
                )}

                {loading && <Spinner size="lg" />}

                {!loading && (
                    <>
                        <FormGroup label={_("Memory limit")} fieldId="res-mem"
                            helperText={_("e.g. 2G, 512M — leave empty for unlimited")}
                        >
                            <TextInput
                                id="res-mem"
                                value={memoryMax}
                                onChange={(_ev, val) => setMemoryMax(val)}
                                placeholder={_("unlimited")}
                            />
                        </FormGroup>
                        <FormGroup label={_("CPU quota")} fieldId="res-cpu"
                            helperText={_("e.g. 100% = 1 core, 200% = 2 cores — leave empty for unlimited")}
                            style={{ marginTop: '1rem' }}
                        >
                            <TextInput
                                id="res-cpu"
                                value={cpuQuota}
                                onChange={(_ev, val) => setCpuQuota(val)}
                                placeholder={_("unlimited")}
                            />
                        </FormGroup>
                    </>
                )}
            </ModalBody>
            <ModalFooter>
                <Button
                    variant="primary"
                    onClick={handleSave}
                    isDisabled={loading || saving}
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
