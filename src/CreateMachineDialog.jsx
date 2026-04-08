/* SPDX-License-Identifier: LGPL-2.1-or-later */

import React, { useState, useRef, useEffect } from 'react';
import {
    Alert,
    Button,
    Checkbox,
    Form,
    FormGroup,
    FormHelperText,
    HelperText,
    HelperTextItem,
    FormSelect,
    FormSelectOption,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Popover,
    Radio,
    Spinner,
    TextInput,
} from '@patternfly/react-core';
import { HelpIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';
import { spawnMachinectl } from './utils.js';

const { gettext: _, format } = cockpit;

// ----------------------------------------------------------------
// Distro templates for DNF bootstrap — version is supplied at runtime
// ----------------------------------------------------------------
const DISTRO_TEMPLATES = {
    almalinux: {
        label: 'AlmaLinux',
        defaultVersion: '10',
        repoArgs: (v) => [
            '--disablerepo=*',
            `--repofrompath=alma-baseos,https://repo.almalinux.org/almalinux/${v}/BaseOS/x86_64/os/`,
            `--repofrompath=alma-appstream,https://repo.almalinux.org/almalinux/${v}/AppStream/x86_64/os/`,
            '--enablerepo=alma-baseos',
            '--enablerepo=alma-appstream',
        ],
        // systemd-udev %triggerin scriptlets run via host dynamic linker during
        // installroot and fail on version mismatch. Not needed in containers.
        // Skip RPM scriptlets during installroot — they run in host context and
        // fail on systemd version mismatches. First container boot handles init.
        // noscripts = %pre/%post/%preun/%postun, notriggers = %triggerin/%triggerout
        // noscripts   = %pre/%post/%preun/%postun/%pretrans/%posttrans
        // notriggers  = %triggerin/%triggerout and all trigger variants
        // nocontexts  = skip SELinux file context setting (fails in installroot — no policy yet)
        // nocaps      = skip POSIX capability setting (may fail in installroot context)
        extraArgs: ['--setopt=tsflags=noscripts,notriggers,nocontexts,nocaps'],
        authselectProfile: 'local',
        packages: () => [
            'systemd', 'passwd', 'dnf', 'coreutils', 'sudo',
            'almalinux-release', 'almalinux-repos',
            'NetworkManager', 'iputils', 'iproute', 'hostname',
            'openssh-server',
            'vim-minimal', 'less',
        ],
    },
    fedora: {
        label: 'Fedora',
        defaultVersion: '43',
        repoArgs: (v) => [
            '--disablerepo=*',
            `--repofrompath=bs-fedora,https://dl.fedoraproject.org/pub/fedora/linux/releases/${v}/Everything/x86_64/os/`,
            `--repofrompath=bs-updates,https://dl.fedoraproject.org/pub/fedora/linux/updates/${v}/Everything/x86_64/`,
            '--enablerepo=bs-fedora',
            '--enablerepo=bs-updates',
        ],
        // Skip RPM scriptlets during installroot — they run in host context and
        // fail on systemd version mismatches. First container boot handles init.
        // noscripts = %pre/%post/%preun/%postun, notriggers = %triggerin/%triggerout
        // noscripts   = %pre/%post/%preun/%postun/%pretrans/%posttrans
        // notriggers  = %triggerin/%triggerout and all trigger variants
        // nocontexts  = skip SELinux file context setting (fails in installroot — no policy yet)
        // nocaps      = skip POSIX capability setting (may fail in installroot context)
        extraArgs: ['--setopt=tsflags=noscripts,notriggers,nocontexts,nocaps'],
        authselectProfile: 'local',
        packages: () => [
            'systemd', 'passwd', 'dnf', 'coreutils', 'sudo',
            'fedora-release', 'fedora-repos',
            'NetworkManager', 'iputils', 'iproute', 'hostname',
            'openssh-server',
            'vim-minimal', 'less',
        ],
    },
};

// ----------------------------------------------------------------
// Desktop environment configuration — installed inside the running
// container after bootstrap, so scriptlets run correctly.
// ----------------------------------------------------------------
const DESKTOP_CONFIG = {
    xfce: {
        startCommand: 'startxfce4',
        epelFirst: { almalinux: true, fedora: false },
        crbFirst: { almalinux: true, fedora: false },
        // xrdp + XFCE not yet available in EPEL 10 (as of early 2026)
        isAvailable: (distro, version) => !(distro === 'almalinux' && Number(version) >= 10),
        packages: [
            'xrdp', 'xorgxrdp',
            'xfce4-session', 'xfwm4', 'xfce4-panel',
            'xfdesktop', 'xfce4-terminal',
        ],
    },
    kde: {
        startCommand: 'startplasma-x11',
        epelFirst: { almalinux: true, fedora: false },
        crbFirst: { almalinux: true, fedora: false },
        // KDE Plasma 6 (Fedora 40+) is Wayland-only — no startplasma-x11, incompatible with xrdp
        // KDE not yet available in EPEL 10 (as of early 2026)
        isAvailable: (distro, version) => {
            if (distro === 'almalinux' && Number(version) >= 10) return false;
            if (distro === 'fedora' && Number(version) >= 40) return false;
            return true;
        },
        almalinuxWarning: true,
        packages: [
            'xrdp', 'xorgxrdp',
            'plasma-desktop', 'plasma-workspace',
            'kde-settings-plasma', 'konsole',
        ],
    },
    gnome: {
        startCommand: 'gnome-session',
        epelFirst: { almalinux: true, fedora: false },
        crbFirst: { almalinux: true, fedora: false },
        // xrdp + GNOME not yet available in EPEL 10; GNOME 47+ (Fedora 40+) is Wayland-only
        isAvailable: (distro, version) => {
            if (distro === 'almalinux' && Number(version) >= 10) return false;
            if (distro === 'fedora' && Number(version) >= 40) return false;
            return true;
        },
        packages: [
            'xrdp', 'xorgxrdp',
            'gnome-session', 'gnome-shell', 'gnome-terminal',
        ],
    },
    weston: {
        westonMode: true,
        epelFirst: { almalinux: false, fedora: false },
        crbFirst: { almalinux: false, fedora: false },
        // Weston: standalone Wayland compositor with built-in RDP server (FreeRDP).
        // Only offered for Fedora 40+ where X11-based DEs (xrdp) are no longer viable.
        isAvailable: (distro, version) => distro === 'fedora' && Number(version) >= 40,
        packages: ['weston', 'openssl'],
    },
    kde_vnc: {
        kdeVncMode: true,
        epelFirst: { almalinux: false, fedora: false },
        crbFirst: { almalinux: false, fedora: false },
        // KDE Plasma 6 (Fedora 40+) is Wayland-only. Uses labwc (wlroots compositor)
        // + wayvnc for headless VNC access without a GPU or physical display.
        isAvailable: (distro, version) => distro === 'fedora' && Number(version) >= 40,
        packages: ['@kde-desktop', 'labwc', 'wayvnc', 'wlr-randr', 'pipewire', 'wireplumber'],
    },
};

// XKB keyboard layouts offered in the KDE VNC bootstrap dialog.
// Labels are intentionally not translated — keyboard layout names are
// internationally understood proper nouns (Swedish, German, French, …).
const KEYBOARD_LAYOUTS = [
    { value: 'bg', label: 'Bulgarian (bg)' },
    { value: 'hr', label: 'Croatian (hr)' },
    { value: 'cz', label: 'Czech (cz)' },
    { value: 'dk', label: 'Danish (dk)' },
    { value: 'nl', label: 'Dutch (nl)' },
    { value: 'gb', label: 'English / UK (gb)' },
    { value: 'us', label: 'English / US (us)' },
    { value: 'ee', label: 'Estonian (ee)' },
    { value: 'fi', label: 'Finnish (fi)' },
    { value: 'fr', label: 'French (fr)' },
    { value: 'de', label: 'German (de)' },
    { value: 'gr', label: 'Greek (gr)' },
    { value: 'hu', label: 'Hungarian (hu)' },
    { value: 'it', label: 'Italian (it)' },
    { value: 'lv', label: 'Latvian (lv)' },
    { value: 'lt', label: 'Lithuanian (lt)' },
    { value: 'no', label: 'Norwegian (no)' },
    { value: 'pl', label: 'Polish (pl)' },
    { value: 'pt', label: 'Portuguese (pt)' },
    { value: 'ro', label: 'Romanian (ro)' },
    { value: 'sk', label: 'Slovak (sk)' },
    { value: 'si', label: 'Slovenian (si)' },
    { value: 'es', label: 'Spanish (es)' },
    { value: 'se', label: 'Swedish (se)' },
];

function detectFormat(url) {
    const u = url.toLowerCase();
    if (u.match(/\.(raw|img)(\.gz|\.xz|\.bz2)?(\?.*)?$/)) return 'raw';
    return 'tar';
}

// ----------------------------------------------------------------

export function CreateMachineDialog({ images, onClose, onRefresh, onAddNotification }) {
    const [type, setType] = useState('bootstrap');

    // Pull state
    const [url, setUrl] = useState('');
    const [pullFormat, setPullFormat] = useState('auto');
    const [pullName, setPullName] = useState('');

    // Clone state
    const [source, setSource] = useState(images[0]?.name || '');
    const [cloneName, setCloneName] = useState('');

    // Bootstrap state
    const [bootName, setBootName] = useState('');
    const [distro, setDistro] = useState('almalinux');
    const [version, setVersion] = useState('10');
    const [rootPassword, setRootPassword] = useState('');
    const [network, setNetwork] = useState('private');
    const [bridgeName, setBridgeName] = useState('bridge0');
    const [betaRelease, setBetaRelease] = useState(false);
    const [desktop, setDesktop] = useState('none');
    const [kbdLayout, setKbdLayout] = useState('se');
    const [memoryMax, setMemoryMax] = useState('');
    const [cpuQuota, setCpuQuota] = useState('');
    const [autoStart, setAutoStart] = useState(true);
    const [autoEnable, setAutoEnable] = useState(false);

    // Running / output
    const [running, setRunning] = useState(false);
    const [done, setDone] = useState(false);
    const [output, setOutput] = useState('');
    const [error, setError] = useState(null);
    const outputRef = useRef(null);

    useEffect(() => {
        if (outputRef.current)
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }, [output]);

    const append = (text) => setOutput(prev => prev + text);

    const canSubmit = !running && (() => {
        if (type === 'pull') return url.trim() !== '';
        if (type === 'clone') return source !== '' && cloneName.trim() !== '';
        if (type === 'bootstrap') return bootName.trim() !== '';
        return false;
    })();

    const handleCreate = async () => {
        setRunning(true);
        setError(null);
        setOutput('');

        try {
            if (type === 'pull') {
                const fmt = pullFormat === 'auto' ? detectFormat(url) : pullFormat;
                const cmd = [`pull-${fmt}`, '--verify=no', url.trim()];
                if (pullName.trim()) cmd.push(pullName.trim());
                await spawnMachinectl(cmd).stream(append);
                onRefresh();
                onAddNotification({ type: 'success', title: _("Container created") });
                setDone(true);
                setRunning(false);
            } else if (type === 'clone') {
                await spawnMachinectl(['clone', source, cloneName.trim()]).stream(append);
                onRefresh();
                onAddNotification({ type: 'success', title: _("Container cloned") });
                setDone(true);
                setRunning(false);
            } else {
                await runBootstrap();
            }
        } catch (ex) {
            setError(ex.message || 'Okänt fel');
            setRunning(false);
        }
    };

    const runBootstrap = async () => {
        const name = bootName.trim();
        const machineRoot = `/var/lib/machines/${name}`;
        const template = DISTRO_TEMPLATES[distro];
        const osLabel = `${template.label} ${version}${betaRelease ? ' Beta' : ''}`;
        const repoArgs = (distro === 'fedora' && betaRelease)
            ? [
                '--disablerepo=*',
                `--repofrompath=bs-fedora,https://dl.fedoraproject.org/pub/fedora/linux/development/${version}/Everything/x86_64/os/`,
                '--enablerepo=bs-fedora',
            ]
            : template.repoArgs(version);

        try {
            // Step 1: create directory
            append(`=== Skapar ${machineRoot} ===\n`);
            await cockpit.spawn(['mkdir', '-p', machineRoot], { superuser: 'require', err: 'out' });

            // Step 2a: Install 'filesystem' first WITHOUT tsflags.
            // RPM 6.0 / dnf5 does not guarantee that 'filesystem' installs before
            // packages like 'libgcc' that write to /lib64/. Without filesystem's
            // %pretrans, /lib64 gets created as a real directory instead of the
            // required symlink to usr/lib64, causing the main transaction to fail.
            append(`\n=== Förbereder systemstruktur (filesystem) ===\n`);
            await cockpit.spawn(
                [
                    'dnf', 'install',
                    `--installroot=${machineRoot}`,
                    `--releasever=${version}`,
                    '--setopt=install_weak_deps=False',
                    '--nogpgcheck',
                    '--assumeyes',
                    ...repoArgs,
                    'filesystem',
                ],
                { superuser: 'require', err: 'out' }
            ).stream(append);

            // Step 2b: Install the full package set WITH tsflags.
            // Now that /lib64 -> usr/lib64 symlink exists, libgcc and others
            // install correctly. tsflags suppress host-incompatible scriptlets.
            append(`\n=== Bootstrappar ${osLabel} ===\n`);
            append('(Hämtar paket från internet — tar vanligen 2–5 minuter)\n\n');
            await cockpit.spawn(
                [
                    'dnf', 'install',
                    `--installroot=${machineRoot}`,
                    `--releasever=${version}`,
                    '--setopt=install_weak_deps=False',
                    '--nogpgcheck',
                    '--assumeyes',
                    ...repoArgs,
                    ...(template.extraArgs || []),
                    ...template.packages(version),
                ],
                { superuser: 'require', err: 'out' }
            ).stream(append);
            append('\n=== DNF install klar ===\n');

            // Step 2c: Post-install fixups that noscripts skipped.
            append('\n=== Post-install fixar ===\n');

            // Write releasever so dnf inside the container can resolve $releasever.
            // Needed when the host RPM (6.0 SQLite) has created a database that the
            // container's older RPM (4.x BDB/NDB) cannot read — dnf then cannot
            // determine the release version from installed packages.
            await cockpit.spawn(
                ['mkdir', '-p', `${machineRoot}/etc/dnf/vars`],
                { superuser: 'require' }
            );
            await cockpit.file(`${machineRoot}/etc/dnf/vars/releasever`, { superuser: 'require' })
                .replace(version + '\n');
            append(`releasever=${version} skriven till /etc/dnf/vars/releasever\n`);

            // Generate CA certificate bundle.
            // ca-certificates' %post runs update-ca-trust. Without it,
            // /etc/pki/tls/certs/ca-bundle.crt is missing → curl/dnf SSL errors.
            await cockpit.spawn(
                ['chroot', machineRoot, '/usr/bin/update-ca-trust'],
                { superuser: 'require', err: 'out' }
            );
            append('CA-certifikat klara.\n');

            // Step 3: Configure PAM via authselect FIRST.
            // noscripts skips authselect's %post which normally runs
            // "authselect select <profile>". Without this, system-auth and
            // postlogin are missing from /etc/pam.d/, causing both machinectl
            // shell and chpasswd to fail with PAM errors.
            append('\n=== Konfigurerar PAM (authselect) ===\n');
            const authProfile = template.authselectProfile || 'local';
            try {
                await cockpit.spawn(
                    ['chroot', machineRoot, '/usr/bin/authselect', 'select', authProfile, '--force'],
                    { superuser: 'require', err: 'out' }
                );
                append(`PAM konfigurerad med profil "${authProfile}".\n`);
            } catch (e) {
                append(`Varning: authselect misslyckades (${e.message}) — fortsätter ändå.\n`);
            }

            // Mask systemd-firstboot.service to prevent interactive boot blocking.
            // Some package sets (e.g. KDE on Fedora) write "!unprovisioned" to
            // root's shadow entry, causing systemd-firstboot to block boot entirely.
            try {
                await cockpit.spawn(
                    ['systemctl', '--root', machineRoot, 'mask', 'systemd-firstboot.service'],
                    { superuser: 'require', err: 'out' }
                );
            } catch (maskErr) {
                append(`Varning: kunde inte maskas systemd-firstboot (${maskErr.message}).\n`);
            }

            // Step 4: set root password.
            // Generate SHA-512 hash via openssl and write directly to /etc/shadow.
            // Pass password via stdin to handle special characters safely.
            // Ensure /etc/shadow exists first (sysusers may not create it).
            const shadowPath = `${machineRoot}/etc/shadow`;

            // Neutralize "!unprovisioned" shadow entry — some package sets (e.g. KDE)
            // write this marker, causing systemd-firstboot to block boot waiting for input.
            try {
                await cockpit.spawn(
                    ['sed', '-i', 's/^root:!unprovisioned:/root:!:/', shadowPath],
                    { superuser: 'require', err: 'out' }
                );
            } catch (shadowNormErr) { /* shadow may not exist yet */ }

            if (rootPassword) {
                append('\n=== Sätter root-lösenord ===\n');

                // Ensure /etc/shadow exists — write minimal entry if absent
                try {
                    await cockpit.spawn(['test', '-f', shadowPath], { superuser: 'require' });
                } catch (noShadow) {
                    append('Skapar /etc/shadow...\n');
                    await cockpit.file(shadowPath, { superuser: 'require' })
                        .replace('root:!:19000:0:99999:7:::\n');
                }

                // Generate SHA-512 hash via openssl and write to /etc/shadow.
                // Pass password via temp file — stdin approach hangs with superuser.
                const tmpFile = '/tmp/.cockpit-nspawn-pw';
                try {
                    await cockpit.file(tmpFile, { superuser: 'require' }).replace(rootPassword);
                    await cockpit.spawn(['chmod', '600', tmpFile], { superuser: 'require' });
                    const hash = await cockpit.spawn(
                        ['/bin/bash', '-c', 'openssl passwd -6 -stdin < "$1"', '--', tmpFile],
                        { superuser: 'require', err: 'out' }
                    );
                    await cockpit.spawn(
                        ['sed', '-i', `s|^root:[^:]*:|root:${hash.trim()}:|`, shadowPath],
                        { superuser: 'require', err: 'out' }
                    );
                    append('Root-lösenord satt.\n');
                } catch (pwErr) {
                    append(`Varning: kunde inte sätta lösenord (${pwErr.message}) — sätt det manuellt.\n`);
                } finally {
                    await cockpit.spawn(['rm', '-f', tmpFile], { superuser: 'require' }).catch(() => {});
                }
            }

            // Step 4: write .nspawn config
            append('\n=== Skriver nspawn-konfiguration ===\n');
            await cockpit.spawn(['mkdir', '-p', '/etc/systemd/nspawn'], { superuser: 'require', err: 'out' });

            const nspawnLines = [
                '[Exec]',
                'Boot=yes',
                '',
                '[Network]',
                network === 'bridge' ? `Bridge=${bridgeName.trim()}` : 'Bridge=br-nspawn',
                '',
            ];
            if (memoryMax.trim() || cpuQuota.trim()) {
                nspawnLines.push('[Resource]');
                if (memoryMax.trim()) nspawnLines.push(`MemoryMax=${memoryMax.trim()}`);
                if (cpuQuota.trim()) nspawnLines.push(`CPUQuota=${cpuQuota.trim()}`);
                nspawnLines.push('');
            }
            const nspawnContent = nspawnLines.join('\n');

            await cockpit.file(`/etc/systemd/nspawn/${name}.nspawn`, { superuser: 'require' })
                .replace(nspawnContent);
            append(`Konfiguration: /etc/systemd/nspawn/${name}.nspawn\n`);

            // NAT host-side setup — idempotent, safe to repeat.
            // Uses NetworkManager's built-in "shared" mode: assigns IP, runs dnsmasq
            // for DHCP, and adds masquerade. Works on Fedora, AlmaLinux 9 and 10
            // without any extra packages — NetworkManager is always present.
            if (network === 'private') {
                append('\n=== Konfigurerar NAT-nätverk på hosten (körs en gång) ===\n');

                // Enable persistent IP forwarding
                await cockpit.file('/etc/sysctl.d/90-nspawn-nat.conf', { superuser: 'require' })
                    .replace('net.ipv4.ip_forward = 1\n');
                await cockpit.spawn(
                    ['sysctl', '-p', '/etc/sysctl.d/90-nspawn-nat.conf'],
                    { superuser: 'require', err: 'out' }
                ).stream(append);

                // Create shared NAT bridge via NetworkManager if not already present
                let natBridgeExists = false;
                try {
                    await cockpit.spawn(
                        ['nmcli', '-t', 'con', 'show', 'cockpit-nspawn'],
                        { superuser: 'require', err: 'out' }
                    );
                    natBridgeExists = true;
                    append('NAT-brygga br-nspawn finns redan.\n');
                } catch (checkErr) { /* doesn't exist yet */ }

                if (!natBridgeExists) {
                    await cockpit.spawn(
                        ['nmcli', 'con', 'add', 'type', 'bridge',
                         'con-name', 'cockpit-nspawn', 'ifname', 'br-nspawn'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);
                    await cockpit.spawn(
                        ['nmcli', 'con', 'modify', 'cockpit-nspawn',
                         'ipv4.method', 'shared',
                         'ipv4.addresses', '10.99.0.1/24',
                         'connection.autoconnect', 'yes'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);
                    await cockpit.spawn(
                        ['nmcli', 'con', 'up', 'cockpit-nspawn'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);
                    append('NAT-brygga br-nspawn skapad: 10.99.0.1/24 (DHCP + masquerade via NetworkManager).\n');
                }
            }

            // Step 5: daemon-reload
            append('\n=== Reloadar systemd ===\n');
            await cockpit.spawn(['systemctl', 'daemon-reload'], { superuser: 'require', err: 'out' });
            append('daemon-reload klar.\n');

            // Step 6: optional enable autostart
            if (autoEnable) {
                append(`\n=== Aktiverar autostart för ${name} ===\n`);
                await spawnMachinectl(['enable', name]).stream(append);
            }

            // Step 7: optional start
            if (autoStart) {
                append(`\n=== Startar ${name} ===\n`);
                await spawnMachinectl(['start', name]).stream(append);
            }

            // Step 8: install desktop environment inside the running container.
            // Done post-boot so that DNF scriptlets (icon caches, dbus, glib-schemas
            // etc.) run correctly inside the container rather than in the installroot.
            if (desktop !== 'none' && autoStart) {
                const deCfg = DESKTOP_CONFIG[desktop];
                append(`\n=== Installerar skrivbordsmiljö (${desktop.toUpperCase()}) ===\n`);
                append('(Kan ta 5–15 minuter — hämtar paket från internet)\n\n');

                // Wait for container systemd to finish initializing
                append('Väntar på att containerns systemd ska vara klart...\n');
                let systemdReady = false;
                for (let i = 0; i < 60; i++) {
                    try {
                        const st = await cockpit.spawn(
                            ['systemctl', `--machine=${name}`, 'is-system-running'],
                            { superuser: 'require', err: 'out' }
                        );
                        if (st.trim() === 'running' || st.trim() === 'degraded') {
                            systemdReady = true;
                            break;
                        }
                    } catch (waitErr) { /* not ready yet */ }
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (!systemdReady)
                    append('Varning: systemd verkar inte klart — fortsätter ändå.\n');

                // Install EPEL if needed — also required when crbFirst is set,
                // because /usr/bin/crb is provided by epel-release
                if (deCfg.epelFirst?.[distro] || deCfg.crbFirst?.[distro]) {
                    append('Installerar EPEL...\n');
                    await cockpit.spawn(
                        ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                         'dnf', 'install', '-y', 'epel-release'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);
                }

                // Enable CRB via /usr/bin/crb (provided by epel-release on AlmaLinux)
                if (deCfg.crbFirst?.[distro]) {
                    append('Aktiverar CRB-repo...\n');
                    await cockpit.spawn(
                        ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                         '/usr/bin/crb', 'enable'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);
                }

                // Install DE packages inside the running container
                await cockpit.spawn(
                    ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                     'dnf', 'install', '-y', ...deCfg.packages],
                    { superuser: 'require', err: 'out' }
                ).stream(append);

                if (deCfg.westonMode) {
                    // Generate self-signed TLS cert for Weston's FreeRDP backend
                    append('Genererar TLS-certifikat för Weston RDP...\n');
                    await cockpit.spawn(
                        ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                         'openssl', 'req', '-x509', '-newkey', 'rsa:2048',
                         '-keyout', '/etc/weston-rdp-tls.key',
                         '-out', '/etc/weston-rdp-tls.crt',
                         '-days', '3650', '-nodes', '-subj', '/CN=weston-rdp'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);

                    // Write weston-rdp.service
                    const westonService = [
                        '[Unit]',
                        'Description=Weston RDP compositor',
                        'After=network.target',
                        '',
                        '[Service]',
                        'Type=simple',
                        'User=root',
                        'Environment=XDG_RUNTIME_DIR=/run/user/0',
                        'Environment=HOME=/root',
                        'ExecStartPre=/bin/mkdir -p /run/user/0',
                        'ExecStart=/usr/bin/weston --backend=rdp --rdp-tls-cert=/etc/weston-rdp-tls.crt --rdp-tls-key=/etc/weston-rdp-tls.key --port=3389 --width=1920 --height=1080 --no-resizeable',
                        'Restart=on-failure',
                        '',
                        '[Install]',
                        'WantedBy=multi-user.target',
                        '',
                    ].join('\n');
                    await cockpit.file(
                        `/var/lib/machines/${name}/etc/systemd/system/weston-rdp.service`,
                        { superuser: 'require' }
                    ).replace(westonService);

                    // Enable and start weston-rdp
                    await cockpit.spawn(
                        ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                         'systemctl', 'enable', '--now', 'weston-rdp'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);

                    append(`\nWeston RDP-server kör på port 3389.\n`);
                } else if (deCfg.kdeVncMode) {
                    // ---- KDE Plasma headless VNC via labwc + wayvnc ----
                    // Architecture: labwc (wlroots headless compositor) + plasmashell
                    // + wayvnc (VNC server using wlr-screencopy). No GPU needed.
                    // kdeuser (uid 1000) owns the session. Port 5900.

                    // Create kdeuser
                    append('Skapar kdeuser...\n');
                    try {
                        await cockpit.spawn(
                            ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                             'useradd', '-m', '-s', '/bin/bash', 'kdeuser'],
                            { superuser: 'require', err: 'out' }
                        ).stream(append);
                    } catch (userErr) {
                        append(`Varning: useradd (${userErr.message}) — kdeuser kanske redan finns.\n`);
                    }

                    // Set kdeuser password (reuse root password if given, otherwise default)
                    const kdeUserPassword = rootPassword || 'kdeuser123';
                    const kdeTmpFile = '/tmp/.cockpit-nspawn-kdepw';
                    try {
                        await cockpit.file(kdeTmpFile, { superuser: 'require' }).replace(kdeUserPassword);
                        await cockpit.spawn(['chmod', '600', kdeTmpFile], { superuser: 'require' });
                        const kdeHash = await cockpit.spawn(
                            ['/bin/bash', '-c', 'openssl passwd -6 -stdin < "$1"', '--', kdeTmpFile],
                            { superuser: 'require', err: 'out' }
                        );
                        await cockpit.spawn(
                            ['sed', '-i', `s|^kdeuser:[^:]*:|kdeuser:${kdeHash.trim()}:|`,
                             `/var/lib/machines/${name}/etc/shadow`],
                            { superuser: 'require', err: 'out' }
                        );
                        if (!rootPassword)
                            append('Varning: inget root-lösenord angivet — kdeuser fick lösenord "kdeuser123".\n');
                    } catch (pwErr) {
                        append(`Varning: kunde inte sätta kdeuser-lösenord (${pwErr.message}).\n`);
                    } finally {
                        await cockpit.spawn(['rm', '-f', kdeTmpFile], { superuser: 'require' }).catch(() => {});
                    }

                    // Enable linger so systemd creates /run/user/1000 at boot
                    await cockpit.spawn(
                        ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                         'loginctl', 'enable-linger', 'kdeuser'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);

                    // Disable KWallet (would block krfb and other tools with password prompts)
                    await cockpit.spawn(
                        ['mkdir', '-p', `/var/lib/machines/${name}/home/kdeuser/.config`],
                        { superuser: 'require', err: 'out' }
                    );
                    await cockpit.file(
                        `/var/lib/machines/${name}/home/kdeuser/.config/kwalletrc`,
                        { superuser: 'require' }
                    ).replace('[Wallet]\nEnabled=false\nFirst Use=false\n');

                    // KDE Plasma 6 default decoration has only the close button (appmenu:close).
                    // Override via system-wide dconf to add minimize + maximize for all GTK apps
                    // (Firefox, Thunar, etc.) that use client-side decorations.
                    // A system-wide dconf override under /etc/dconf/db/local.d/ survives container
                    // reboots without needing a user dconf session to be running.
                    // kwinrc also sets the SSD button layout for apps that use server-side decorations.
                    await cockpit.spawn(
                        ['mkdir', '-p', `/var/lib/machines/${name}/etc/dconf/db/local.d`],
                        { superuser: 'require', err: 'out' }
                    );
                    await cockpit.file(
                        `/var/lib/machines/${name}/etc/dconf/db/local.d/00-kde-decorations`,
                        { superuser: 'require' }
                    ).replace('[org/gnome/desktop/wm/preferences]\nbutton-layout=\':minimize,maximize,close\'\n');

                    await cockpit.spawn(
                        ['mkdir', '-p', `/var/lib/machines/${name}/home/kdeuser/.config`],
                        { superuser: 'require', err: 'out' }
                    );
                    // kwinrc: set SSD button layout (I=minimize, A=maximize, X=close on right)
                    // This affects kwin's own decorations and is read by xdg-desktop-portal-kde.
                    // Desktops.Number=1: enforce a single virtual desktop so the task manager
                    // never loses minimized windows to a different virtual desktop.
                    const kwinrcContent = [
                        '[org.kde.kdecoration2]',
                        'library=org.kde.breeze',
                        'ButtonsOnLeft=',
                        'ButtonsOnRight=IAX',
                        '',
                        '[Desktops]',
                        'Number=1',
                        'Rows=1',
                        '',
                    ].join('\n');
                    await cockpit.file(
                        `/var/lib/machines/${name}/home/kdeuser/.config/kwinrc`,
                        { superuser: 'require' }
                    ).replace(kwinrcContent);

                    // kxkbrc: keyboard layout for KDE/kwin session (WAYLAND_DISPLAY=wayland-1)
                    await cockpit.file(
                        `/var/lib/machines/${name}/home/kdeuser/.config/kxkbrc`,
                        { superuser: 'require' }
                    ).replace(`[Layout]\nLayoutList=${kbdLayout}\nUse=true\n`);

                    // Architecture: labwc (wlroots headless, wayvnc) → kwin_wayland nested
                    // fullscreen → plasmashell. kwin provides all KDE Wayland protocols
                    // (plasma_surface, PlasmaWindowManagement) so the panel docks correctly.

                    // plasma-startup.sh runs inside kwin's Wayland session (WAYLAND_DISPLAY=wayland-1).
                    // Note: polkit-kde-authentication-agent-1 is intentionally omitted — it requires
                    // a real logind session (PAM session with pam_systemd) which nspawn containers
                    // do not create for lingering systemd services. Discover/PackageKit authentication
                    // is handled instead by a polkit rule that grants kdeuser direct package rights.
                    const plasmaStartup = [
                        '#!/bin/bash',
                        'dbus-update-activation-environment --all',
                        'sleep 1',
                        '/usr/libexec/kactivitymanagerd &',
                        'sleep 1',
                        '/usr/bin/plasmashell &',
                        '',
                    ].join('\n');
                    await cockpit.file(
                        `/var/lib/machines/${name}/home/kdeuser/plasma-startup.sh`,
                        { superuser: 'require' }
                    ).replace(plasmaStartup);
                    await cockpit.spawn(
                        ['chmod', '+x', `/var/lib/machines/${name}/home/kdeuser/plasma-startup.sh`],
                        { superuser: 'require', err: 'out' }
                    );

                    // labwc autostart: sets resolution, starts pipewire, then kwin nested
                    // fullscreen (creates wayland-1), wayvnc captures labwc (wayland-0)
                    await cockpit.spawn(
                        ['mkdir', '-p', `/var/lib/machines/${name}/home/kdeuser/.config/labwc`],
                        { superuser: 'require', err: 'out' }
                    );
                    const labwcAutostart = [
                        'wlr-randr --output HEADLESS-1 --custom-mode 1920x1080@60',
                        'sleep 1',
                        'dbus-update-activation-environment --all &',
                        '/usr/bin/pipewire &',
                        '/usr/bin/wireplumber &',
                        'sleep 1',
                        '/usr/bin/kwin_wayland --no-kactivities --no-lockscreen --width 1920 --height 1080 --fullscreen true /home/kdeuser/plasma-startup.sh &',
                        'sleep 8',
                        '/usr/bin/wayvnc 0.0.0.0 5900 &',
                        '',
                    ].join('\n');
                    await cockpit.file(
                        `/var/lib/machines/${name}/home/kdeuser/.config/labwc/autostart`,
                        { superuser: 'require' }
                    ).replace(labwcAutostart);

                    // labwc/rc.xml: keyboard layout for the outer Wayland session
                    // (labwc is where wayvnc receives raw VNC key input, so the XKB
                    // layout here determines how VNC keysyms map to actual characters)
                    const labwcRc = [
                        '<?xml version="1.0" encoding="UTF-8"?>',
                        '<openbox_config>',
                        '  <keyboard>',
                        '    <xkb>',
                        `      <layout>${kbdLayout}</layout>`,
                        '    </xkb>',
                        '  </keyboard>',
                        '</openbox_config>',
                        '',
                    ].join('\n');
                    await cockpit.file(
                        `/var/lib/machines/${name}/home/kdeuser/.config/labwc/rc.xml`,
                        { superuser: 'require' }
                    ).replace(labwcRc);

                    // Fix ownership of kdeuser's home
                    await cockpit.spawn(
                        ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                         'chown', '-R', 'kdeuser:kdeuser', '/home/kdeuser'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);

                    // Write systemd service: labwc (outer headless compositor)
                    const kdeService = [
                        '[Unit]',
                        'Description=KDE Plasma headless (labwc + kwin nested + wayvnc)',
                        'After=network.target systemd-logind.service',
                        '',
                        '[Service]',
                        'Type=simple',
                        'User=kdeuser',
                        'Environment=WLR_BACKENDS=headless',
                        'Environment=WLR_LIBINPUT_NO_DEVICES=1',
                        'Environment=WLR_RENDERER=pixman',
                        'Environment=XDG_RUNTIME_DIR=/run/user/1000',
                        'Environment=HOME=/home/kdeuser',
                        'Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
                        'ExecStartPre=/bin/bash -c \'dbus-daemon --session --address=unix:path=/run/user/1000/bus --nofork --print-pid > /run/user/1000/dbus.pid 2>/dev/null & sleep 1\'',
                        'ExecStart=/usr/bin/labwc',
                        'Restart=on-failure',
                        'RestartSec=5',
                        '',
                        '[Install]',
                        'WantedBy=multi-user.target',
                        '',
                    ].join('\n');
                    await cockpit.file(
                        `/var/lib/machines/${name}/etc/systemd/system/kde-headless.service`,
                        { superuser: 'require' }
                    ).replace(kdeService);

                    // Enable service and open firewall port 5900
                    await cockpit.spawn(
                        ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                         'systemctl', 'enable', '--now', 'kde-headless'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);

                    // Write firewalld zone XML directly to the container filesystem so
                    // port 5900 persists across reboots even if firewalld was not running
                    // during bootstrap (firewall-cmd --permanent requires a live firewalld).
                    const fwZoneDir = `/var/lib/machines/${name}/etc/firewalld/zones`;
                    await cockpit.spawn(
                        ['mkdir', '-p', fwZoneDir],
                        { superuser: 'require', err: 'out' }
                    );
                    const fwZoneXml = [
                        '<?xml version="1.0" encoding="utf-8"?>',
                        '<zone>',
                        '  <short>Public</short>',
                        '  <service name="dhcpv6-client"/>',
                        '  <service name="mdns"/>',
                        '  <service name="ssh"/>',
                        '  <port port="5900" protocol="tcp"/>',
                        '</zone>',
                        '',
                    ].join('\n');
                    await cockpit.file(`${fwZoneDir}/public.xml`, { superuser: 'require' }).replace(fwZoneXml);
                    // Also reload firewalld in the running container to apply immediately
                    try {
                        await cockpit.spawn(
                            ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                             'firewall-cmd', '--reload'],
                            { superuser: 'require', err: 'out' }
                        ).stream(append);
                    } catch (fwErr) {
                        append(`Notera: brandvägg laddas om vid nästa omstart (${fwErr.message}).\n`);
                    }

                    // polkit rule: allow kdeuser to manage packages via Discover/PackageKit
                    // without a password prompt. polkit-kde-authentication-agent-1 cannot
                    // register in nspawn containers (requires a real logind session), so the
                    // authentication agent approach does not work here. This rule grants
                    // kdeuser direct package management rights via polkit.
                    await cockpit.spawn(
                        ['mkdir', '-p', `/var/lib/machines/${name}/etc/polkit-1/rules.d`],
                        { superuser: 'require', err: 'out' }
                    );
                    const polkitRule = [
                        'polkit.addRule(function(action, subject) {',
                        '    if (subject.user == "kdeuser" &&',
                        '        (action.id.indexOf("org.freedesktop.packagekit") === 0 ||',
                        '         action.id.indexOf("org.freedesktop.fwupd") === 0 ||',
                        '         action.id.indexOf("org.gnome.packagekit") === 0)) {',
                        '        return polkit.Result.YES;',
                        '    }',
                        '});',
                        '',
                    ].join('\n');
                    await cockpit.file(
                        `/var/lib/machines/${name}/etc/polkit-1/rules.d/90-kdeuser-packages.rules`,
                        { superuser: 'require' }
                    ).replace(polkitRule);

                    // Compile dconf system override (button-layout) inside the container.
                    // The dconf binary database must be compiled after the text override is written.
                    try {
                        await cockpit.spawn(
                            ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                             'dconf', 'update'],
                            { superuser: 'require', err: 'out' }
                        ).stream(append);
                    } catch (dconfErr) {
                        append(`Varning: dconf update misslyckades (${dconfErr.message}).\n`);
                    }

                    // Disable kdeconnect autostart: kdeconnectd tries to use Bluetooth and
                    // broadcasts network discovery, which generates harmless but noisy errors
                    // in the journal inside a container (no Bluetooth hardware available).
                    await cockpit.spawn(
                        ['mkdir', '-p', `/var/lib/machines/${name}/home/kdeuser/.config/autostart`],
                        { superuser: 'require', err: 'out' }
                    );
                    await cockpit.file(
                        `/var/lib/machines/${name}/home/kdeuser/.config/autostart/org.kde.kdeconnect.daemon.desktop`,
                        { superuser: 'require' }
                    ).replace('[Desktop Entry]\nHidden=true\n');

                    // Firefox autoconfig: force browser.tabs.inTitlebar=0 so Firefox requests
                    // server-side decorations (SSD) from kwin instead of drawing its own minimal
                    // CSD that only shows a close button. With inTitlebar=0, kwin provides the
                    // Breeze titlebar with the full button set (ButtonsOnRight=IAX).
                    await cockpit.spawn(
                        ['mkdir', '-p', `/var/lib/machines/${name}/usr/lib64/firefox/defaults/pref`],
                        { superuser: 'require', err: 'out' }
                    );
                    await cockpit.file(
                        `/var/lib/machines/${name}/usr/lib64/firefox/defaults/pref/autoconfig.js`,
                        { superuser: 'require' }
                    ).replace('pref("general.config.filename", "firefox.cfg");\npref("general.config.obscure_value", 0);\n');
                    await cockpit.file(
                        `/var/lib/machines/${name}/usr/lib64/firefox/firefox.cfg`,
                        { superuser: 'require' }
                    ).replace('// Firefox system autoconfig\npref("browser.tabs.inTitlebar", 0);\n');

                    // Mask fwupd: firmware update daemon cannot function in a container
                    // (no hardware devices, no kernel firmware interfaces). Without masking,
                    // fwupd.service fails to start and KDE Discover shows "unit failed" in
                    // its Updates section when it tries to poll the fwupd D-Bus backend.
                    try {
                        await cockpit.spawn(
                            ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                             'systemctl', 'mask', 'fwupd', 'fwupd-refresh.timer'],
                            { superuser: 'require', err: 'out' }
                        ).stream(append);
                    } catch (fwupdErr) {
                        append(`Notera: fwupd-mask misslyckades (${fwupdErr.message}).\n`);
                    }

                    append(`\nKDE Plasma VNC-server kör på port 5900.\n`);
                    append(`Anslut med VNC-klient (t.ex. Remmina) till port 5900 — inget lösenord.\n`);
                } else {
                    // Configure xrdp: write startwm.sh with the DE start command.
                    // xrdp's default startwm-bash.sh sources /usr/libexec/xrdp/startwm.sh
                    // which goes through /etc/X11/xinit/Xsession — it does NOT read
                    // /etc/xrdp/startwm.sh. We patch sesman.ini to use ours directly.
                    const startwm = `#!/bin/sh\nexec ${deCfg.startCommand}\n`;
                    await cockpit.file(
                        `/var/lib/machines/${name}/etc/xrdp/startwm.sh`,
                        { superuser: 'require' }
                    ).replace(startwm);
                    await cockpit.spawn(
                        ['chmod', '+x', `/var/lib/machines/${name}/etc/xrdp/startwm.sh`],
                        { superuser: 'require' }
                    );

                    // Patch sesman.ini: point DefaultWindowManager at our script
                    await cockpit.spawn(
                        ['sed', '-i',
                         's|^DefaultWindowManager=.*|DefaultWindowManager=/etc/xrdp/startwm.sh|',
                         `/var/lib/machines/${name}/etc/xrdp/sesman.ini`],
                        { superuser: 'require', err: 'out' }
                    );

                    // Enable xrdp service inside the container
                    await cockpit.spawn(
                        ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                         'systemctl', 'enable', '--now', 'xrdp'],
                        { superuser: 'require', err: 'out' }
                    ).stream(append);

                    append(`\nSkrivbordsmiljö installerad. RDP-server kör på port 3389.\n`);
                }
            }

            append(`\n=== Klar! Container ${name} skapad ===\n`);
            onRefresh();
            onAddNotification({ type: 'success', title: format(_("Container $0 created"), name) });
            setDone(true);
            setRunning(false);
        } catch (ex) {
            append(`\n[FEL] ${ex.message}\n`);
            // Try to read dnf5 log — grep for errors to avoid noise from host activity
            try {
                const log = await cockpit.spawn(
                    ['grep', '-i', '-E', 'error|critical|failed|transaction', '/var/log/dnf5.log'],
                    { superuser: 'require', err: 'ignore' }
                );
                if (log.trim()) append(`\n--- dnf5.log (fel-rader) ---\n${log}\n`);
            } catch (logErr) { /* log not present */ }
            setError(ex.message || 'Bootstrap misslyckades');
            setRunning(false);
        }
    };

    const showOutput = output.length > 0;

    return (
        <Modal
            isOpen
            onClose={running ? undefined : onClose}
            variant={showOutput ? 'large' : 'medium'}
        >
            <ModalHeader title={_("Create container")} />
            <ModalBody>
                <Form>
                    {/* ---- Method selector ---- */}
                    <FormGroup role="group" isInline fieldId="create-type" label={_("Method")}>
                        <Radio
                            id="type-bootstrap" name="create-type" label={_("Bootstrap (DNF)")}
                            isChecked={type === 'bootstrap'} onChange={() => setType('bootstrap')}
                            isDisabled={running}
                        />
                        <Radio
                            id="type-pull" name="create-type" label={_("Pull from URL")}
                            isChecked={type === 'pull'} onChange={() => setType('pull')}
                            isDisabled={running}
                        />
                        <Radio
                            id="type-clone" name="create-type" label={_("Clone existing")}
                            isChecked={type === 'clone'} onChange={() => setType('clone')}
                            isDisabled={running || images.length === 0}
                        />
                    </FormGroup>

                    {/* ---- Bootstrap form ---- */}
                    {type === 'bootstrap' && (
                        <>
                            <FormGroup label={_("Container name")} fieldId="boot-name" isRequired>
                                <TextInput
                                    id="boot-name" value={bootName}
                                    onChange={(_e, v) => setBootName(v)}
                                    placeholder={_("my-container")}
                                    isDisabled={running}
                                />
                            </FormGroup>

                            <FormGroup role="group" isInline fieldId="boot-distro" label={_("Distribution")}>
                                {Object.entries(DISTRO_TEMPLATES).map(([key, tmpl]) => (
                                    <Radio
                                        key={key}
                                        id={`distro-${key}`}
                                        name="boot-distro"
                                        label={tmpl.label}
                                        isChecked={distro === key}
                                        onChange={() => {
                                            setDistro(key);
                                            setVersion(DISTRO_TEMPLATES[key].defaultVersion);
                                        }}
                                        isDisabled={running}
                                    />
                                ))}
                            </FormGroup>

                            <FormGroup label={_("Version")} fieldId="boot-version">
                                <TextInput
                                    id="boot-version"
                                    value={version}
                                    onChange={(_e, v) => setVersion(v)}
                                    placeholder="43"
                                    isDisabled={running}
                                    style={{ maxWidth: '120px' }}
                                />
                                <FormHelperText>
                                    <HelperText>
                                        <HelperTextItem>
                                            {format(_("Repo: $0"), distro === 'almalinux'
                                                ? `repo.almalinux.org/almalinux/${version || '?'}/`
                                                : betaRelease
                                                    ? `dl.fedoraproject.org/pub/fedora/linux/development/${version || '?'}/`
                                                    : `dl.fedoraproject.org/pub/fedora/linux/releases/${version || '?'}/`)}
                                        </HelperTextItem>
                                    </HelperText>
                                </FormHelperText>
                            </FormGroup>

                            {distro === 'fedora' && (
                                <FormGroup fieldId="boot-beta">
                                    <Checkbox
                                        id="boot-beta"
                                        label={_("Beta / Development release")}
                                        isChecked={betaRelease}
                                        onChange={(_e, v) => setBetaRelease(v)}
                                        isDisabled={running}
                                    />
                                </FormGroup>
                            )}

                            <FormGroup label={_("Root password")} fieldId="boot-password">
                                <TextInput
                                    id="boot-password" type="password"
                                    value={rootPassword}
                                    onChange={(_e, v) => setRootPassword(v)}
                                    placeholder={_("Leave empty to set via terminal later")}
                                    isDisabled={running}
                                />
                                <FormHelperText>
                                    <HelperText>
                                        <HelperTextItem>{_("Can always be set afterwards via the terminal in this module")}</HelperTextItem>
                                    </HelperText>
                                </FormHelperText>
                            </FormGroup>

                            <FormGroup role="group" isInline fieldId="boot-network" label={_("Network")}>
                                <Radio
                                    id="net-private" name="boot-network" label={_("Private (NAT)")}
                                    isChecked={network === 'private'} onChange={() => setNetwork('private')}
                                    isDisabled={running}
                                />
                                <Radio
                                    id="net-bridge" name="boot-network" label={_("Bridge (own LAN IP)")}
                                    isChecked={network === 'bridge'} onChange={() => setNetwork('bridge')}
                                    isDisabled={running}
                                />
                            </FormGroup>

                            {network === 'private' && (
                                <Alert
                                    isInline variant="info"
                                    title={_("NAT networking via NetworkManager")}
                                >
                                    <p>{_("Bootstrap will create a shared NAT bridge (br-nspawn, 10.99.0.1/24) on the host using NetworkManager. IP forwarding will be enabled. This only runs once — all subsequent NAT containers reuse the same bridge.")}</p>
                                </Alert>
                            )}

                            {network === 'bridge' && (
                                <>
                                    <FormGroup label={_("Bridge name")} fieldId="boot-bridge">
                                        <TextInput
                                            id="boot-bridge" value={bridgeName}
                                            onChange={(_e, v) => setBridgeName(v)}
                                            isDisabled={running}
                                        />
                                    </FormGroup>
                                    <Alert
                                        isInline variant="info"
                                        title={_("The network bridge must exist on the host")}
                                    >
                                        <p>
                                            {format(_("The bridge $0 must be configured before the container starts."), <strong>{bridgeName || 'bridge0'}</strong>)}
                                        </p>
                                        <p>
                                            {_("Create it under")}{' '}
                                            <a
                                                href="#"
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    cockpit.jump('/network');
                                                }}
                                            >
                                                {_("Cockpit → Network → Add bridge")}
                                            </a>.
                                            {' '}{_("Note: does not work with WiFi adapter — requires wired network.")}
                                        </p>
                                    </Alert>
                                </>
                            )}

                            {distro === 'almalinux' && Number(version) >= 10 && (
                                <Alert isInline variant="info"
                                    title={_("Desktop environments not available for AlmaLinux 10")}
                                >
                                    {_("Desktop environment packages (XFCE, KDE, GNOME) and xrdp are not yet available in EPEL 10. Desktop environment bootstrap is not supported for AlmaLinux 10.")}
                                </Alert>
                            )}

                            <FormGroup role="group" isInline fieldId="boot-desktop" label={_("Desktop environment")}>
                                <Radio
                                    id="de-none" name="boot-desktop" label={_("None (server only)")}
                                    isChecked={desktop === 'none'} onChange={() => setDesktop('none')}
                                    isDisabled={running}
                                />
                                <Radio
                                    id="de-xfce" name="boot-desktop"
                                    label={DESKTOP_CONFIG.xfce.isAvailable?.(distro, version) === false ? "XFCE (" + _("not available for this version") + ")" : "XFCE"}
                                    isChecked={desktop === 'xfce'}
                                    onChange={() => setDesktop('xfce')}
                                    isDisabled={running || DESKTOP_CONFIG.xfce.isAvailable?.(distro, version) === false}
                                />
                                <Radio
                                    id="de-kde" name="boot-desktop"
                                    label={DESKTOP_CONFIG.kde.isAvailable?.(distro, version) === false ? "KDE Plasma (" + _("not available for this version") + ")" : "KDE Plasma"}
                                    isChecked={desktop === 'kde'}
                                    onChange={() => setDesktop('kde')}
                                    isDisabled={running || DESKTOP_CONFIG.kde.isAvailable?.(distro, version) === false}
                                />
                                <Radio
                                    id="de-gnome" name="boot-desktop"
                                    label={DESKTOP_CONFIG.gnome.isAvailable?.(distro, version) === false ? "GNOME (" + _("not available for this version") + ")" : "GNOME"}
                                    isChecked={desktop === 'gnome'} onChange={() => setDesktop('gnome')}
                                    isDisabled={running || DESKTOP_CONFIG.gnome.isAvailable?.(distro, version) === false}
                                />
                                <Radio
                                    id="de-weston" name="boot-desktop"
                                    label={DESKTOP_CONFIG.weston.isAvailable?.(distro, version) === false ? "Weston (" + _("not available for this version") + ")" : _("Weston (Wayland)")}
                                    isChecked={desktop === 'weston'}
                                    onChange={() => setDesktop('weston')}
                                    isDisabled={running || DESKTOP_CONFIG.weston.isAvailable?.(distro, version) === false}
                                />
                                <Radio
                                    id="de-kde-vnc" name="boot-desktop"
                                    label={DESKTOP_CONFIG.kde_vnc.isAvailable?.(distro, version) === false ? "KDE Plasma VNC (" + _("not available for this version") + ")" : _("KDE Plasma (Wayland VNC)")}
                                    isChecked={desktop === 'kde_vnc'}
                                    onChange={() => setDesktop('kde_vnc')}
                                    isDisabled={running || DESKTOP_CONFIG.kde_vnc.isAvailable?.(distro, version) === false}
                                />
                            </FormGroup>

                            {desktop !== 'none' && DESKTOP_CONFIG[desktop].almalinuxWarning && distro === 'almalinux' && (
                                <Alert isInline variant="warning"
                                    title={_("KDE Plasma availability on AlmaLinux")}
                                >
                                    {_("KDE Plasma is not officially supported on AlmaLinux. Installation requires EPEL and may result in an older Plasma version.")}
                                </Alert>
                            )}

                            {desktop === 'kde_vnc' && (
                                <Alert isInline variant="info"
                                    title={_("KDE Plasma: headless Wayland desktop via VNC")}
                                >
                                    {_("KDE Plasma runs headlessly using labwc (Wayland compositor) and wayvnc. Connect with any VNC client (e.g. Remmina) to port 5900 — no password required. Resolution: 1920×1080. The session runs as user kdeuser.")}
                                </Alert>
                            )}

                            {desktop === 'kde_vnc' && (
                                <FormGroup label={_("Keyboard layout")} fieldId="kbd-layout">
                                    <FormSelect
                                        id="kbd-layout"
                                        value={kbdLayout}
                                        onChange={(_e, v) => setKbdLayout(v)}
                                        isDisabled={running}
                                    >
                                        {KEYBOARD_LAYOUTS.map(({ value, label }) => (
                                            <FormSelectOption key={value} value={value} label={label} />
                                        ))}
                                    </FormSelect>
                                </FormGroup>
                            )}

                            {desktop === 'weston' && (
                                <Alert isInline variant="info"
                                    title={_("Weston: minimal Wayland desktop")}
                                >
                                    {_("Weston provides a minimal Wayland compositor accessible via RDP (port 3389). A terminal (weston-terminal) is available on the desktop. XFCE, KDE, and GNOME require X11 and are not available on Fedora 40+.")}
                                </Alert>
                            )}

                            {desktop !== 'none' && (
                                <Alert isInline variant="info"
                                    title={_("Desktop environment installed after bootstrap")}
                                >
                                    {_("The desktop environment is installed inside the running container after bootstrap. The container will be started automatically.")}
                                </Alert>
                            )}

                            <FormGroup
                                label={_("Memory limit")} fieldId="mem-max"
                                labelHelp={
                                    <Popover
                                        headerContent={_("Memory limit")}
                                        bodyContent={
                                            <div>
                                                <p>{_("Maximum RAM the container may use. If the limit is exceeded, processes inside the container are killed by the OOM killer.")}</p>
                                                <br />
                                                <p><strong>{_("Examples:")}</strong></p>
                                                <ul style={{ paddingLeft: '1.2em' }}>
                                                    <li><code>512M</code> — 512 megabytes</li>
                                                    <li><code>2G</code> — 2 gigabytes</li>
                                                    <li><code>4G</code> — 4 gigabytes</li>
                                                </ul>
                                                <br />
                                                <p>{_("Leave empty for no limit.")}</p>
                                            </div>
                                        }
                                    >
                                        <button type="button" className="pf-v5-c-form__group-label-help" aria-label={_("More info for Memory limit")}>
                                            <HelpIcon />
                                        </button>
                                    </Popover>
                                }
                            >
                                <TextInput
                                    id="mem-max" value={memoryMax}
                                    onChange={(_e, v) => setMemoryMax(v)}
                                    placeholder={_("unlimited")}
                                    isDisabled={running}
                                />
                            </FormGroup>
                            <FormGroup
                                label={_("CPU quota")} fieldId="cpu-quota"
                                labelHelp={
                                    <Popover
                                        headerContent={_("CPU quota")}
                                        bodyContent={
                                            <div>
                                                <p>{_("Maximum CPU time the container may use. 100% equals one full CPU core.")}</p>
                                                <br />
                                                <p><strong>{_("Examples:")}</strong></p>
                                                <ul style={{ paddingLeft: '1.2em' }}>
                                                    <li><code>50%</code> — {_("half a core")}</li>
                                                    <li><code>100%</code> — {_("one core")}</li>
                                                    <li><code>200%</code> — {_("two cores")}</li>
                                                    <li><code>400%</code> — {_("four cores")}</li>
                                                </ul>
                                                <br />
                                                <p>{_("Leave empty for no limit.")}</p>
                                            </div>
                                        }
                                    >
                                        <button type="button" className="pf-v5-c-form__group-label-help" aria-label={_("More info for CPU quota")}>
                                            <HelpIcon />
                                        </button>
                                    </Popover>
                                }
                            >
                                <TextInput
                                    id="cpu-quota" value={cpuQuota}
                                    onChange={(_e, v) => setCpuQuota(v)}
                                    placeholder={_("unlimited")}
                                    isDisabled={running}
                                />
                            </FormGroup>

                            <Checkbox
                                id="auto-enable"
                                label={_("Enable automatic start at boot")}
                                isChecked={autoEnable}
                                onChange={(_e, checked) => setAutoEnable(checked)}
                                isDisabled={running}
                            />
                            <Checkbox
                                id="auto-start"
                                label={_("Start container immediately after creation")}
                                isChecked={autoStart || desktop !== 'none'}
                                onChange={(_e, checked) => setAutoStart(checked)}
                                isDisabled={running || desktop !== 'none'}
                            />
                        </>
                    )}

                    {/* ---- Pull from URL form ---- */}
                    {type === 'pull' && (
                        <>
                            <FormGroup label={_("URL")} fieldId="pull-url" isRequired>
                                <TextInput
                                    id="pull-url" value={url}
                                    onChange={(_e, v) => setUrl(v)}
                                    placeholder="https://example.com/image.tar.gz"
                                    isDisabled={running}
                                />
                            </FormGroup>
                            <FormGroup role="group" isInline fieldId="pull-format" label={_("Format")}>
                                <Radio id="fmt-auto" name="pull-format" label={_("Automatic")}
                                    isChecked={pullFormat === 'auto'} onChange={() => setPullFormat('auto')} isDisabled={running} />
                                <Radio id="fmt-tar" name="pull-format" label=".tar"
                                    isChecked={pullFormat === 'tar'} onChange={() => setPullFormat('tar')} isDisabled={running} />
                                <Radio id="fmt-raw" name="pull-format" label=".raw"
                                    isChecked={pullFormat === 'raw'} onChange={() => setPullFormat('raw')} isDisabled={running} />
                            </FormGroup>
                            <FormGroup label={_("Name (optional)")} fieldId="pull-name">
                                <TextInput
                                    id="pull-name" value={pullName}
                                    onChange={(_e, v) => setPullName(v)}
                                    placeholder={_("Leave empty for automatic name from URL")}
                                    isDisabled={running}
                                />
                            </FormGroup>
                        </>
                    )}

                    {/* ---- Clone form ---- */}
                    {type === 'clone' && (
                        <>
                            <FormGroup label={_("Source")} fieldId="clone-source" isRequired>
                                <FormSelect
                                    id="clone-source" value={source}
                                    onChange={(_e, v) => setSource(v)}
                                    isDisabled={running}
                                >
                                    {images.map(img => (
                                        <FormSelectOption key={img.name} value={img.name} label={img.name} />
                                    ))}
                                </FormSelect>
                            </FormGroup>
                            <FormGroup label={_("New name")} fieldId="clone-name" isRequired>
                                <TextInput
                                    id="clone-name" value={cloneName}
                                    onChange={(_e, v) => setCloneName(v)}
                                    placeholder={_("my-new-container")}
                                    isDisabled={running}
                                />
                            </FormGroup>
                        </>
                    )}

                    {/* ---- Output log ---- */}
                    {showOutput && (
                        <FormGroup label={_("Output")} fieldId="bootstrap-output">
                            <pre
                                ref={outputRef}
                                style={{
                                    background: '#1a1a1a',
                                    color: '#f0f0f0',
                                    padding: '0.75rem',
                                    borderRadius: '4px',
                                    maxHeight: '320px',
                                    minHeight: '80px',
                                    overflow: 'auto',
                                    fontSize: '0.78rem',
                                    fontFamily: 'monospace',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                    margin: 0,
                                }}
                            >
                                {output}
                                {running && <span style={{ opacity: 0.6 }}>▊</span>}
                            </pre>
                        </FormGroup>
                    )}

                    {/* ---- Success ---- */}
                    {done && (
                        <Alert variant="success" isInline title={_("Container created!")} style={{ marginTop: '1rem' }}>
                            {type === 'bootstrap'
                                ? format(_("$0 is ready to use."), bootName.trim())
                                : type === 'clone'
                                    ? format(_("$0 has been cloned."), cloneName.trim())
                                    : _("Container pulled and ready.")}
                        </Alert>
                    )}

                    {/* ---- Error ---- */}
                    {error && (
                        <Alert variant="danger" isInline title={_("Error occurred")} style={{ marginTop: '1rem' }}>
                            <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: '0.8rem' }}>{error}</pre>
                        </Alert>
                    )}
                </Form>
            </ModalBody>
            <ModalFooter>
                {done ? (
                    <Button variant="primary" onClick={onClose}>
                        {_("Close")}
                    </Button>
                ) : (
                    <>
                        <Button
                            variant="primary"
                            onClick={handleCreate}
                            isDisabled={!canSubmit}
                        >
                            {running && <Spinner size="sm" style={{ marginRight: '0.5rem' }} />}
                            {running
                                ? (type === 'bootstrap' ? _("Bootstrapping...") : _("Creating..."))
                                : _("Create")}
                        </Button>
                        <Button variant="link" onClick={onClose} isDisabled={running}>
                            {_("Cancel")}
                        </Button>
                    </>
                )}
            </ModalFooter>
        </Modal>
    );
}
