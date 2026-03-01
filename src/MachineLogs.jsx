import React, { useState, useEffect, useRef, useCallback } from "react";
import {
    Button,
    Modal,
    ModalHeader,
    ModalBody,
    ModalFooter,
    Select,
    SelectOption,
    MenuToggle,
    Toolbar,
    ToolbarContent,
    ToolbarItem,
    Badge,
} from "@patternfly/react-core";

import cockpit from "cockpit";

const { gettext: _, ngettext, format } = cockpit;

const PRIORITIES = [
    { value: "all", label: _("All levels") },
    { value: "0", label: _("Emergency (0)") },
    { value: "1", label: _("Alert (1)") },
    { value: "2", label: _("Critical (2)") },
    { value: "3", label: _("Error (3)") },
    { value: "4", label: _("Warning (4)") },
    { value: "6", label: _("Info (6)") },
    { value: "7", label: _("Debug (7)") },
];

const PRIORITY_COLORS = {
    0: "#c9190b",
    1: "#c9190b",
    2: "#c9190b",
    3: "#c9190b",
    4: "#f0ab00",
    5: "#f0ab00",
    6: "#6a6e73",
    7: "#8a8d90",
};

function logColor(priority) {
    return PRIORITY_COLORS[priority] || "#6a6e73";
}

function formatLogLine(entry) {
    try {
        const parsed = JSON.parse(entry);
        const ts = parsed.__REALTIME_TIMESTAMP
            ? new Date(parseInt(parsed.__REALTIME_TIMESTAMP) / 1000).toLocaleTimeString()
            : "";
        const prio = parseInt(parsed.PRIORITY || "6");
        const msg = parsed.MESSAGE || "";
        const unit = parsed._SYSTEMD_UNIT || "";
        return { ts, prio, msg, unit };
    } catch {
        return { ts: "", prio: 6, msg: entry, unit: "" };
    }
}

export function MachineLogs({ machineName, onClose, onAddNotification }) {
    const [logs, setLogs] = useState([]);
    const [priority, setPriority] = useState("all");
    const [priorityOpen, setPriorityOpen] = useState(false);
    const [following, setFollowing] = useState(true);
    const logRef = useRef(null);
    const procRef = useRef(null);

    const startStreaming = useCallback(() => {
        if (procRef.current) {
            procRef.current.close();
        }

        const args = ["journalctl", "-M", machineName, "-n", "200", "--output=json", "--no-pager"];
        if (following) {
            args.push("-f");
        }
        if (priority !== "all") {
            args.push("-p", priority);
        }

        const proc = cockpit.spawn(args, { superuser: "require", err: "message" });
        procRef.current = proc;

        let buffer = "";

        proc.stream(data => {
            buffer += data;
            const lines = buffer.split("\n");
            buffer = lines.pop();

            const parsed = lines
                .filter(l => l.trim())
                .map(formatLogLine);

            setLogs(prev => [...prev.slice(-500), ...parsed]);
        });

        proc.catch(ex => {
            if (ex.message && !ex.message.includes("terminated")) {
                onAddNotification({
                    type: "warning",
                    title: format(_("Log error for $0"), machineName),
                    detail: ex.message,
                });
            }
        });
    }, [machineName, priority, following, onAddNotification]);

    useEffect(() => {
        setLogs([]);
        startStreaming();
        return () => {
            if (procRef.current) procRef.current.close();
        };
    }, [startStreaming]);

    useEffect(() => {
        if (following && logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [logs, following]);

    const filteredLogs = priority === "all"
        ? logs
        : logs.filter(l => l.prio <= parseInt(priority));

    const lineCountLabel = format(ngettext("$0 line", "$0 lines", filteredLogs.length), filteredLogs.length);

    return (
        <Modal
            isOpen
            onClose={onClose}
            variant="large"
            aria-label={format(_("Logs for $0"), machineName)}
        >
            <ModalHeader title={format(_("Logs — $0"), machineName)} />
            <ModalBody>
                <Toolbar style={{ paddingBottom: "0.5rem" }}>
                    <ToolbarContent>
                        <ToolbarItem>
                            <Select
                                isOpen={priorityOpen}
                                onOpenChange={setPriorityOpen}
                                selected={priority}
                                onSelect={(_e, val) => {
                                    setPriority(val);
                                    setPriorityOpen(false);
                                }}
                                toggle={(ref) => (
                                    <MenuToggle ref={ref} onClick={() => setPriorityOpen(!priorityOpen)}>
                                        {PRIORITIES.find(p => p.value === priority)?.label || _("All levels")}
                                    </MenuToggle>
                                )}
                            >
                                {PRIORITIES.map(p => (
                                    <SelectOption key={p.value} value={p.value}>{p.label}</SelectOption>
                                ))}
                            </Select>
                        </ToolbarItem>
                        <ToolbarItem>
                            <Button
                                variant={following ? "primary" : "secondary"}
                                onClick={() => setFollowing(!following)}
                            >
                                {following ? _("Following real time") : _("Follow real time")}
                            </Button>
                        </ToolbarItem>
                        <ToolbarItem>
                            <Button variant="secondary" onClick={() => setLogs([])}>
                                {_("Clear")}
                            </Button>
                        </ToolbarItem>
                        <ToolbarItem align={{ default: "alignRight" }}>
                            <Badge>{lineCountLabel}</Badge>
                        </ToolbarItem>
                    </ToolbarContent>
                </Toolbar>

                <div
                    ref={logRef}
                    style={{
                        background: "#1e1e1e",
                        color: "#d4d4d4",
                        fontFamily: "monospace",
                        fontSize: "0.82em",
                        padding: "1rem",
                        height: "400px",
                        overflowY: "auto",
                        borderRadius: "4px",
                    }}
                >
                    {filteredLogs.length === 0 && (
                        <span style={{ color: "#6a6e73" }}>{_("Waiting for logs...")}</span>
                    )}
                    {filteredLogs.map((log, i) => (
                        <div key={i} style={{ lineHeight: "1.5", borderBottom: "1px solid #2d2d2d" }}>
                            <span style={{ color: "#569cd6", marginRight: "0.5rem" }}>
                                {log.ts}
                            </span>
                            {log.unit && (
                                <span style={{ color: "#9cdcfe", marginRight: "0.5rem" }}>
                                    [{log.unit}]
                                </span>
                            )}
                            <span style={{ color: logColor(log.prio) }}>
                                {log.msg}
                            </span>
                        </div>
                    ))}
                </div>
            </ModalBody>
            <ModalFooter>
                <Button variant="link" onClick={onClose}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
}
