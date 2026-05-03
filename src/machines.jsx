import React, { useState } from "react";
import {
    Badge,
    Button,
    Flex,
    FlexItem,
    SearchInput,
    Toolbar,
    ToolbarContent,
    ToolbarItem,
} from "@patternfly/react-core";
import { CreateMachineDialog } from "./CreateMachineDialog.jsx";
import {
    Table,
    Thead,
    Tbody,
    Tr,
    Th,
    Td,
    ExpandableRowContent,
} from "@patternfly/react-table";

import cockpit from "cockpit";
import { primaryAddress, formatBytes } from "./utils.js";
import { MachineActions } from "./MachineActions.jsx";
import { MachineDetails } from "./MachineDetails.jsx";

const { gettext: _ } = cockpit;

/**
 * Merge running machines and images into a combined list.
 * Running machines take priority; images not running show as "stopped".
 */
function mergeData(machines, images) {
    const nspawnOnly = machines.filter(m => m.service === "systemd-nspawn" || m.class === "container");
    const running = new Map(nspawnOnly.map(m => [m.machine, m]));

    const stopped = images
        .filter(img => !running.has(img.name))
        .map(img => ({
            machine: img.name,
            class: img.type || "container",
            service: "systemd-nspawn",
            os: null,
            version: null,
            addresses: null,
            state: "stopped",
            _image: img,
        }));

    const runningList = [...running.values()].map(m => ({ ...m, state: "running" }));
    return [...runningList, ...stopped].sort((a, b) => a.machine.localeCompare(b.machine, 'sv'));
}

function StatusBadge({ state }) {
    const color = state === "running" ? "green" : "grey";
    return <Badge style={{ backgroundColor: color === "green" ? "#3e8635" : "#6a6e73", color: "white" }}>{state}</Badge>;
}

export function Machines({ machines, images, enabledMachines, backupStatuses, onAction, onAddNotification, onRefresh }) {
    const [filter, setFilter] = useState("");
    const [expandedRows, setExpandedRows] = useState(new Set());
    const [showCreate, setShowCreate] = useState(false);

    const allMachines = mergeData(machines, images);
    const filtered = allMachines.filter(m =>
        !filter || m.machine.toLowerCase().includes(filter.toLowerCase())
    );

    const toggleExpand = (name) => {
        setExpandedRows(prev => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    };

    return (
        <>
            {showCreate && (
                <CreateMachineDialog
                    images={images}
                    onClose={() => setShowCreate(false)}
                    onRefresh={onRefresh}
                    onAddNotification={onAddNotification}
                />
            )}
            <Toolbar>
                <ToolbarContent>
                    <ToolbarItem>
                        <SearchInput
                            placeholder={_("Filter containers...")}
                            value={filter}
                            onChange={(_e, val) => setFilter(val)}
                            onClear={() => setFilter("")}
                        />
                    </ToolbarItem>
                    <ToolbarItem>
                        <Button variant="primary" onClick={() => setShowCreate(true)}>
                            {_("Create container")}
                        </Button>
                    </ToolbarItem>
                    <ToolbarItem align={{ default: "alignRight" }}>
                        <Button variant="secondary" onClick={onRefresh}>
                            {_("Refresh")}
                        </Button>
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>

            <Table aria-label="nspawn containers" variant="compact">
                <Thead>
                    <Tr>
                        <Th screenReaderText={_("Expand")} />
                        <Th>{_("Name")}</Th>
                        <Th>{_("Status")}</Th>
                        <Th>{_("OS")}</Th>
                        <Th>{_("IP address")}</Th>
                        <Th>{_("Type")}</Th>
                        <Th screenReaderText={_("Actions")} />
                    </Tr>
                </Thead>
                <Tbody>
                    {filtered.length === 0 && (
                        <Tr>
                            <Td colSpan={7} style={{ textAlign: "center", color: "#6a6e73", padding: "2rem" }}>
                                {_("No containers found")}
                            </Td>
                        </Tr>
                    )}
                    {filtered.map((m) => (
                        <React.Fragment key={m.machine}>
                            <Tr>
                                <Td
                                    expand={{
                                        rowIndex: m.machine,
                                        isExpanded: expandedRows.has(m.machine),
                                        onToggle: () => toggleExpand(m.machine),
                                    }}
                                />
                                <Td dataLabel={_("Name")}>
                                    <strong>{m.machine}</strong>
                                </Td>
                                <Td dataLabel={_("Status")}>
                                    <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
                                        <FlexItem><StatusBadge state={m.state} /></FlexItem>
                                        {enabledMachines && enabledMachines.has(m.machine) && (
                                            <FlexItem>
                                                <Badge style={{ backgroundColor: '#06c', color: 'white', fontSize: '0.7em' }}>
                                                    {_("autostart")}
                                                </Badge>
                                            </FlexItem>
                                        )}
                                        {backupStatuses && backupStatuses.has(m.machine) && (() => {
                                            const bs = backupStatuses.get(m.machine);
                                            const ok = bs.result === 'success';
                                            return (
                                                <FlexItem>
                                                    <Badge style={{ backgroundColor: ok ? '#3e8635' : '#c9190b', color: 'white', fontSize: '0.7em' }}>
                                                        {ok ? _("backup OK") : _("backup failed")}
                                                    </Badge>
                                                </FlexItem>
                                            );
                                        })()}
                                    </Flex>
                                </Td>
                                <Td dataLabel={_("OS")}>
                                    {m.os
                                        ? `${m.os}${m.version ? ` ${m.version}` : ""}`
                                        : <span style={{ color: "#6a6e73" }}>—</span>
                                    }
                                </Td>
                                <Td dataLabel={_("IP address")}>
                                    {primaryAddress(m.addresses) || <span style={{ color: "#6a6e73" }}>—</span>}
                                </Td>
                                <Td dataLabel={_("Type")}>
                                    <span style={{ color: "#6a6e73", fontSize: "0.85em" }}>
                                        {m.class || "container"}
                                    </span>
                                </Td>
                                <Td dataLabel={_("Actions")} isActionCell>
                                    <MachineActions
                                        machine={m}
                                        isAutostart={enabledMachines ? enabledMachines.has(m.machine) : false}
                                        onAction={onAction}
                                        onAddNotification={onAddNotification}
                                        onExpand={() => toggleExpand(m.machine)}
                                        isExpanded={expandedRows.has(m.machine)}
                                    />
                                </Td>
                            </Tr>
                            {expandedRows.has(m.machine) && (
                                <Tr isExpanded>
                                    <Td colSpan={7}>
                                        <ExpandableRowContent>
                                            <MachineDetails
                                                machine={m}
                                                onAddNotification={onAddNotification}
                                            />
                                        </ExpandableRowContent>
                                    </Td>
                                </Tr>
                            )}
                        </React.Fragment>
                    ))}
                </Tbody>
            </Table>
        </>
    );
}
