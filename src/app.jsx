/* SPDX-License-Identifier: LGPL-2.1-or-later */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    Alert,
    AlertGroup,
    AlertActionCloseButton,
    Page,
    PageSection,
    Spinner,
    EmptyState,
    EmptyStateBody,
    Title,
} from '@patternfly/react-core';

import cockpit from 'cockpit';
import { spawnMachinectl, parseMachinectlJson } from './utils.js';
import { Machines } from './machines.jsx';

const { gettext: _, format } = cockpit;

const POLL_INTERVAL = 5000;

function fetchEnabledMachines() {
    return cockpit.spawn(
        ['sh', '-c', 'ls /etc/systemd/system/machines.target.wants/ 2>/dev/null || true'],
        { superuser: 'require', err: 'ignore' }
    ).then(output => {
        const names = new Set();
        output.split('\n').forEach(file => {
            const match = file.trim().match(/^systemd-nspawn@(.+)\.service$/);
            if (match) names.add(match[1]);
        });
        return names;
    }).catch(() => new Set());
}

async function fetchResourceStats(runningNames) {
    if (runningNames.length === 0) return new Map();
    const results = new Map();
    await Promise.all(runningNames.map(async name => {
        try {
            const output = await cockpit.spawn(
                ['systemctl', 'show',
                    '--property=MemoryCurrent',
                    '--property=CPUUsageNSec',
                    `systemd-nspawn@${name}.service`],
                { superuser: 'try', err: 'ignore' }
            );
            const memMatch = output.match(/MemoryCurrent=(\d+)/);
            const cpuMatch = output.match(/CPUUsageNSec=(\d+)/);
            const memVal = memMatch ? parseInt(memMatch[1], 10) : null;
            const cpuVal = cpuMatch ? parseInt(cpuMatch[1], 10) : null;
            results.set(name, {
                memBytes: (memVal !== null && memVal < 1e16) ? memVal : null,
                cpuNs: (cpuVal !== null && cpuVal < 1e19) ? cpuVal : null,
                ts: Date.now(),
            });
        } catch (_e) {}
    }));
    return results;
}

function fetchBackupStatuses() {
    return cockpit.spawn(
        ['find', '/etc/cockpit-nspawn/backup-status', '-maxdepth', '1', '-name', '*.json'],
        { superuser: 'try', err: 'ignore' }
    ).then(output => {
        const files = output.trim().split('\n').filter(Boolean);
        if (files.length === 0) return new Map();
        return Promise.all(
            files.map(f => {
                const name = f.replace(/^.*\//, '').replace(/\.json$/, '');
                return cockpit.file(f, { superuser: 'try' }).read()
                    .then(content => {
                        if (!content) return null;
                        try { return [name, JSON.parse(content)]; } catch { return null; }
                    })
                    .catch(() => null);
            })
        ).then(results => {
            const map = new Map();
            results.filter(Boolean).forEach(([n, s]) => map.set(n, s));
            return map;
        });
    }).catch(() => new Map());
}

function removeMachine(name) {
    // Disable autostart first (ignore errors if not enabled)
    return spawnMachinectl(['disable', name]).catch(() => null)
        .then(() => spawnMachinectl(['remove', name]))
        .catch(() => {
            // Fallback: machinectl remove fails on some distros (e.g. AlmaLinux 10).
            return cockpit.spawn(
                ['rm', '-rf', `/var/lib/machines/${name}`],
                { superuser: 'require', err: 'message' }
            ).then(() => cockpit.spawn(
                ['rm', '-f', `/etc/systemd/nspawn/${name}.nspawn`],
                { superuser: 'require', err: 'message' }
            ));
        });
}

export function Application() {
    const [machines, setMachines] = useState([]);
    const [images, setImages] = useState([]);
    const [enabledMachines, setEnabledMachines] = useState(new Set());
    const [backupStatuses, setBackupStatuses] = useState(new Map());
    const [resourceStats, setResourceStats] = useState(new Map());
    const [loading, setLoading] = useState(true);
    const [notifications, setNotifications] = useState([]);
    const prevCpuRef = useRef(new Map());

    const addNotification = useCallback((notification) => {
        const id = Date.now();
        setNotifications(prev => [...prev, { id, ...notification }]);
        if (notification.type !== 'danger') {
            setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 10000);
        }
    }, []);

    const removeNotification = useCallback((id) => {
        setNotifications(prev => prev.filter(n => n.id !== id));
    }, []);

    const fetchData = useCallback(() => {
        const listPromise = spawnMachinectl(['list', '--output=json', '--no-pager'])
            .then(output => parseMachinectlJson(output))
            .catch(ex => {
                console.warn('machinectl list:', ex.message);
                return [];
            });

        const imagesPromise = spawnMachinectl(['list-images', '--output=json', '--no-pager'])
            .then(output => parseMachinectlJson(output))
            .catch(ex => {
                console.warn('machinectl list-images:', ex.message);
                return [];
            });

        listPromise.then(machineList => {
            const runningNames = machineList
                .filter(m => m.service === 'systemd-nspawn' || m.class === 'container')
                .map(m => m.machine);

            Promise.all([
                Promise.resolve(machineList),
                imagesPromise,
                fetchEnabledMachines(),
                fetchBackupStatuses(),
                fetchResourceStats(runningNames),
            ]).then(([machineList2, imageList, enabled, backupStats, rawRes]) => {
                const now = Date.now();
                const display = new Map();
                rawRes.forEach((stats, name) => {
                    const prev = prevCpuRef.current.get(name);
                    let cpuPercent = null;
                    if (prev && stats.cpuNs !== null && prev.cpuNs !== null) {
                        const deltaCpu = stats.cpuNs - prev.cpuNs;
                        const deltaWall = (now - prev.ts) * 1e6;
                        if (deltaWall > 0 && deltaCpu >= 0) {
                            cpuPercent = Math.min(999, (deltaCpu / deltaWall) * 100);
                        }
                    }
                    display.set(name, { memBytes: stats.memBytes, cpuPercent });
                });
                prevCpuRef.current = new Map(
                    [...rawRes.entries()]
                        .filter(([, s]) => s.cpuNs !== null)
                        .map(([n, s]) => [n, { cpuNs: s.cpuNs, ts: now }])
                );
                setMachines(machineList2);
                setImages(imageList);
                setEnabledMachines(enabled);
                setBackupStatuses(backupStats);
                setResourceStats(display);
                setLoading(false);
            });
        });
    }, []);

    useEffect(() => {
        fetchData();
        const timer = setInterval(fetchData, POLL_INTERVAL);
        return () => clearInterval(timer);
    }, [fetchData]);

    const handleAction = useCallback((action, machineName) => {
        const commands = {
            start: ['start', machineName],
            stop: ['poweroff', machineName],
            terminate: ['terminate', machineName],
            'autostart-enable': ['enable', machineName],
            'autostart-disable': ['disable', machineName],
        };

        const promise = action === 'remove'
            ? removeMachine(machineName)
            : spawnMachinectl(commands[action]);

        if (!promise) return;

        promise
            .then(() => {
                const title = {
                    start: format(_("$0 started"), machineName),
                    stop: format(_("$0 stopped"), machineName),
                    terminate: format(_("$0 terminated"), machineName),
                    remove: format(_("$0 removed"), machineName),
                    'autostart-enable': format(_("Autostart enabled for $0"), machineName),
                    'autostart-disable': format(_("Autostart disabled for $0"), machineName),
                }[action] || `${machineName}: ${action}`;
                addNotification({ type: 'success', title });
                setTimeout(fetchData, 800);
            })
            .catch(ex => {
                const title = {
                    start: format(_("Failed to start $0"), machineName),
                    stop: format(_("Failed to stop $0"), machineName),
                    terminate: format(_("Failed to terminate $0"), machineName),
                    remove: format(_("Failed to remove $0"), machineName),
                    'autostart-enable': format(_("Failed to enable autostart for $0"), machineName),
                    'autostart-disable': format(_("Failed to disable autostart for $0"), machineName),
                }[action] || `${machineName}: ${action} failed`;
                addNotification({
                    type: 'danger',
                    title,
                    detail: ex.message,
                });
            });
    }, [addNotification, fetchData]);

    if (loading) {
        return (
            <Page>
                <PageSection>
                    <EmptyState>
                        <Spinner size="xl" />
                        <EmptyStateBody>{_("Loading containers...")}</EmptyStateBody>
                    </EmptyState>
                </PageSection>
            </Page>
        );
    }

    return (
        <Page>
            <AlertGroup isToast isLiveRegion>
                {notifications.map(n => (
                    <Alert
                        key={n.id}
                        variant={n.type}
                        title={n.title}
                        actionClose={<AlertActionCloseButton onClose={() => removeNotification(n.id)} />}
                    >
                        {n.detail && <p>{n.detail}</p>}
                    </Alert>
                ))}
            </AlertGroup>

            <PageSection>
                <Title headingLevel="h1" size="2xl">{_("Containers (nspawn)")}</Title>
            </PageSection>

            <PageSection>
                <Machines
                    machines={machines}
                    images={images}
                    enabledMachines={enabledMachines}
                    backupStatuses={backupStatuses}
                    resourceStats={resourceStats}
                    onAction={handleAction}
                    onAddNotification={addNotification}
                    onRefresh={fetchData}
                />
            </PageSection>
        </Page>
    );
}
