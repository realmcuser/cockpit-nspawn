import React, { useState } from "react";
import {
    Button,
    Dropdown,
    DropdownItem,
    DropdownList,
    MenuToggle,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Divider,
} from "@patternfly/react-core";
import { EllipsisVIcon } from "@patternfly/react-icons";

import cockpit from "cockpit";
import { MachineTerminal } from "./MachineTerminal.jsx";
import { MachineLogs } from "./MachineLogs.jsx";
import { ExportMachineDialog } from "./ExportMachineDialog.jsx";
import { MachineVncInfo } from "./MachineVncInfo.jsx";
import { EditNetworkDialog } from "./EditNetworkDialog.jsx";
import { EditResourcesDialog } from "./EditResourcesDialog.jsx";

const { gettext: _, format } = cockpit;

export function MachineActions({ machine, isAutostart, onAction, onAddNotification, onExpand, isExpanded }) {
    const [open, setOpen] = useState(false);
    const [showTerminal, setShowTerminal] = useState(false);
    const [showLogs, setShowLogs] = useState(false);
    const [showExport, setShowExport] = useState(false);
    const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
    const [showVnc, setShowVnc] = useState(false);
    const [showEditNetwork, setShowEditNetwork] = useState(false);
    const [showEditResources, setShowEditResources] = useState(false);

    const isRunning = machine.state === "running";
    const name = machine.machine;

    const doAction = (action) => {
        setOpen(false);
        onAction(action, name);
    };

    return (
        <>
            <Dropdown
                isOpen={open}
                onOpenChange={setOpen}
                toggle={(toggleRef) => (
                    <MenuToggle
                        ref={toggleRef}
                        variant="plain"
                        onClick={() => setOpen(!open)}
                        aria-label={format(_("Actions for $0"), name)}
                    >
                        <EllipsisVIcon />
                    </MenuToggle>
                )}
                popperProps={{ position: "right" }}
            >
                <DropdownList>
                    {!isRunning && (
                        <DropdownItem key="start" onClick={() => doAction("start")}>
                            {_("Start")}
                        </DropdownItem>
                    )}
                    {isRunning && (
                        <DropdownItem key="stop" onClick={() => doAction("stop")}>
                            {_("Stop")}
                        </DropdownItem>
                    )}
                    {isRunning && (
                        <DropdownItem key="terminate" onClick={() => doAction("terminate")}>
                            {_("Force stop")}
                        </DropdownItem>
                    )}
                    {isRunning && (
                        <>
                            <Divider />
                            <DropdownItem
                                key="terminal"
                                onClick={() => { setOpen(false); setShowTerminal(true); }}
                            >
                                {_("Open terminal")}
                            </DropdownItem>
                            <DropdownItem
                                key="vnc"
                                onClick={() => { setOpen(false); setShowVnc(true); }}
                            >
                                {_("Open display…")}
                            </DropdownItem>
                        </>
                    )}
                    <Divider />
                    <DropdownItem
                        key="autostart"
                        onClick={() => doAction(isAutostart ? "autostart-disable" : "autostart-enable")}
                    >
                        {isAutostart ? _("Disable autostart") : _("Enable autostart")}
                    </DropdownItem>
                    <DropdownItem
                        key="logs"
                        onClick={() => { setOpen(false); setShowLogs(true); }}
                    >
                        {_("Show logs")}
                    </DropdownItem>
                    <DropdownItem
                        key="export"
                        onClick={() => { setOpen(false); setShowExport(true); }}
                    >
                        {_("Export…")}
                    </DropdownItem>
                    <DropdownItem
                        key="details"
                        onClick={() => { setOpen(false); onExpand(); }}
                    >
                        {isExpanded ? _("Hide details") : _("Show details")}
                    </DropdownItem>
                    {!isRunning && (
                        <>
                            <Divider />
                            <DropdownItem
                                key="edit-network"
                                onClick={() => { setOpen(false); setShowEditNetwork(true); }}
                            >
                                {_("Change network…")}
                            </DropdownItem>
                            <DropdownItem
                                key="edit-resources"
                                onClick={() => { setOpen(false); setShowEditResources(true); }}
                            >
                                {_("Resource limits…")}
                            </DropdownItem>
                        </>
                    )}
                    {!isRunning && (
                        <>
                            <Divider />
                            <DropdownItem
                                key="remove"
                                onClick={() => { setOpen(false); setShowRemoveConfirm(true); }}
                                style={{ color: "#c9190b" }}
                            >
                                {_("Remove")}
                            </DropdownItem>
                        </>
                    )}
                </DropdownList>
            </Dropdown>

            {showTerminal && (
                <MachineTerminal
                    machineName={name}
                    onClose={() => setShowTerminal(false)}
                />
            )}

            {showLogs && (
                <MachineLogs
                    machineName={name}
                    onClose={() => setShowLogs(false)}
                    onAddNotification={onAddNotification}
                />
            )}

            {showVnc && (
                <MachineVncInfo
                    machine={machine}
                    onClose={() => setShowVnc(false)}
                />
            )}

            {showEditNetwork && (
                <EditNetworkDialog
                    machineName={name}
                    onClose={() => setShowEditNetwork(false)}
                />
            )}

            {showEditResources && (
                <EditResourcesDialog
                    machineName={name}
                    onClose={() => setShowEditResources(false)}
                />
            )}

            {showExport && (
                <ExportMachineDialog
                    machineName={name}
                    onClose={() => setShowExport(false)}
                />
            )}

            {showRemoveConfirm && (
                <Modal
                    isOpen
                    onClose={() => setShowRemoveConfirm(false)}
                    variant="small"
                >
                    <ModalHeader title={_("Remove container")} />
                    <ModalBody>
                        {format(_("Are you sure you want to remove $0? This action cannot be undone."), <strong>{name}</strong>)}
                    </ModalBody>
                    <ModalFooter>
                        <Button
                            variant="danger"
                            onClick={() => { setShowRemoveConfirm(false); doAction("remove"); }}
                        >
                            {_("Remove")}
                        </Button>
                        <Button variant="link" onClick={() => setShowRemoveConfirm(false)}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}
        </>
    );
}
