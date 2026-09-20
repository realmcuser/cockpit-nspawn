# Running Claude Desktop in an nspawn container

> **Experimental.** This is a manual recipe, not a feature of the Cockpit module. It has been tested on **one machine** (see [Tested setup](#tested-setup)). Expect to adapt it.
>
> This is an unofficial community recipe. It is not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic. The Linux desktop app used here is Anthropic's own beta package, installed from their apt repository.

Run AI agents and coding assistants such as Claude Desktop in an isolated local container, on Linux hardware you already own. The app runs inside a Debian systemd-nspawn container, draws its window on your host desktop through Wayland, uses your GPU, and can run Cowork sessions in a virtual machine.

Anthropic ships Claude Desktop for Linux only as a `.deb` for Debian and Ubuntu (beta, since 2026-06-30). If your host is Fedora or AlmaLinux, an nspawn container is a lightweight way to run the official package without touching your host.

## What "isolated" means here

The container has its own filesystem, its own users and packages, and its own network (NAT). Files and settings for the app, its MCP tools and its sessions stay inside the container, separate from your host home directory and from other projects.

It is **not a hardened sandbox**. To show a window and use hardware acceleration, the container is given:

- your host's Wayland socket (so the container can talk to your compositor),
- `/dev/dri` (GPU),
- `/dev/kvm` and `/dev/vhost-vsock` (only needed for Cowork),
- a small shared directory used to pass login URLs between host and container.

`PrivateUsers=no` is used (the container's UID 1000 is the host's UID 1000). Treat the container as a convenient separation, not as a security boundary against a malicious app.

## Tested setup

The recipe has been run on two machines. Both run Debian 13 (trixie) containers with Claude Desktop 2.2553.1 from Anthropic's apt repository.

| | Machine A (laptop) | Machine B (desktop) |
|---|---|---|
| Host | Fedora 44, KDE Plasma (Wayland) | Fedora 44, KDE Plasma (Wayland) |
| GPU | Intel Iris Xe (Mesa) | NVIDIA GeForce RTX 4080 SUPER, NVIDIA open kernel module 615.71.09 |
| SELinux | Enforcing | Disabled |
| Network | NAT bridge `br-nspawn` (10.99.0.0/24), on Wi-Fi | LAN bridge `bridge0`, container gets DHCP from the LAN |
| How it was run | Built up step by step, then written down | The written guide, run on a clean container |

Verified working:

- App window on the host desktop (native Wayland), on both machines
- **GPU acceleration on Machine A** (EGL reports `Mesa Intel(R) Iris(R) Xe Graphics` inside the container). See [GPU acceleration](#gpu-acceleration): on Machine B (NVIDIA) it is **not** accelerated.
- Sign in with Google through the URL bridge, on both machines
- Start from the desktop menu on Machine A, from a stopped container (asks for your password via polkit) and after closing the window
- Cowork VM: the image downloads, QEMU boots and the guest connects, on both machines (about 40-50 seconds from click to ready). A Cowork task (create a text file) was run to completion on both machines.
- `vhost_vsock` loaded automatically after a reboot (Machine B)
- No SELinux denials on Machine A (`ausearch -m avc`). SELinux was disabled on Machine B, so this setup is **untested with SELinux there**.

**Not tested:** the Code tab / Claude Code, AMD GPUs, X11 hosts, other distributions as host, any other agent software. Cowork availability depends on your Anthropic account (it was rolled out to the account used for testing some hours after the app was installed).

## GPU acceleration

The container is given `/dev/dri`, and Mesa inside the container uses it.

- **Intel (Mesa):** works. Check with `eglinfo -B` (package `mesa-utils`) as the container user; it should name your GPU rather than `llvmpipe`.
- **NVIDIA (proprietary or open kernel module):** **does not work with this recipe.** Mesa in the container cannot drive the card (`libEGL warning: egl: failed to create dri2 screen`) and falls back to software rendering (`llvmpipe`). The app still starts and works, but it renders on the CPU and logs `WebGL1/2 blocklisted`. Making the NVIDIA userspace driver available inside the container was not attempted.
- **AMD:** not tested.

## Requirements

On the host:

- systemd-nspawn (`systemd-container`), `debootstrap`, and a network bridge for the container with DHCP (a LAN bridge such as `bridge0`, or cockpit-nspawn's NAT bridge `br-nspawn`; the NAT bridge needs `dnsmasq` installed to come up). On a laptop using Wi-Fi a LAN bridge usually does not work, so use the NAT bridge there.
- A Wayland desktop session. The commands below use `$HOSTUSER` for the user who owns that session.
- **The desktop user must be an administrator**: a member of the `wheel` group on Fedora, AlmaLinux and RHEL (or `sudo` on Debian and Ubuntu hosts). The menu entry starts a stopped container with `machinectl start`, which asks that user for their password through polkit, and step 7 uses `sudo`. Check with `id "$HOSTUSER"`, and add the user if needed: `usermod -aG wheel "$HOSTUSER"` (log out and in again afterwards).
- For Cowork only: hardware virtualization enabled in firmware, and the `vhost_vsock` kernel module.

Set two variables used throughout this guide (run as root on the host):

```bash
HOSTUSER=alice                 # the user logged in on the desktop
HOSTUID=$(id -u "$HOSTUSER")   # normally 1000
C=claude-desktop               # container name
R=/var/lib/machines/$C
BRIDGE=br-nspawn               # your bridge: br-nspawn (NAT) or e.g. bridge0 (LAN)
```

## 1. Create the container

```bash
debootstrap --include=systemd,systemd-sysv,systemd-resolved,dbus,dbus-user-session,iproute2,ca-certificates,curl,gnupg,sudo,locales,procps \
    trixie $R http://deb.debian.org/debian
```

`systemd-resolved` is included on purpose: Debian 13 does not install it by default, and without it the container has no DNS from DHCP.

Create the user that will run the app. The app refuses to run as root, and the user must have **the same UID as your host user** so that the host's Wayland socket and the shared directory are accessible. Note the full paths: `PATH` inside a plain `chroot` may not contain `/usr/sbin`.

```bash
chroot $R /usr/sbin/useradd -m -u "$HOSTUID" -s /bin/bash -G sudo,video claude
echo "claude:CHANGE-ME" | chroot $R /usr/sbin/chpasswd
echo "root:CHANGE-ME"   | chroot $R /usr/sbin/chpasswd
echo "$C" > $R/etc/hostname

# systemd-networkd with DHCP on the container's virtual interface
mkdir -p $R/etc/systemd/network
printf '[Match]\nName=host0\n\n[Network]\nDHCP=yes\n' > $R/etc/systemd/network/80-host0.network

# DNS comes from DHCP through systemd-resolved
rm -f $R/etc/resolv.conf
ln -s ../run/systemd/resolve/stub-resolv.conf $R/etc/resolv.conf
```

## 2. The `.nspawn` file and the device drop-in

Host paths that depend on your user's UID are filled in from the variables above.

```bash
mkdir -p "/home/$HOSTUSER/.local/share/claude-bridge/"{in,out}
chown -R "$HOSTUSER": "/home/$HOSTUSER/.local/share/claude-bridge"
chmod 700 "/home/$HOSTUSER/.local/share/claude-bridge/"{in,out}

cat > /etc/systemd/nspawn/$C.nspawn <<EOF
[Exec]
Boot=yes
Hostname=$C
PrivateUsers=no
Environment=WAYLAND_DISPLAY=/mnt/wayland-0

[Files]
Bind=/dev/dri
Bind=/dev/kvm
Bind=/dev/vhost-vsock
Bind=/run/user/$HOSTUID/wayland-0:/mnt/wayland-0
Bind=/home/$HOSTUSER/.local/share/claude-bridge:/mnt/bridge

[Network]
Bridge=$BRIDGE
EOF
```

`DeviceAllow=` is **not** supported in `.nspawn` files. Device access must be granted with a drop-in on the systemd unit:

```bash
mkdir -p /etc/systemd/system/systemd-nspawn@$C.service.d
cat > /etc/systemd/system/systemd-nspawn@$C.service.d/devices.conf <<'EOF'
[Service]
DeviceAllow=char-drm rw
DeviceAllow=/dev/kvm rw
DeviceAllow=/dev/vhost-vsock rw
EOF
systemctl daemon-reload
```

For Cowork, load `vhost_vsock` on the host and make it persistent, and give the container's `kvm` group the same GID as the host's:

```bash
echo vhost_vsock > /etc/modules-load.d/vhost_vsock.conf
modprobe vhost_vsock

HOSTKVM=$(getent group kvm | cut -d: -f3)
chroot $R /usr/sbin/groupmod -g "$HOSTKVM" kvm
chroot $R /usr/sbin/usermod -aG kvm claude
```

(If you do not want Cowork, remove the two `Bind=` and `DeviceAllow=` lines for `/dev/kvm` and `/dev/vhost-vsock`.)

## 3. Start the container and enable networking

`systemctl enable` from outside a chroot can fail silently, so enable networkd from inside the running container:

```bash
machinectl start $C
machinectl shell root@$C /usr/bin/systemctl enable --now systemd-networkd
machinectl shell root@$C /usr/bin/ping -c1 deb.debian.org      # should resolve and answer
```

## 4. Install Claude Desktop from Anthropic's apt repository

Follow Anthropic's own instructions ([Claude Desktop on Linux (beta)](https://code.claude.com/docs/en/desktop-linux)) if they differ from below. Verify the signing key fingerprint before you trust it.

```bash
machinectl shell root@$C /usr/bin/bash -c '
curl -fsSLo /usr/share/keyrings/claude-desktop-archive-keyring.asc https://downloads.claude.ai/claude-desktop/key.asc
gpg --show-keys --with-fingerprint /usr/share/keyrings/claude-desktop-archive-keyring.asc
'
```

The fingerprint printed must match the one in Anthropic's documentation (at the time of writing: `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`). Then:

```bash
machinectl shell root@$C /usr/bin/bash -c '
echo "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/claude-desktop-archive-keyring.asc] https://downloads.claude.ai/claude-desktop/apt/stable stable main" > /etc/apt/sources.list.d/claude-desktop.list
apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y claude-desktop
'
```

The package recommends QEMU, OVMF and virtiofsd, which Cowork needs.

## 5. Run the app as a user service

**Do not start the app from a `machinectl shell` session with `&` or `nohup`.** When the session ends, the app is killed. The symptom looks like a GPU problem (`GPU process launch failed`, zygote errors in the log) but it is just the shutdown. Use a systemd user service with lingering instead:

```bash
D=docs/claude-desktop        # path to this directory in your checkout of cockpit-nspawn
machinectl shell root@$C /usr/bin/loginctl enable-linger claude

UD=$R/home/claude/.config/systemd/user
install -d -o "$HOSTUID" -g "$HOSTUID" $R/home/claude/.config $R/home/claude/.config/systemd $UD $UD/default.target.wants
install -m 644 -o "$HOSTUID" -g "$HOSTUID" $D/container/claude-app.service $D/container/claude-bridge-in.path $D/container/claude-bridge-in.service $UD/
ln -sf ../claude-bridge-in.path $UD/default.target.wants/claude-bridge-in.path
install -m 755 $D/container/xdg-open $D/container/claude-bridge-in $R/usr/local/bin/

machinectl poweroff $C; sleep 5; machinectl start $C    # pick up the new units and bind mounts
systemctl --user -M claude@$C start claude-app.service
```

A Claude window should appear on your desktop. `claude-app.service` is deliberately not enabled at boot, because it needs your desktop session's Wayland socket to exist.

## 6. Sign-in bridge (needed for "Continue with Google")

The app opens your **system browser** for sign-in and expects the browser to hand a `claude://` URL back. The container has no browser, so two small bridges pass URLs through the shared directory (`~/.local/share/claude-bridge/`):

- **container → host:** the `xdg-open` shim in the container writes `http(s)` URLs to `out/`; a systemd path unit on the host opens them in your default browser.
- **host → container:** your host registers itself as the handler for `claude://`; it writes the URL to `in/`; a path unit in the container delivers it to the running app.

Only `http(s)` URLs are opened on the host, and only `claude://` URLs are delivered to the container; anything else is ignored.

**Check for an existing `claude://` handler first.** The last command below makes this container the handler for `claude://` links on your host. If you already have another Claude Desktop installed on the host (for example a community RPM), its sign-in callback will stop working. See what is registered now, and keep a backup:

```bash
xdg-mime query default x-scheme-handler/claude      # empty = none registered
cp ~/.config/mimeapps.list ~/.config/mimeapps.list.backup
```

Install the host side **as your normal user** (not root):

```bash
D=docs/claude-desktop
install -d ~/.local/bin ~/.config/systemd/user ~/.local/share/applications
install -m 755 $D/host/claude-bridge-open $D/host/claude-scheme-forward $D/host/claude-container-launch ~/.local/bin/
install -m 644 $D/host/claude-bridge-open.path $D/host/claude-bridge-open.service ~/.config/systemd/user/
sed "s|@HOME@|$HOME|" $D/host/claude-container.desktop.in > ~/.local/share/applications/claude-container.desktop

systemctl --user daemon-reload
systemctl --user enable --now claude-bridge-open.path
xdg-mime default claude-container.desktop x-scheme-handler/claude
update-desktop-database ~/.local/share/applications
```

Now click **Continue with Google** in the app. Your browser opens the sign-in page; when it offers to open `claude://…`, choose "Claude (container URL forwarder)".

## 7. Menu entry

This adds "Claude Desktop (container)" to your application menu. It starts the container if it is stopped (your OS asks for your password, because `machinectl start` needs privileges), starts the app, and brings the window back if you had closed it. Closing the window leaves the app running in the background, so the launcher asks the running instance to show its window.

```bash
D=docs/claude-desktop
sed "s|@HOME@|$HOME|" $D/host/com.anthropic.Claude.desktop.in > ~/.local/share/applications/com.anthropic.Claude.desktop
# /var/lib/machines is not readable by normal users, so the icons need sudo
for s in 16 32 48 128 256; do
    sudo install -D -o "$USER" -g "$(id -gn)" -m 644 /var/lib/machines/claude-desktop/usr/share/icons/hicolor/${s}x${s}/apps/claude-desktop.png \
        ~/.local/share/icons/hicolor/${s}x${s}/apps/claude-desktop.png
done
update-desktop-database ~/.local/share/applications
```

(The file is named `com.anthropic.Claude.desktop` so that it matches the window's app ID and your desktop shows the right icon for the running window.)

## Cowork notes

- Cowork appears as an option inside the Chat view, depending on your Anthropic account. It was not visible right after installation on the test account and appeared later, so it looks like a server-side rollout rather than something in this setup.
- The first Cowork session downloads a VM image (about 1.3 GB compressed, expanded to a 10 GB image plus a 10 GB sparse session disk) into `~/.config/Claude/vm_bundles` inside the container, then boots QEMU with 4 GB RAM and 2 CPUs. Startup took about 50 seconds.
- If the app reports that Cowork needs KVM, check `/dev/kvm` and `/dev/vhost-vsock` inside the container (`ls -l`), the `kvm` group membership of the `claude` user, and that `lsmod | grep vhost_vsock` shows the module on the host.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Menu entry does nothing visible | The app was running in the background with no window. Use the launcher from this guide (it asks the running instance to show its window). |
| `GPU process launch failed` and the app exits | Usually the app being killed when a `machinectl shell` session ended, see [step 5](#5-run-the-app-as-a-user-service). |
| `Running as root without --no-sandbox is not supported` | Start the app as the `claude` user, not root. |
| Container has no DNS or network | Make sure `systemd-networkd` is enabled inside the running container (step 3), `systemd-resolved` is installed and `/etc/resolv.conf` links to its stub (step 1). On the NAT bridge, `dnsmasq` must be installed on the host. |
| App renders slowly, log shows `WebGL blocklisted` | Software rendering. Run `eglinfo -B` as the container user: `llvmpipe` means the GPU is not used. See [GPU acceleration](#gpu-acceleration) (NVIDIA is not supported by this recipe). |
| Sign-in page never opens | The `xdg-open` shim is not first in `PATH` (`/usr/local/bin` must come before `/usr/bin`), or `claude-bridge-open.path` is not active on the host. |
| The browser asks which app should open `claude://` | Pick "Claude (container URL forwarder)", or re-run the `xdg-mime default` command from step 6. |
| `pgrep -f`/`pkill -f` inside `machinectl shell` kills your own session | The pattern matches the shell's own command line. Use a bracket pattern such as `pkill -f "[/]usr/lib/claude-desktop"`. |
| Cowork says it needs the `vhost_vsock` module | `modprobe vhost_vsock` on the host and see step 2 to make it persistent. |

## Limitations

- Only Debian-based containers are supported by Anthropic's package. This recipe uses Debian 13.
- The container is not started at boot. Enable that yourself with `machinectl enable claude-desktop` if you want it.
- The recipe assumes one desktop user whose UID matches the container's `claude` user.
- Claude Desktop for Linux is an Anthropic beta. Features and requirements can change between versions.
