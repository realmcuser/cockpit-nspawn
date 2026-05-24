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

const { gettext: _, format } = cockpit;

const NSPAWN_DIR = '/etc/systemd/nspawn';

export function NspawnConfigDialog({ machineName, machineState, onClose, onAddNotification }) {
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    const filePath = `${NSPAWN_DIR}/${machineName}.nspawn`;

    useEffect(() => {
        cockpit.file(filePath, { superuser: 'try' })
            .read()
            .then(c => {
                setContent(c || '');
                setLoading(false);
            })
            .catch(() => {
                setContent('');
                setLoading(false);
            });
    }, [filePath]);

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
                    <FormGroup label={filePath}>
                        <TextArea
                            value={content}
                            onChange={(_e, v) => setContent(v)}
                            rows={16}
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
