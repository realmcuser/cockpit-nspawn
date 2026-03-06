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
        session: 'xfce',
        crbFirst: { almalinux: true, fedora: false },
        epelFirst: { almalinux: true, fedora: false },
        // XFCE not yet available in EPEL 10 (as of early 2026)
        isAvailable: (distro, version) => !(distro === 'almalinux' && Number(version) >= 10),
        packages: [
            'tigervnc-server',
            'xfce4-session', 'xfwm4', 'xfce4-panel',
            'xfdesktop', 'xfce4-terminal',
        ],
    },
    kde: {
        session: 'plasma',
        crbFirst: { almalinux: true, fedora: false },
        epelFirst: { almalinux: true, fedora: false },
        // KDE Plasma 6 (Fedora 40+) is Wayland-only — no X11 session, incompatible with Xvnc
        // KDE not yet available in EPEL 10 (as of early 2026)
        isAvailable: (distro, version) => {
            if (distro === 'almalinux' && Number(version) >= 10) return false;
            if (distro === 'fedora' && Number(version) >= 40) return false;
            return true;
        },
        almalinuxWarning: true,
        packages: [
            'tigervnc-server',
            'plasma-desktop', 'plasma-workspace',
            'kde-settings-plasma', 'konsole',
        ],
    },
    gnome: {
        session: 'gnome-xorg',
        crbFirst: { almalinux: true, fedora: false },
        epelFirst: { almalinux: false, fedora: false },
        // tigervnc-server was removed from RHEL 10 / AlmaLinux 10
        isAvailable: (distro, version) => !(distro === 'almalinux' && Number(version) >= 10),
        packages: [
            'tigervnc-server',
            'gnome-session', 'gnome-shell', 'gnome-terminal',
        ],
    },
};

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
    const [desktop, setDesktop] = useState('none');
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
        const osLabel = `${template.label} ${version}`;

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
                    ...template.repoArgs(version),
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
                    ...template.repoArgs(version),
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

                // Write VNC config files directly into container filesystem
                // Use ~/.config/tigervnc/config (new path, TigerVNC 1.12+)
                // ~/.vnc/config is deprecated and SecurityTypes is ignored there
                await cockpit.spawn(
                    ['mkdir', '-p', `/var/lib/machines/${name}/root/.config/tigervnc`],
                    { superuser: 'require' }
                );
                const vncConfig = `session=${deCfg.session}\ngeometry=1920x1080\ndepth=24\nalwaysshared\nSecurityTypes=None\n`;
                await cockpit.file(
                    `/var/lib/machines/${name}/root/.config/tigervnc/config`,
                    { superuser: 'require' }
                ).replace(vncConfig);

                await cockpit.file(
                    `/var/lib/machines/${name}/etc/tigervnc/vncserver.users`,
                    { superuser: 'require' }
                ).replace(':1=root\n');

                // Enable and start VNC service inside the container
                await cockpit.spawn(
                    ['systemd-run', `--machine=${name}`, '--wait', '--pipe', '--',
                     'systemctl', 'enable', '--now', 'vncserver@:1'],
                    { superuser: 'require', err: 'out' }
                ).stream(append);

                append(`\nSkrivbordsmiljö installerad. VNC-server kör på port 5901.\n`);
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
                                                : `dl.fedoraproject.org/pub/fedora/linux/releases/${version || '?'}/`)}
                                        </HelperTextItem>
                                    </HelperText>
                                </FormHelperText>
                            </FormGroup>

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
                                    {_("TigerVNC (tigervnc-server) was removed from RHEL 10 and AlmaLinux 10. Desktop environment bootstrap requires VNC and is not supported for this version.")}
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
                                    id="de-gnome" name="boot-desktop" label="GNOME"
                                    isChecked={desktop === 'gnome'} onChange={() => setDesktop('gnome')}
                                    isDisabled={running}
                                />
                            </FormGroup>

                            {desktop !== 'none' && DESKTOP_CONFIG[desktop].almalinuxWarning && distro === 'almalinux' && (
                                <Alert isInline variant="warning"
                                    title={_("KDE Plasma availability on AlmaLinux")}
                                >
                                    {_("KDE Plasma is not officially supported on AlmaLinux. Installation requires EPEL and may result in an older Plasma version.")}
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
