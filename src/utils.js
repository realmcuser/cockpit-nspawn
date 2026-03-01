/* SPDX-License-Identifier: LGPL-2.1-or-later */

import cockpit from 'cockpit';

export function spawnMachinectl(args, options = {}) {
    return cockpit.spawn(['machinectl', ...args], {
        superuser: 'require',
        err: 'message',
        ...options,
    });
}

export function parseMachinectlJson(output) {
    if (!output || output.trim() === '') return [];
    try {
        const data = JSON.parse(output);
        if (Array.isArray(data)) return data;
        const values = Object.values(data);
        return Array.isArray(values[0]) ? values[0] : values;
    } catch (e) {
        console.error('Kunde inte parsa machinectl JSON:', e, output);
        return [];
    }
}

export function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

export function primaryAddress(addresses) {
    if (!addresses) return null;
    const lines = addresses.split('\n').map(s => s.trim()).filter(Boolean);
    return lines.find(addr => !addr.includes(':')) || lines[0] || null;
}
