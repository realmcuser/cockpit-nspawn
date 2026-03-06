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

const RDP_PORT = 3389;

export function MachineRdpInfo({ machine, onClose }) {
    const ip = primaryAddress(machine.addresses);

    const downloadRdpFile = () => {
        const content = [
            `full address:s:${ip}:${RDP_PORT}`,
            'username:s:root',
            'prompt for credentials:i:1',
            'authentication level:i:0',
            '',
        ].join('\r\n');
        const blob = new Blob([content], { type: 'application/x-rdp' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${machine.machine}.rdp`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <Modal isOpen onClose={onClose} variant="medium">
            <ModalHeader title={format(_("Remote Desktop: $0"), machine.machine)} />
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
                        <DescriptionList style={{ marginBottom: '1.5rem' }}>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Connection address")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <ClipboardCopy isReadOnly hoverTip={_("Copy")} clickTip={_("Copied")}>
                                        {`${ip}:${RDP_PORT}`}
                                    </ClipboardCopy>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Username")}</DescriptionListTerm>
                                <DescriptionListDescription>root</DescriptionListDescription>
                            </DescriptionListGroup>
                        </DescriptionList>

                        <Alert isInline variant="info" style={{ marginBottom: '1rem' }}
                            title={_("Password required")}
                        >
                            {_("RDP uses system authentication. Connect with the root password set during bootstrap. RDP encrypts the connection by default.")}
                        </Alert>

                        <Button variant="secondary" onClick={downloadRdpFile}>
                            {format(_("Download $0.rdp"), machine.machine)}
                        </Button>
                    </>
                )}

                <div style={{ marginTop: '1.5rem' }}>
                    <p style={{ marginBottom: '0.5rem' }}>
                        {_("Open the .rdp file with Windows Remote Desktop (mstsc.exe), Remmina, or xfreerdp.")}
                    </p>
                    <details>
                        <summary style={{ cursor: 'pointer', fontSize: '0.9rem', color: 'var(--pf-v5-global--Color--200)' }}>
                            {_("Manual RDP setup (if not using bootstrap)")}
                        </summary>
                        <pre style={{
                            background: '#1a1a1a', color: '#f0f0f0',
                            padding: '0.75rem', borderRadius: '4px',
                            fontSize: '0.85rem', marginTop: '0.5rem',
                        }}>
                            {`# Install inside the container (AlmaLinux 9 — enable EPEL first):
dnf install epel-release
dnf install xrdp xorgxrdp xfce4-session xfwm4 xfce4-panel xfce4-terminal

# Configure the desktop session:
echo '#!/bin/sh
exec startxfce4' > /etc/xrdp/startwm.sh
chmod +x /etc/xrdp/startwm.sh

# Enable and start:
systemctl enable --now xrdp`}
                        </pre>
                    </details>
                </div>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={onClose}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
}
