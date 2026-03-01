/* SPDX-License-Identifier: LGPL-2.1-or-later */

import React, { useState, useEffect, useRef } from 'react';
import {
    Alert,
    Button,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Spinner,
} from '@patternfly/react-core';

import cockpit from 'cockpit';

const { gettext: _, format } = cockpit;

function humanBytes(bytes) {
    if (!bytes || bytes <= 0) return '—';
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/*
 * Trigger a browser download via Cockpit's HTTP channel endpoint.
 * This streams the file directly over HTTP — no base64, no browser RAM usage.
 * Works for arbitrarily large files.
 */
function triggerCockpitDownload(serverPath, downloadFilename) {
    const url = new URL(cockpit.transport.uri("channel/" + cockpit.transport.csrf_token));
    url.searchParams.set("payload", "fsread1");
    url.searchParams.set("path", serverPath);
    url.searchParams.set("binary", "raw");
    url.searchParams.set("superuser", "require");

    const a = document.createElement("a");
    a.href = url.toString();
    a.download = downloadFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

export function ExportMachineDialog({ machineName, onClose }) {
    const [phase, setPhase] = useState('idle');   // idle | exporting | ready | error
    const [writtenBytes, setWrittenBytes] = useState(0);
    const [error, setError] = useState(null);
    const pollRef = useRef(null);

    const tmpPath = `/tmp/cockpit-nspawn-export-${machineName}.tar.gz`;
    const fileName = `${machineName}.tar.gz`;

    // Stop polling on unmount
    useEffect(() => () => clearInterval(pollRef.current), []);

    const handleExport = async () => {
        setPhase('exporting');
        setWrittenBytes(0);
        setError(null);

        // Poll temp file size every second for progress
        pollRef.current = setInterval(async () => {
            try {
                const out = await cockpit.spawn(
                    ['stat', '--format=%s', tmpPath],
                    { superuser: 'require', err: 'ignore' }
                );
                const n = parseInt(out.trim(), 10);
                if (!isNaN(n)) setWrittenBytes(n);
            } catch (_) { /* file not created yet */ }
        }, 1000);

        try {
            await cockpit.spawn(
                ['machinectl', 'export-tar', machineName, tmpPath],
                { superuser: 'require', err: 'message' }
            );

            clearInterval(pollRef.current);

            try {
                const out = await cockpit.spawn(
                    ['stat', '--format=%s', tmpPath],
                    { superuser: 'require' }
                );
                setWrittenBytes(parseInt(out.trim(), 10) || 0);
            } catch (_) { /* ignore */ }

            setPhase('ready');
        } catch (ex) {
            clearInterval(pollRef.current);
            setError(ex.message || _("Export failed"));
            setPhase('error');
            cockpit.spawn(['rm', '-f', tmpPath], { superuser: 'require' }).catch(() => {});
        }
    };

    const handleDownload = () => {
        triggerCockpitDownload(tmpPath, fileName);
        setTimeout(() => {
            cockpit.spawn(['rm', '-f', tmpPath], { superuser: 'require' }).catch(() => {});
        }, 10000);
        setPhase('downloading');
    };

    const handleCleanup = () => {
        cockpit.spawn(['rm', '-f', tmpPath], { superuser: 'require' }).catch(() => {});
        onClose();
    };

    return (
        <Modal isOpen onClose={phase === 'exporting' ? undefined : onClose} variant="small">
            <ModalHeader title={format(_("Export $0"), machineName)} />
            <ModalBody>
                {phase === 'idle' && (
                    <>
                        <p>{_("Creates the archive on the server and starts a browser download. Streams directly via HTTP, works for large files.")}</p>
                        <p style={{ color: '#6a6e73', fontSize: '0.875rem' }}>
                            {_("Temporary file:")} <code>{tmpPath}</code> {_("(removed automatically)")}
                        </p>
                    </>
                )}

                {phase === 'exporting' && (
                    <p>
                        <Spinner size="sm" style={{ marginRight: '0.5rem' }} />
                        {_("Creating archive on server…")}{' '}
                        {writtenBytes > 0 && <strong>{humanBytes(writtenBytes)} {_("written")}</strong>}
                    </p>
                )}

                {phase === 'ready' && (
                    <>
                        <p>{format(_("Export complete — $0."), <strong>{humanBytes(writtenBytes)}</strong>)} {_("Click the button to start the download.")}</p>
                        <p style={{ color: '#6a6e73', fontSize: '0.875rem' }}>
                            {_("The file streams directly from the server. The temporary file is removed automatically after the download starts.")}
                        </p>
                    </>
                )}

                {phase === 'downloading' && (
                    <p>{format(_("Download started — check your browser's download bar for $0."), <strong>{fileName}</strong>)}</p>
                )}

                {phase === 'error' && (
                    <Alert variant="danger" isInline title={_("Export failed")}>
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: '0.8rem' }}>
                            {error}
                        </pre>
                    </Alert>
                )}
            </ModalBody>
            <ModalFooter>
                {phase === 'idle' && (
                    <Button variant="primary" onClick={handleExport}>
                        {_("Start export")}
                    </Button>
                )}

                {phase === 'ready' && (
                    <Button variant="primary" onClick={handleDownload}>
                        {format(_("Download $0"), fileName)}
                    </Button>
                )}

                {phase === 'downloading' && (
                    <Button variant="secondary" onClick={handleCleanup}>
                        {_("Close and clean up")}
                    </Button>
                )}

                {phase !== 'exporting' && (
                    <Button variant="link" onClick={onClose}>
                        {phase === 'downloading' ? _("Close") : _("Cancel")}
                    </Button>
                )}
            </ModalFooter>
        </Modal>
    );
}
