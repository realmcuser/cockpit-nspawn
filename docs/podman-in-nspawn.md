# Running Podman inside an nspawn container

nspawn containers can run Podman, making it possible to host container-in-container workloads — for example, migrating an existing Podman-based setup into an isolated nspawn environment with full systemd support.

## Important: the .nspawn configuration file lives on the host

When you export a container and import it on a new host, the `.nspawn` configuration file (`/etc/systemd/nspawn/<name>.nspawn`) is **not** included in the export — it lives on the host, not inside the container. You must create it manually on the new host before starting the container.

cockpit-nspawn creates this file automatically when you bootstrap a new container. When importing a container from another machine, create the appropriate `.nspawn` file for your host distribution (see the configurations below) before starting the container.

## Host requirements

### Load ip_tables (Fedora hosts only)

Fedora 40+ uses nftables exclusively and does not load the `ip_tables` kernel module by default. Podman's `netavark` network backend requires `ip_tables` for NAT rules. Since the container shares the kernel with the host, load the module on the **host**:

```bash
modprobe ip_tables ip6_tables
```

To make this persistent across reboots:

```bash
cat > /etc/modules-load.d/ip_tables.conf << 'EOF'
ip_tables
ip6_tables
EOF
```

AlmaLinux 9 hosts load `ip_tables` by default — no action needed.

AlmaLinux 10 does **not** load `ip_tables` at all — the kernel is built without it. See the AlmaLinux 9 container on AlmaLinux 10 host section below.

## nspawn configuration

### Fedora 40+ host

```ini
[Exec]
Boot=yes
Capability=all
SystemCallFilter=keyctl
PrivateUsers=no

[Files]
Bind=/dev/fuse

[Network]
Bridge=bridge0
```

`PrivateUsers=no` is required on Fedora because newer systemd defaults to user namespace mapping (UID remapping). This prevents inner Podman containers from mounting `sysfs` — even with `--privileged` — because the mount is denied at the kernel level when not in the initial user namespace. `PrivateUsers=no` disables the UID remapping and resolves this.

Fedora's nspawn seccomp filter already includes `bpf` in the allowed syscalls, so `SystemCallFilter=bpf` is not needed here (unlike AlmaLinux 10).

### AlmaLinux 9 host

```ini
[Exec]
Boot=yes
Capability=all
SystemCallFilter=keyctl

[Files]
Bind=/dev/fuse

[Network]
Bridge=bridge0
```

AlmaLinux 9 does not enable `PrivateUsers` by default, so Podman works without that setting.

### AlmaLinux 10 host (systemd 257+)

```ini
[Exec]
Boot=yes
Capability=all
SystemCallFilter=keyctl bpf
PrivateUsers=no

[Files]
Bind=/dev/fuse

[Network]
Bridge=bridge0
```

Two settings are required that were not needed on AlmaLinux 9:

**`PrivateUsers=no`** — AlmaLinux 10 with systemd 257 enables UID remapping by default, just like Fedora 40+. Without this, inner Podman containers fail to mount `sysfs` because the mount is denied when not in the initial user namespace. Verify with `cat /proc/self/uid_map` inside the container: a mapping like `0 786759680 65536` means remapping is active.

**`SystemCallFilter=bpf`** — systemd 257's default seccomp filter does not include the `bpf()` syscall. crun requires it to set up the cgroup v2 device controller (using eBPF maps), even for simple `podman run` commands. Without it, every `podman run` fails with:

```
crun: bpf create ``: Operation not permitted: OCI permission denied
```

Note: `--security-opt seccomp=unconfined` inside Podman does not help — the block happens at the nspawn seccomp layer before Podman's own filters are evaluated. The fix must be in the `.nspawn` file on the host.

### AlmaLinux 9 container on an AlmaLinux 10 host

If you run an AlmaLinux 9 container on an AlmaLinux 10 host, use the AlmaLinux 10 `.nspawn` configuration above, and additionally configure Podman's network backend inside the container to use nftables instead of iptables:

```bash
mkdir -p /etc/containers
cat > /etc/containers/containers.conf << 'EOF'
[network]
firewall_driver = "nftables"
EOF
```

Without this, Podman inside the AlmaLinux 9 container tries to use iptables for NAT, but the AlmaLinux 10 kernel has no `ip_tables` module — it was removed entirely in RHEL 10. Setting `firewall_driver = "nftables"` tells netavark to use nftables directly.

This is a common scenario when migrating existing AlmaLinux 9 containers to a newer host. If you exported the container from an AlmaLinux 9 host and imported it on an AlmaLinux 10 host, add this setting before starting Podman workloads.

## Inside the container: known failing units

### systemd-modules-load.service

This service fails in every nspawn container — containers cannot load kernel modules. The failure is harmless but pollutes `systemctl --failed`. Mask it:

```bash
systemctl mask systemd-modules-load.service
```

## Managing Podman pods with Quadlet

`podman generate systemd` is deprecated in Podman 4+. Use [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) instead. Place quadlet files in `/etc/containers/systemd/` inside the nspawn container.

### Example: pod with one container

`/etc/containers/systemd/mypod.pod`:
```ini
[Unit]
Description=My pod

[Pod]
PodName=mypod
PublishPort=8080:80
AddHost=server:192.168.1.10
PodmanArgs=--security-opt label=disable
```

`/etc/containers/systemd/myapp.container`:
```ini
[Unit]
Description=My app container
After=mypod-pod.service

[Container]
Image=your-registry/your-image:tag
ContainerName=myapp
Pod=mypod.pod
Volume=mydata:/data
PodmanArgs=--privileged

[Service]
Restart=on-failure
TimeoutStopSec=61

[Install]
WantedBy=default.target
```

After creating the files, reload systemd inside the container to trigger the Quadlet generator:

```bash
systemctl daemon-reload
systemctl start myapp.service
```

The service starts automatically at container boot via `WantedBy=default.target`.

### Notes on Quadlet compatibility (Podman 5.x on AlmaLinux 9)

Some Quadlet keys that appear in the documentation are not supported in all versions. Use `PodmanArgs=` as a fallback:

| Intent | Works | Does not work |
|---|---|---|
| Run privileged | `PodmanArgs=--privileged` | `Privileged=true` |
| Disable SELinux label | `PodmanArgs=--security-opt label=disable` | `SecurityLabelDisable=true` |

`AmbientCapability=` is not supported with `Boot=yes` at all — systemd in the container manages capability inheritance itself.

### Why --privileged for systemd-init containers?

Containers that run `/sbin/init` (systemd) need to mount `sysfs` and `proc` inside their own mount namespace as part of system initialization. `--privileged` grants the capabilities required for this. Without it, crun fails with:

```
crun: mount `sysfs` to `sys`: Operation not permitted: OCI permission denied
```

This is expected and safe for internal workloads not exposed to WAN.
