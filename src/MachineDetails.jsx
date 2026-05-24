import React, { useState, useEffect } from "react";
import {
    DescriptionList,
    DescriptionListGroup,
    DescriptionListTerm,
    DescriptionListDescription,
    Button,
    Flex,
    FlexItem,
    Label,
    Spinner,
} from "@patternfly/react-core";

import cockpit from "cockpit";
import { spawnMachinectl } from "./utils.js";

const { gettext: _ } = cockpit;

function parseStatusOutput(output) {
    const info = {};
    const lines = output.split("\n");

    for (const line of lines) {
        const [key, ...rest] = line.split(":");
        if (!key || !rest.length) continue;
        const k = key.trim().toLowerCase().replace(/\s+/g, "_");
        info[k] = rest.join(":").trim();
    }
    return info;
}

export function MachineDetails({ machine, onAddNotification }) {
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [failedUnits, setFailedUnits] = useState(null);
    const name = machine.machine;

    useEffect(() => {
        if (machine.state !== "running") {
            setLoading(false);
            return;
        }

        spawnMachinectl(["status", name, "--no-pager"])
            .then(output => {
                setStatus(parseStatusOutput(output));
                setLoading(false);
            })
            .catch(ex => {
                console.warn("machinectl status error:", ex.message);
                setLoading(false);
            });

        cockpit.spawn(
            ['systemctl', '--machine', name,
                'list-units', '--state=failed', '--no-pager', '--no-legend'],
            { superuser: 'try', err: 'ignore' }
        ).then(output => {
            const units = output.trim().split('\n')
                .filter(Boolean)
                .map(line => line.trim().split(/\s+/)[0])
                .filter(u => u && u !== '●');
            setFailedUnits(units);
        }).catch(() => setFailedUnits([]));
    }, [name, machine.state]);

    const machinePath = `/var/lib/machines/${name}`;

    const openInFiles = () => {
        cockpit.jump(`/files#${machinePath}`);
    };

    const openLogs = () => {
        cockpit.jump(`/system/logs/#/?_HOSTNAME=${name}`);
    };

    if (loading) {
        return <Spinner size="md" />;
    }

    const addresses = machine.addresses
        ? machine.addresses.split("\n").map(s => s.trim()).filter(Boolean)
        : [];

    return (
        <DescriptionList isHorizontal columnModifier={{ default: "2Col" }}>
            <DescriptionListGroup>
                <DescriptionListTerm>{_("Path")}</DescriptionListTerm>
                <DescriptionListDescription>
                    <code>{machinePath}</code>
                </DescriptionListDescription>
            </DescriptionListGroup>

            <DescriptionListGroup>
                <DescriptionListTerm>{_("Type")}</DescriptionListTerm>
                <DescriptionListDescription>
                    {machine.class || "container"} ({machine.service || "systemd-nspawn"})
                </DescriptionListDescription>
            </DescriptionListGroup>

            {machine.os && (
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Operating system")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {machine.os} {machine.version}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}

            {addresses.length > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("IP addresses")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {addresses.map(addr => (
                            <div key={addr}><code>{addr}</code></div>
                        ))}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}

            {status && status.leader && (
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Leader PID")}</DescriptionListTerm>
                    <DescriptionListDescription>{status.leader}</DescriptionListDescription>
                </DescriptionListGroup>
            )}

            {status && status.since && (
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Started")}</DescriptionListTerm>
                    <DescriptionListDescription>{status.since}</DescriptionListDescription>
                </DescriptionListGroup>
            )}

            {machine.state === "running" && (
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Failed units")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {failedUnits === null
                            ? <Spinner size="sm" />
                            : failedUnits.length === 0
                                ? <Label color="green" isCompact>{_("No failed units")}</Label>
                                : (
                                    <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsXs' }}>
                                        {failedUnits.map(u => (
                                            <FlexItem key={u}>
                                                <Label color="red" isCompact>
                                                    <code style={{ fontSize: '0.85em' }}>{u}</code>
                                                </Label>
                                            </FlexItem>
                                        ))}
                                    </Flex>
                                )
                        }
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}

            <DescriptionListGroup>
                <DescriptionListTerm>{_("Shortcuts")}</DescriptionListTerm>
                <DescriptionListDescription>
                    <Flex>
                        <FlexItem>
                            <Button variant="link" isInline onClick={openLogs}>
                                {_("System logs")}
                            </Button>
                        </FlexItem>
                        <FlexItem>
                            <Button variant="link" isInline onClick={openInFiles}>
                                {_("Files")}
                            </Button>
                        </FlexItem>
                    </Flex>
                </DescriptionListDescription>
            </DescriptionListGroup>
        </DescriptionList>
    );
}
