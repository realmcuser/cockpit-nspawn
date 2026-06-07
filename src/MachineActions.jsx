import React, { useState } from "react";
import {
    Alert,
    Button,
    Dropdown,
    DropdownItem,
    DropdownList,
    Form,
    FormGroup,
    MenuToggle,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Divider,
    TextInput,
} from "@patternfly/react-core";
import { EllipsisVIcon } from "@patternfly/react-icons";

import cockpit from "cockpit";
import { MachineTerminal } from "./MachineTerminal.jsx";
import { MachineLogs } from "./MachineLogs.jsx";
import { ExportMachineDialog } from "./ExportMachineDialog.jsx";
import { MachineRdpInfo } from "./MachineRdpInfo.jsx";
import { EditNetworkDialog } from "./EditNetworkDialog.jsx";
import { EditResourcesDialog } from "./EditResourcesDialog.jsx";
import { BackupDialog } from "./BackupDialog.jsx";
import { RestoreDialog } from "./RestoreDialog.jsx";
import { NspawnConfigDialog } from "./NspawnConfigDialog.jsx";
import { InstallCockpitDialog } from "./InstallCockpitDialog.jsx";

const { gettext: _, format } = cockpit;

export function MachineActions({ machine, isAutostart, onAction, onAddNotification, onExpand, isExpanded, onRefresh }) {
    const [open, setOpen] = useState(false);
    const [showTerminal, setShowTerminal] = useState(false);
    const [showLogs, setShowLogs] = useState(false);
    const [showExport, setShowExport] = useState(false);
    const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
    const [showRdp, setShowRdp] = useState(false);
    const [showEditNetwork, setShowEditNetwork] = useState(false);
    const [showEditResources, setShowEditResources] = useState(false);
    const [showBackup, setShowBackup] = useState(false);
    const [showRestore, setShowRestore] = useState(false);
    const [showNspawnConfig, setShowNspawnConfig] = useState(false);
    const [showInstallCockpit, setShowInstallCockpit] = useState(false);
    const [showRename, setShowRename] = useState(false);
    const [renameTo, setRenameTo] = useState('');
    const [renaming, setRenaming] = useState(false);
    const [renameError, setRenameError] = useState(null);

    const isRunning = machine.state === "running";
    const name = machine.machine;

    const doAction = (action) => {
        setOpen(false);
        onAction(action, name);
    };

    const doRename = async () => {
        setRenaming(true);
        setRenameError(null);
        const newName = renameTo.trim();
        try {
            await cockpit.spawn(
                ['mv', `/var/lib/machines/${name}`, `/var/lib/machines/${newName}`],
                { superuser: 'require', err: 'message' }
            );
            // Rename .nspawn config if it exists
            await cockpit.spawn(['test', '-f', `/etc/systemd/nspawn/${name}.nspawn`], { superuser: 'require' })
                .then(() => cockpit.spawn(['mv',
                    `/etc/systemd/nspawn/${name}.nspawn`,
                    `/etc/systemd/nspawn/${newName}.nspawn`],
                { superuser: 'require' }))
                .catch(() => {});
            // Move backup config if it exists
            await cockpit.spawn(['test', '-f', `/etc/cockpit-nspawn/backup/${name}.json`], { superuser: 'require' })
                .then(() => cockpit.spawn(['mv',
                    `/etc/cockpit-nspawn/backup/${name}.json`,
                    `/etc/cockpit-nspawn/backup/${newName}.json`],
                { superuser: 'require' }))
                .catch(() => {});
            // Stop and remove old backup timer/service so it doesn't run for the old name
            await cockpit.spawn(['systemctl', 'stop', `cockpit-nspawn-backup-${name}.timer`],
                { superuser: 'require', err: 'ignore' }).catch(() => {});
            await cockpit.spawn(['systemctl', 'disable', `cockpit-nspawn-backup-${name}.timer`],
                { superuser: 'require', err: 'ignore' }).catch(() => {});
            await cockpit.spawn(['rm', '-f',
                `/etc/systemd/system/cockpit-nspawn-backup-${name}.timer`,
                `/etc/systemd/system/cockpit-nspawn-backup-${name}.service`],
            { superuser: 'require', err: 'ignore' }).catch(() => {});
            // Update autostart
            if (isAutostart) {
                await cockpit.spawn(['machinectl', 'disable', name], { superuser: 'require', err: 'ignore' }).catch(() => {});
                await cockpit.spawn(['machinectl', 'enable', newName], { superuser: 'require', err: 'ignore' }).catch(() => {});
            }
            await cockpit.spawn(['systemctl', 'daemon-reload'], { superuser: 'require' });
            onAddNotification({ type: 'success', title: format(_("$0 renamed to $1"), name, newName) });
            setShowRename(false);
            onRefresh();
        } catch (ex) {
            setRenameError(ex.message || _("Rename failed"));
            setRenaming(false);
        }
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
                                key="rdp"
                                onClick={() => { setOpen(false); setShowRdp(true); }}
                            >
                                {_("Open display…")}
                            </DropdownItem>
                            {machine.os !== 'debian' && machine.os !== 'ubuntu' && (
                                <DropdownItem
                                    key="install-cockpit"
                                    onClick={() => { setOpen(false); setShowInstallCockpit(true); }}
                                >
                                    {_("Install Cockpit…")}
                                </DropdownItem>
                            )}
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
                        key="backup"
                        onClick={() => { setOpen(false); setShowBackup(true); }}
                    >
                        {_("Backup…")}
                    </DropdownItem>
                    <DropdownItem
                        key="restore"
                        onClick={() => { setOpen(false); setShowRestore(true); }}
                    >
                        {_("Restore…")}
                    </DropdownItem>
                    <DropdownItem
                        key="nspawn-config"
                        onClick={() => { setOpen(false); setShowNspawnConfig(true); }}
                    >
                        {_("Edit config…")}
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
                                key="rename"
                                onClick={() => { setOpen(false); setRenameTo(name); setRenameError(null); setShowRename(true); }}
                            >
                                {_("Rename…")}
                            </DropdownItem>
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

            {showRdp && (
                <MachineRdpInfo
                    machine={machine}
                    onClose={() => setShowRdp(false)}
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

            {showBackup && (
                <BackupDialog
                    machineName={name}
                    onClose={() => setShowBackup(false)}
                    onAddNotification={onAddNotification}
                />
            )}

            {showRestore && (
                <RestoreDialog
                    machineName={name}
                    machineState={machine.state}
                    onClose={() => setShowRestore(false)}
                    onAddNotification={onAddNotification}
                    onRefresh={onRefresh}
                />
            )}

            {showNspawnConfig && (
                <NspawnConfigDialog
                    machineName={name}
                    machineState={machine.state}
                    onClose={() => setShowNspawnConfig(false)}
                    onAddNotification={onAddNotification}
                />
            )}

            {showInstallCockpit && (
                <InstallCockpitDialog
                    machineName={name}
                    onClose={() => setShowInstallCockpit(false)}
                    onAddNotification={onAddNotification}
                />
            )}

            {showRename && (
                <Modal isOpen onClose={() => !renaming && setShowRename(false)} variant="small">
                    <ModalHeader title={format(_("Rename: $0"), name)} />
                    <ModalBody>
                        <Form>
                            <FormGroup label={_("New name")} fieldId="rename-input" isRequired>
                                <TextInput
                                    id="rename-input"
                                    value={renameTo}
                                    onChange={(_e, v) => setRenameTo(v)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && renameTo.trim() && renameTo.trim() !== name) doRename(); }}
                                    isDisabled={renaming}
                                    autoFocus
                                />
                            </FormGroup>
                        </Form>
                        {renameError && (
                            <Alert variant="danger" isInline title={renameError} style={{ marginTop: '1rem' }} />
                        )}
                    </ModalBody>
                    <ModalFooter>
                        <Button
                            variant="primary"
                            onClick={doRename}
                            isDisabled={!renameTo.trim() || renameTo.trim() === name || renaming}
                            isLoading={renaming}
                        >
                            {_("Rename")}
                        </Button>
                        <Button variant="link" onClick={() => setShowRename(false)} isDisabled={renaming}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
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
