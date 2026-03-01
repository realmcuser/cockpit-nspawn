# cockpit-nspawn

A Cockpit module for managing systemd-nspawn containers through a clean web UI — because apparently nobody else made one.

![screenshot](screenshot.png)

## The Story Behind This

If you have ever tried to find a Cockpit module for managing systemd-nspawn containers, you already know what happens: you find nothing. A few old forum threads, some "wouldn't that be nice" comments, and then silence.

Honestly, I find this strange. systemd-nspawn is a fantastic, lightweight container solution that ships with every modern systemd-based Linux system. No daemon, full systemd support inside the container, perfect for testing and isolation. And yet — no Cockpit UI. Not even a basic one.

So I built one.

I should be transparent: I am not a developer. I am a Linux sysadmin, an IT consultant, and what some might generously call a "datanisse" — a Scandinavian term for someone who lives and breathes computers but is not necessarily paid to write code. What I *am* paid to do is make Linux systems work, and I work far too much of the time already.

This module was built using **Claude Code**, which turned out to be a remarkable tool for exactly this kind of project — someone who knows what they want technically but needs help getting from idea to working software. If you are a sysadmin who has ever thought "I could specify this perfectly but couldn't code it from scratch", Claude Code is worth exploring.

## What It Does

- Lists all nspawn containers and machine images
- Start, stop, and force-terminate containers
- Open a shell inside a running container
- Stream live logs from the container via journald
- Create containers via DNF bootstrap (AlmaLinux, Fedora), URL pull, or clone
- Export containers as tarballs with direct browser download streaming
- Interface available in English, Swedish, German, French, and Spanish

## Tested On

| Distribution | Status |
|---|---|
| Fedora 43 | ✅ Tested |
| Fedora 41 / 42 | 🔲 Should work, untested |
| AlmaLinux 9 | ✅ Tested (host + containers) |
| AlmaLinux 10 | ✅ Tested (bootstrapping) |

## Installation

### From RPM (recommended)

Pre-built RPM packages for Fedora 43, AlmaLinux 9, and AlmaLinux 10 are available on the [Releases page](../../releases).

```bash
# Download the RPM for your distribution and install
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

## License

LGPL-2.1

---

*Built by a sysadmin who got tired of waiting for a real developer to do it.*
