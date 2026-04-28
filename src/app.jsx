/* SPDX-License-Identifier: LGPL-2.1-or-later */

import React, { useState, useEffect, useCallback } from 'react';
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
    const [loading, setLoading] = useState(true);
    const [notifications, setNotifications] = useState([]);

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

        Promise.all([listPromise, imagesPromise, fetchEnabledMachines()])
            .then(([machineList, imageList, enabled]) => {
                setMachines(machineList);
                setImages(imageList);
                setEnabledMachines(enabled);
                setLoading(false);
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
                    onAction={handleAction}
                    onAddNotification={addNotification}
                    onRefresh={fetchData}
                />
            </PageSection>
        </Page>
    );
}
