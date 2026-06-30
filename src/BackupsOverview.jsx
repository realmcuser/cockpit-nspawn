/* SPDX-License-Identifier: LGPL-2.1-or-later */

import React, { useState, useEffect } from 'react';
import {
    EmptyState,
    EmptyStateBody,
    Label,
    Spinner,
} from '@patternfly/react-core';
import {
    Table,
    Thead,
    Tbody,
    Tr,
    Th,
    Td,
} from '@patternfly/react-table';
import cockpit from 'cockpit';

const { gettext: _, format } = cockpit;

const CONFIG_DIR = '/etc/cockpit-nspawn/backup';

function formatTs(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch (_e) { return ts; }
}

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '';
    if (bytes > 1024 ** 3) return ` (${(bytes / 1024 ** 3).toFixed(1)} GB)`;
    if (bytes > 1024 ** 2) return ` (${(bytes / 1024 ** 2).toFixed(1)} MB)`;
    return ` (${(bytes / 1024).toFixed(0)} KB)`;
}

function formatNextRun(ms) {
    if (!ms || ms === '0') return '—';
    try {
        const d = new Date(parseInt(ms, 10));
        return isNaN(d.getTime()) ? '—' : d.toLocaleString();
    } catch (_e) { return '—'; }
}

function scheduleLabel(cfg) {
    const freq = cfg.schedule_freq || 'daily';
    const time = cfg.schedule_time || '02:00';
    const labels = {
        hourly: _("Every hour"),
        '2h':   _("Every 2 hours"),
        '4h':   _("Every 4 hours"),
        '6h':   _("Every 6 hours"),
        '12h':  _("Every 12 hours"),
        daily:  time,
    };
    return labels[freq] || freq;
}

export function BackupsOverview({ allNames, backupStatuses }) {
    const [configs, setConfigs]   = useState(new Map());
    const [nextRuns, setNextRuns] = useState(new Map());
    const [loading, setLoading]   = useState(true);

    useEffect(() => {
        async function load() {
            let files = [];
            try {
                const out = await cockpit.spawn(
                    ['find', CONFIG_DIR, '-maxdepth', '1', '-name', '*.json'],
                    { superuser: 'try', err: 'ignore' }
                );
                files = out.trim().split('\n').filter(Boolean);
            } catch (_e) {}

            const cfgMap = new Map();
            await Promise.all(files.map(async f => {
                const name = f.replace(/^.*\//, '').replace(/\.json$/, '');
                try {
                    const content = await cockpit.file(f, { superuser: 'try' }).read();
                    if (content) cfgMap.set(name, JSON.parse(content));
                } catch (_e) {}
            }));
            setConfigs(cfgMap);

            const nextMap = new Map();
            await Promise.all([...cfgMap.keys()].map(async name => {
                try {
                    const out = await cockpit.spawn(
                        ['bash', '-c',
                         `ts=$(systemctl show --property=NextElapseUSecRealtime --value 'cockpit-nspawn-backup-${name}.timer' 2>/dev/null); date -d "$ts" +%s 2>/dev/null || echo 0`],
                        { superuser: 'try', err: 'ignore' }
                    );
                    const secs = parseInt(out.trim(), 10);
                    if (secs > 0) nextMap.set(name, String(secs * 1000));
                } catch (_e) {}
            }));
            setNextRuns(nextMap);
            setLoading(false);
        }
        load();
    }, []);

    if (loading) {
        return (
            <EmptyState>
                <Spinner size="xl" />
                <EmptyStateBody>{_("Loading backup status...")}</EmptyStateBody>
            </EmptyState>
        );
    }

    const allNamesSet = new Set([...allNames, ...configs.keys()]);
    const rows = [...allNamesSet].sort();

    if (rows.length === 0) {
        return (
            <EmptyState>
                <EmptyStateBody>{_("No containers found.")}</EmptyStateBody>
            </EmptyState>
        );
    }

    const dimStyle = { color: 'var(--pf-t--global--color--nonstatus--gray--default)' };

    return (
        <Table aria-label={_("Backup overview")} variant="compact">
            <Thead>
                <Tr>
                    <Th>{_("Container")}</Th>
                    <Th>{_("Type")}</Th>
                    <Th>{_("Schedule")}</Th>
                    <Th>{_("Last backup")}</Th>
                    <Th>{_("Next run")}</Th>
                </Tr>
            </Thead>
            <Tbody>
                {rows.map(name => {
                    const cfg  = configs.get(name);
                    const st   = backupStatuses.get(name);
                    const next = nextRuns.get(name);

                    if (!cfg) {
                        return (
                            <Tr key={name}>
                                <Td>{name}</Td>
                                <Td colSpan={4} style={dimStyle}>{_("No backup configured")}</Td>
                            </Tr>
                        );
                    }

                    const typeLabel = cfg.backup_type === 'incremental'
                        ? _("Incremental")
                        : _("Full");

                    let lastCell;
                    if (!st) {
                        lastCell = <span style={dimStyle}>{_("Never run")}</span>;
                    } else if (st.result === 'success') {
                        lastCell = (
                            <>
                                <Label color="green" isCompact>{_("OK")}</Label>
                                {' '}{formatTs(st.timestamp)}{formatSize(st.size_bytes)}
                            </>
                        );
                    } else {
                        lastCell = (
                            <>
                                <Label color="red" isCompact>{_("Failed")}</Label>
                                {' '}{formatTs(st.timestamp)}
                                {st.message && <> — <span style={{ color: 'var(--pf-t--global--color--status--danger--default)' }}>{st.message}</span></>}
                            </>
                        );
                    }

                    return (
                        <Tr key={name}>
                            <Td>{name}</Td>
                            <Td>{typeLabel}</Td>
                            <Td>{scheduleLabel(cfg)}</Td>
                            <Td>{lastCell}</Td>
                            <Td>{formatNextRun(next)}</Td>
                        </Tr>
                    );
                })}
            </Tbody>
        </Table>
    );
}
