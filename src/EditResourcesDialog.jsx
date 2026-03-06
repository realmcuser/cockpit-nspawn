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
    Popover,
    Spinner,
    TextInput,
} from '@patternfly/react-core';
import { HelpIcon } from '@patternfly/react-icons';

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
                        <FormGroup
                            label={_("Memory limit")} fieldId="res-mem"
                            labelHelp={
                                <Popover
                                    headerContent={_("Memory limit")}
                                    bodyContent={
                                        <div>
                                            <p>{_("Maximum RAM the container may use. If the limit is exceeded, processes inside the container are killed by the OOM killer.")}</p>
                                            <br />
                                            <p><strong>{_("Examples:")}</strong></p>
                                            <ul style={{ paddingLeft: '1.2em' }}>
                                                <li><code>512M</code> — 512 megabytes</li>
                                                <li><code>2G</code> — 2 gigabytes</li>
                                                <li><code>4G</code> — 4 gigabytes</li>
                                            </ul>
                                            <br />
                                            <p>{_("Leave empty for no limit.")}</p>
                                        </div>
                                    }
                                >
                                    <button className="pf-v5-c-form__group-label-help" aria-label={_("More info for Memory limit")}>
                                        <HelpIcon />
                                    </button>
                                </Popover>
                            }
                        >
                            <TextInput
                                id="res-mem"
                                value={memoryMax}
                                onChange={(_ev, val) => setMemoryMax(val)}
                                placeholder={_("unlimited")}
                            />
                        </FormGroup>
                        <FormGroup
                            label={_("CPU quota")} fieldId="res-cpu"
                            labelHelp={
                                <Popover
                                    headerContent={_("CPU quota")}
                                    bodyContent={
                                        <div>
                                            <p>{_("Maximum CPU time the container may use. 100% equals one full CPU core.")}</p>
                                            <br />
                                            <p><strong>{_("Examples:")}</strong></p>
                                            <ul style={{ paddingLeft: '1.2em' }}>
                                                <li><code>50%</code> — {_("half a core")}</li>
                                                <li><code>100%</code> — {_("one core")}</li>
                                                <li><code>200%</code> — {_("two cores")}</li>
                                                <li><code>400%</code> — {_("four cores")}</li>
                                            </ul>
                                            <br />
                                            <p>{_("Leave empty for no limit.")}</p>
                                        </div>
                                    }
                                >
                                    <button className="pf-v5-c-form__group-label-help" aria-label={_("More info for CPU quota")}>
                                        <HelpIcon />
                                    </button>
                                </Popover>
                            }
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
