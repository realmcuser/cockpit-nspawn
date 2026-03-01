/* SPDX-License-Identifier: LGPL-2.1-or-later */

import React, { useEffect, useRef } from 'react';
import {
    Button,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
} from '@patternfly/react-core';

import { Terminal as XTerm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import cockpit from 'cockpit';

import '@xterm/xterm/css/xterm.css';

const { gettext: _, format } = cockpit;

export function MachineTerminal({ machineName, onClose }) {
    const containerRef = useRef(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const term = new XTerm({
            cols: 80,
            rows: 24,
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, Consolas, monospace',
            theme: { background: '#000000', foreground: '#ffffff' },
        });

        // Open terminal on DOM element first — required before loading addons
        term.open(containerRef.current);

        try {
            term.loadAddon(new WebglAddon());
        } catch (e) {
            console.warn('WebGL not available, using canvas renderer:', e);
        }

        const channel = cockpit.channel({
            payload: 'stream',
            spawn: ['machinectl', 'shell', machineName],
            pty: true,
            environ: ['TERM=xterm-256color'],
            superuser: 'require',
        });

        channel.addEventListener('message', (_event, data) => {
            term.write(data);
        });

        channel.addEventListener('close', (_event, options) => {
            term.write('\x1b[31m' + (options.problem || 'disconnected') + '\x1b[m\r\n');
        });

        term.onData(data => {
            if (channel.valid)
                channel.send(data);
        });

        const handleResize = () => {
            const container = containerRef.current;
            if (!container) return;
            /* eslint-disable no-underscore-dangle */
            const core = term._core;
            const cellH = core?._renderService?.dimensions?.css?.cell?.height;
            const cellW = core?._renderService?.dimensions?.css?.cell?.width;
            if (cellH && cellW && cellH > 0 && cellW > 0) {
                const rows = Math.max(Math.floor((container.clientHeight - 16) / cellH), 1);
                const cols = Math.max(Math.floor((container.clientWidth - 16) / cellW), 1);
                term.resize(cols, rows);
                channel.control({ window: { rows, cols } });
            }
        };

        window.addEventListener('resize', handleResize);
        // Give the modal time to finish rendering before calculating size
        const resizeTimer = setTimeout(handleResize, 150);

        term.focus();

        return () => {
            clearTimeout(resizeTimer);
            window.removeEventListener('resize', handleResize);
            channel.close();
            term.dispose();
        };
    }, [machineName]);

    return (
        <Modal
            isOpen
            onClose={onClose}
            variant="large"
            aria-label={format(_("Terminal for $0"), machineName)}
            style={{ '--pf-v6-c-modal-box--Height': '600px' }}
        >
            <ModalHeader title={format(_("Terminal — $0"), machineName)} />
            <ModalBody style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
                <div
                    ref={containerRef}
                    style={{
                        flex: 1,
                        minHeight: '460px',
                        background: '#000',
                        padding: '8px',
                        overflow: 'hidden',
                    }}
                />
            </ModalBody>
            <ModalFooter>
                <Button variant="link" onClick={onClose}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
}
