# cockpit-nspawn: Systemd-nspawn Container Management for Cockpit

> A web UI for managing systemd-nspawn containers — because apparently nobody else made one.

Create, start, stop, back up, and manage lightweight system containers directly from your Cockpit web console. No Docker required — full systemd support inside every container.

![screenshot](screenshot.png)

## What It Does

cockpit-nspawn provides a web-based interface for managing systemd-nspawn containers — system-level containers with full systemd support inside. Ideal for testing, service isolation, and lightweight virtualization without the overhead of Docker or a hypervisor.

- Lists all nspawn containers and machine images
- Start, stop, and force-terminate containers
- Open a shell inside a running container
- Stream live logs from the container via journald
- Live resource monitoring — memory and CPU usage per running container, updated every 5 seconds
- View failed systemd units inside each running container at a glance
- Create containers via DNF bootstrap (AlmaLinux, Fedora), URL pull, or clone
  - Optional desktop environment at bootstrap: XFCE, KDE Plasma, or GNOME (X11 + xrdp), Weston (Wayland RDP), or KDE Plasma headless (Wayland VNC)
  - Network mode: Bridge (own LAN IP) or NAT (shared NetworkManager bridge, 10.99.0.1/24)
  - Autostart at boot, root password, optional device bindings
- Change network mode (NAT ↔ Bridge) on stopped containers
- Edit the container's nspawn configuration file (`/etc/systemd/nspawn/NAME.nspawn`) directly in the UI, with device binding editor
- Open display — shows RDP connection info and downloads a `.rdp` file that opens directly in Windows Remote Desktop (mstsc.exe), Remmina, or xfreerdp
- Export containers as tarballs with direct browser download streaming
- Schedule automatic backups to a remote host over SSH, with incremental mode and MariaDB support
- Restore a container from a remote backup — browse available backups and restore with one click
- Enable/disable autostart at boot per container
- Interface available in English, Swedish, German, French, Spanish, Norwegian Bokmål, Danish, and Finnish

## The Story Behind This

If you have ever tried to find a Cockpit module for managing systemd-nspawn containers, you already know what happens: you find nothing. A few old forum threads, some "wouldn't that be nice" comments, and then silence.

Honestly, I find this strange. systemd-nspawn is a fantastic, lightweight container solution that ships with every modern systemd-based Linux system. No daemon, full systemd support inside the container, perfect for testing and isolation. And yet — no Cockpit UI. Not even a basic one.

So I built one.

I should be transparent: I am not a developer. I am a Linux sysadmin, an IT consultant, and what some might generously call a "datanisse" — a Scandinavian term for someone who lives and breathes computers but is not necessarily paid to write code. What I *am* paid to do is make Linux systems work, and I work far too much of the time already.

This module was built using **Claude Code**, which turned out to be a remarkable tool for exactly this kind of project — someone who knows what they want technically but needs help getting from idea to working software. If you are a sysadmin who has ever thought "I could specify this perfectly but couldn't code it from scratch", Claude Code is worth exploring.

## Translations

The interface is translated into English, Swedish, German, French, Spanish, Norwegian Bokmål, Danish, and Finnish.

> **Finnish translation note:** Suomenkielinen käännös on tehty parhaaksi katsotulla tavalla, mutta suomen kielen erityispiirteet tekevät teknisten termien kääntämisestä haastavaa. Jos löydät virheitä tai kömpelöitä ilmaisuja, olemme kiitollisia palautteesta — avaa GitHub-issue tai ota yhteyttä. *(The Finnish translation was done to the best of our ability, but Finnish is a uniquely challenging language for technical UI text. If you spot errors or awkward phrasing, feedback is very welcome.)*

## Backup

Containers can be backed up automatically to a remote host over SSH. Backup is configured per container via the **Backup…** menu item.

### Backup types

**Full backup** — Archives the container as a `.tar.gz` file and transfers it via `scp`. Simple and self-contained; each backup is a complete, independent snapshot.

**Incremental backup** — Uses `rsync --link-dest` to create dated snapshot directories where unchanged files are hardlinked to the previous snapshot. Only changed files are transferred — dramatically faster for large containers after the first run. Each snapshot can be restored independently.

### Schedule

| Option | When |
|---|---|
| Every hour | Hourly |
| Every 2 / 4 / 6 / 12 hours | Fixed interval |
| Daily at HH:MM | Once per day at a specific time |

The schedule is implemented as a persistent systemd timer. If the system is off at the scheduled time, the backup runs on the next boot. A **Backup now** button is available for immediate runs.

### MariaDB-aware backup

When **MariaDB backup** is enabled, cockpit-nspawn runs `mysqldump --single-transaction` inside the running container before the filesystem snapshot. This produces a consistent logical backup of all InnoDB databases without stopping MariaDB or the container — zero downtime.

The dump is included in the archive and is automatically replayed on restore: cockpit-nspawn starts the container, waits for MariaDB to accept connections (up to 60 seconds), then restores via `mysql`.

**Prerequisite:** `mysqldump` and `mysql` must be installed inside the container. You are responsible for testing this in your own environment before use in production.

### Configuration

| Field | Description |
|---|---|
| SSH host | Hostname or IP of the backup destination |
| SSH user | Remote user (default: root) |
| Remote path | Directory on the remote host where backups are stored |
| SSH private key | Path to a pre-authorized private key (see `ssh-copy-id`) |
| Backup type | Full (tar.gz) or Incremental (rsync) |
| Schedule | How often to run the backup |
| Retention | Number of backup copies to keep; older ones are deleted automatically |
| Stop during backup | Stop the container during archiving — recommended for non-MariaDB databases |
| MariaDB backup | Run `mysqldump` before archiving for zero-downtime database backup |
| MariaDB root password | Used only for the `mysqldump` connection |

**Prerequisites:** `ssh`, `scp`, and `rsync` must be available on the host. The SSH key must be pre-authorized on the remote host before the first backup runs.

The **status badge** on each container row updates every five seconds:
- **backup OK** (green) — last backup completed successfully
- **backup failed** (red) — last backup failed; open the Backup dialog for the error message

## Restore

Containers can be restored from a remote backup via the **Restore…** menu item. The restore dialog connects to the backup host over SSH, lists available backup archives for that container, and lets you select which one to restore.

Restoring will stop the container if it is running, replace its filesystem with the selected backup, and restart it automatically. If a MariaDB dump is present in the backup, it is restored automatically after the filesystem is in place. SSH connection details are pre-filled from the existing backup configuration.

**Warning:** Restore replaces the container's current filesystem entirely. This cannot be undone.

## Running Podman inside an nspawn container

nspawn containers can run Podman for container-in-container workloads. This requires a small amount of host-side preparation, and the required nspawn configuration differs between Fedora and AlmaLinux hosts.

See **[docs/podman-in-nspawn.md](docs/podman-in-nspawn.md)** for the full guide, including:
- Loading `ip_tables` on Fedora hosts (nftables-only by default)
- `PrivateUsers=no` requirement on Fedora 40+ hosts
- Ready-to-use `.nspawn` configurations for Fedora and AlmaLinux
- Managing Podman pods with Quadlet (replaces deprecated `podman generate systemd`)

## Desktop Environment Support

> **⚠️ Experimental** — Desktop environment bootstrap is under active development. Functionality varies by distribution.

Desktop environments are bootstrapped via DNF and use **xrdp** (X11), **Weston** (Wayland RDP), or **labwc + wayvnc** (Wayland VNC) for remote access. No GPU or physical display required.

| Distribution | XFCE | KDE Plasma | GNOME | Weston (Wayland RDP) | KDE Plasma (Wayland VNC) |
|---|---|---|---|---|---|
| AlmaLinux 9 | ✅ tested | ✅ tested | ✅ tested | ❌ not offered | ❌ not offered |
| AlmaLinux 10 | ❌ not in EPEL 10 yet | ❌ not in EPEL 10 yet | ❌ not in EPEL 10 yet | ❌ not offered | ❌ not offered |
| Fedora 43 | ✅ tested | ❌ Wayland-only | ❌ Wayland-only | ✅ tested | ❌ not offered |
| Fedora 44 | ❌ | ❌ | ❌ | 🔲 untested | ✅ tested |

See **[docs/desktop-environments.md](docs/desktop-environments.md)** for the full guide, including a detailed walkthrough of the headless KDE Plasma VNC architecture.

## cockpit-nspawn is tested on

| Distribution | Status |
|---|---|
| Fedora 43 | ✅ Tested |
| Fedora 44 | ✅ Tested (host + containers, KDE Plasma VNC bootstrap) |
| Fedora 41 / 42 | 🔲 Should work, untested |
| AlmaLinux 9 | ✅ Tested (host + containers) |
| AlmaLinux 10 | ✅ Tested (bootstrapping + Podman-in-nspawn) |

## Installation

### From RPM (recommended)

Pre-built RPM packages for Fedora 43, AlmaLinux 9, and AlmaLinux 10 are available on the [Releases page](../../releases).

```bash
dnf install ./cockpit-nspawn-*.noarch.rpm
```

### From source

```bash
git clone https://github.com/realmcuser/cockpit-nspawn
cd cockpit-nspawn

# Fetch the cockpit lib files (required for building)
git fetch https://github.com/cockpit-project/cockpit main
git archive FETCH_HEAD -- pkg/lib | tar -x

npm ci
npm run build
make install
```

Requires Cockpit ≥ 300 and systemd ≥ 246.

## A Word of Warning

This is a personal project maintained in whatever spare time I can find — which is not much. I use it on my own systems and it works well for me.

That said:

- **I am not accepting pull requests** at this time
- **I am not maintaining a Wiki**
- **Use this at your own risk**

If this module helps you, wonderful. If something breaks, please do not come after me — I have enough on my plate. You are a sysadmin, you know how to read logs.

That said, if you find it useful and want to build on it, fork it and make it your own. The world needs more nspawn tooling.

## Why nspawn?

- Ships with systemd — nothing extra to install
- Full systemd support *inside* the container (unlike most OCI runtimes)
- Lightweight and simple
- Perfect for testing RPM packages, services, and system configurations in isolation
- Works beautifully with AlmaLinux, Fedora, and other RPM-based systems

## Credits

cockpit-nspawn is built on top of several excellent open source projects.
See [CREDITS.md](CREDITS.md) for a full list with acknowledgements.

## License

LGPL-2.1

---

*Built by a sysadmin who got tired of waiting for a real developer to do it.*
