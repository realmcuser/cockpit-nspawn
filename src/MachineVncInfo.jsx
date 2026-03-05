/* SPDX-License-Identifier: LGPL-2.1-or-later */

import React from 'react';
import {
    Alert,
    Button,
    ClipboardCopy,
    DescriptionList,
    DescriptionListDescription,
    DescriptionListGroup,
    DescriptionListTerm,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
} from '@patternfly/react-core';

import cockpit from 'cockpit';
import { primaryAddress } from './utils.js';

const { gettext: _, format } = cockpit;

const VNC_PORT = 5901;

export function MachineVncInfo({ machine, onClose }) {
    const ip = primaryAddress(machine.addresses);

    const downloadVncFile = () => {
        const content = `[connection]\nhost=${ip}\nport=${VNC_PORT}\n`;
        const blob = new Blob([content], { type: 'application/x-vnc' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${machine.machine}.vnc`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <Modal isOpen onClose={onClose} variant="medium">
            <ModalHeader title={format(_("Display: $0"), machine.machine)} />
            <ModalBody>
                {!ip && (
                    <Alert isInline variant="warning"
                        title={_("No IP address available")}
                    >
                        {_("The container does not have an IP address. Start it and wait a moment, then try again.")}
                    </Alert>
                )}

                {ip && (
                    <>
                        <Alert isInline variant="warning" style={{ marginBottom: '1rem' }}
                            title={_("VNC is unencrypted")}
                        >
                            {_("VNC does not encrypt the connection. Use only on trusted networks or via SSH tunnel.")}
                        </Alert>

                        <DescriptionList style={{ marginBottom: '1.5rem' }}>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Connection address")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <ClipboardCopy isReadOnly hoverTip={_("Copy")} clickTip={_("Copied")}>
                                        {`${ip}:${VNC_PORT}`}
                                    </ClipboardCopy>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        </DescriptionList>

                        <Button variant="secondary" onClick={downloadVncFile}>
                            {format(_("Download $0.vnc"), machine.machine)}
                        </Button>
                    </>
                )}

                <div style={{ marginTop: '1.5rem' }}>
                    <p><strong>{_("Requirements inside the container:")}</strong></p>
                    <pre style={{
                        background: '#1a1a1a', color: '#f0f0f0',
                        padding: '0.75rem', borderRadius: '4px',
                        fontSize: '0.85rem', marginTop: '0.5rem',
                    }}>
                        {`dnf install tigervnc-server xorg-x11-twm xterm\nvncserver :1 -geometry 1920x1080 -depth 24`}
                    </pre>
                    <p style={{ marginTop: '0.75rem', fontSize: '0.9rem' }}>
                        {_("Open the .vnc file with Remmina, TigerVNC Viewer, or another VNC client.")}
                    </p>
                </div>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={onClose}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
}
