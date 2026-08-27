import React, { useState, useEffect } from 'react';
import {
    Alert,
    Button,
    Form,
    FormGroup,
    HelperText,
    HelperTextItem,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    TextArea,
} from '@patternfly/react-core';
import cockpit from 'cockpit';
import { DeviceBindingEditor } from './DeviceBindingEditor.jsx';

const { gettext: _, format } = cockpit;

const NSPAWN_DIR = '/etc/systemd/nspawn';

function parseBindings(text) {
    return (text || '').split('\n')
        .map(l => l.match(/^Bind=(.+)$/))
        .filter(Boolean)
        .map(m => m[1].trim());
}

// Remove a section header if it has no key=value content left before the next
// section (or EOF) — also drops now-orphaned blank lines right before it.
function removeIfEmptySection(lines, sectionHeader) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === sectionHeader) {
            let j = i + 1;
            while (j < lines.length && lines[j].trim() === '') j++;
            if (j >= lines.length || lines[j].startsWith('[')) {
                while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
                continue; // skip the now-empty section header
            }
        }
        out.push(lines[i]);
    }
    return out;
}

function applyBindings(text, bindings) {
    // Remove all existing Bind= and matching DeviceAllow= lines we manage,
    // then drop the [Files]/[Resource] headers if that leaves them empty.
    let lines = (text || '').split('\n');
    lines = lines.filter(l => !/^Bind=/.test(l));
    lines = lines.filter(l => !/^DeviceAllow=\/dev\/\S+ rw$/.test(l));
    lines = removeIfEmptySection(lines, '[Files]');
    lines = removeIfEmptySection(lines, '[Resource]');

    const out = lines;
    if (bindings.length === 0) return out.join('\n');

    // Append fresh [Resource] (DeviceAllow=) and [Files] (Bind=) sections at the end.
    // DeviceAllow= is required — the default DevicePolicy=closed on the
    // systemd-nspawn@.service template denies device access even though
    // Bind= makes the node visible in the container's filesystem.
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    out.push('', '[Resource]');
    bindings.forEach(b => out.push(`DeviceAllow=${b} rw`));
    out.push('', '[Files]');
    bindings.forEach(b => out.push(`Bind=${b}`));
    return out.join('\n');
}

export function NspawnConfigDialog({ machineName, machineState, onClose, onAddNotification }) {
    const [content, setContent]           = useState('');
    const [deviceBindings, setDeviceBindings] = useState([]);
    const [loading, setLoading]           = useState(true);
    const [saving, setSaving]             = useState(false);
    const [error, setError]               = useState(null);

    const filePath = `${NSPAWN_DIR}/${machineName}.nspawn`;

    useEffect(() => {
        cockpit.file(filePath, { superuser: 'try' })
            .read()
            .then(c => {
                const text = c || '';
                setContent(text);
                setDeviceBindings(parseBindings(text));
                setLoading(false);
            })
            .catch(() => {
                setContent('');
                setDeviceBindings([]);
                setLoading(false);
            });
    }, [filePath]);

    const handleBindingsChange = (newBindings) => {
        setDeviceBindings(newBindings);
        setContent(prev => applyBindings(prev, newBindings));
    };

    const handleContentChange = (newText) => {
        setContent(newText);
        setDeviceBindings(parseBindings(newText));
    };

    async function doSave() {
        setSaving(true);
        setError(null);
        try {
            await cockpit.spawn(['mkdir', '-p', NSPAWN_DIR], { superuser: 'require' });
            await cockpit.file(filePath, { superuser: 'require' }).replace(content);
            await cockpit.spawn(['systemctl', 'daemon-reload'], { superuser: 'require' });
            onAddNotification({ type: 'success', title: format(_("Config saved for $0"), machineName) });
            onClose();
        } catch (ex) {
            setError(ex.message || _("Failed to save config"));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal isOpen onClose={onClose} variant="medium">
            <ModalHeader title={format(_("nspawn config: $0"), machineName)} />
            <ModalBody>
                {machineState === 'running' && (
                    <Alert
                        variant="info"
                        isInline
                        title={_("Changes take effect after restart")}
                        style={{ marginBottom: '1rem' }}
                    />
                )}
                <Form>
                    <DeviceBindingEditor
                        bindings={deviceBindings}
                        onChange={handleBindingsChange}
                        isDisabled={loading || saving}
                    />
                    <FormGroup label={filePath}>
                        <TextArea
                            value={content}
                            onChange={(_e, v) => handleContentChange(v)}
                            rows={14}
                            resizeOrientation="vertical"
                            isDisabled={loading || saving}
                            style={{ fontFamily: 'monospace', fontSize: '0.875em' }}
                        />
                        <HelperText>
                            <HelperTextItem>
                                {_("systemd-nspawn configuration. See man systemd.nspawn for all options.")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>
                </Form>
                {error && (
                    <Alert variant="danger" isInline title={error} style={{ marginTop: '1rem' }} />
                )}
            </ModalBody>
            <ModalFooter>
                <Button
                    variant="primary"
                    onClick={doSave}
                    isDisabled={loading || saving}
                    isLoading={saving}
                >
                    {saving ? _("Saving…") : _("Save")}
                </Button>
                <Button variant="link" onClick={onClose} isDisabled={saving}>
                    {_("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
}
