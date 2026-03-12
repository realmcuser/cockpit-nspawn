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
 * Download a server-side file to the browser.
 *
 * Uses cockpit.spawn('cat') to stream binary data over the existing WebSocket
 * rather than Cockpit's HTTP channel endpoint. The HTTP channel shares the
 * bridge process with the UI WebSocket and starves it on large transfers,
 * causing Cockpit to show "Oops" / drop the session.
 *
 * If the File System Access API (showSaveFilePicker) is available the data
 * streams directly to disk — no browser memory limit.
 * Otherwise chunks are accumulated as a Blob (works for files up to ~1–2 GB
 * depending on browser/system RAM).
 */
async function streamDownload(serverPath, downloadFilename, onProgress) {
    if (window.showSaveFilePicker) {
        // True streaming — browser writes directly to disk, no memory limit.
        // showSaveFilePicker must be called inside the user-gesture handler (this function
        // is called directly from a button onClick so the gesture is still active).
        let handle;
        try {
            handle = await window.showSaveFilePicker({ suggestedName: downloadFilename });
        } catch (err) {
            if (err.name === 'AbortError') return; // user cancelled picker
            throw err;
        }
        const writable = await handle.createWritable();
        try {
            await new Promise((resolve, reject) => {
                const proc = cockpit.spawn(['cat', serverPath],
                    { superuser: 'require', binary: true, err: 'message' });
                proc.stream(chunk => {
                    writable.write(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk));
                    if (onProgress) onProgress(chunk.length || chunk.byteLength || 0);
                });
                proc.then(resolve).catch(reject);
            });
            await writable.close();
        } catch (err) {
            await writable.abort(err);
            throw err;
        }
    } else {
        // Blob fallback — accumulates entire file in browser memory.
        const chunks = [];
        await new Promise((resolve, reject) => {
            const proc = cockpit.spawn(['cat', serverPath],
                { superuser: 'require', binary: true, err: 'message' });
            proc.stream(chunk => {
                chunks.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk));
                if (onProgress) onProgress(chunk.length || chunk.byteLength || 0);
            });
            proc.then(resolve).catch(reject);
        });
        const blob = new Blob(chunks, { type: 'application/gzip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = downloadFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
}

export function ExportMachineDialog({ machineName, onClose }) {
    const [phase, setPhase] = useState('idle');   // idle | exporting | ready | error
    const [writtenBytes, setWrittenBytes] = useState(0);
    const [error, setError] = useState(null);
    const pollRef = useRef(null);
    const exportProcRef = useRef(null);

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
            const proc = cockpit.spawn(
                ['machinectl', 'export-tar', machineName, tmpPath],
                { superuser: 'require', err: 'message' }
            );
            exportProcRef.current = proc;
            await proc;
            exportProcRef.current = null;

            clearInterval(pollRef.current);

            try {
                const out = await cockpit.spawn(
                    ['stat', '--format=%s', tmpPath],
                    { superuser: 'require' }
                );
                setWrittenBytes(parseInt(out.trim(), 10) || 0);
            } catch (_) { /* ignore */ }

            // Make the file world-readable so the HTTP channel download can
            // stream it without superuser=require (which buffers via bridge and OOMs).
            await cockpit.spawn(['chmod', '644', tmpPath], { superuser: 'require' }).catch(() => {});

            setPhase('ready');
        } catch (ex) {
            exportProcRef.current = null;
            clearInterval(pollRef.current);
            setError(ex.message || _("Export failed"));
            setPhase('error');
            cockpit.spawn(['rm', '-f', tmpPath], { superuser: 'require' }).catch(() => {});
        }
    };

    const handleCancelExport = () => {
        clearInterval(pollRef.current);
        if (exportProcRef.current) {
            exportProcRef.current.close('terminated');
            exportProcRef.current = null;
        }
        cockpit.spawn(['rm', '-f', tmpPath], { superuser: 'require' }).catch(() => {});
        onClose();
    };

    const handleDownload = async () => {
        setPhase('downloading');
        setWrittenBytes(0);
        try {
            await streamDownload(tmpPath, fileName, (bytes) => {
                setWrittenBytes(prev => prev + bytes);
            });
            setPhase('done');
        } catch (err) {
            setError(err.message || _("Download failed"));
            setPhase('error');
        } finally {
            cockpit.spawn(['rm', '-f', tmpPath], { superuser: 'require' }).catch(() => {});
        }
    };

    const handleCleanup = () => {
        cockpit.spawn(['rm', '-f', tmpPath], { superuser: 'require' }).catch(() => {});
        onClose();
    };

    return (
        <Modal isOpen onClose={phase === 'exporting' ? handleCancelExport : onClose} variant="small">
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
                    <p>
                        <Spinner size="sm" style={{ marginRight: '0.5rem' }} />
                        {_("Downloading…")}{' '}
                        {writtenBytes > 0 && <strong>{humanBytes(writtenBytes)} {_("transferred")}</strong>}
                    </p>
                )}

                {phase === 'done' && (
                    <Alert variant="success" isInline title={_("Download complete")}>
                        {_("Saved to your downloads folder:")}{' '}
                        <strong>{fileName}</strong>
                        {writtenBytes > 0 && <>{' '}({humanBytes(writtenBytes)})</>}
                    </Alert>
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

                {phase === 'exporting' && (
                    <Button variant="danger" onClick={handleCancelExport}>
                        {_("Cancel export")}
                    </Button>
                )}

                {phase === 'done' && (
                    <Button variant="primary" onClick={onClose}>
                        {_("Close")}
                    </Button>
                )}

                {phase !== 'exporting' && phase !== 'done' && (
                    <Button variant="link" onClick={onClose}>
                        {_("Cancel")}
                    </Button>
                )}
            </ModalFooter>
        </Modal>
    );
}
