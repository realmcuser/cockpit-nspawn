# Running Podman inside an nspawn container

nspawn containers can run Podman, making it possible to host container-in-container workloads — for example, migrating an existing Podman-based setup into an isolated nspawn environment with full systemd support.

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

AlmaLinux 9 and 10 hosts load `ip_tables` by default — no action needed.

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

### AlmaLinux 9 / AlmaLinux 10 host

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

AlmaLinux 9 and 10 do not enable `PrivateUsers` by default, so Podman works without that setting.

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
