# cockpit-nspawn — Projektspecifikation för Claude Code

## Översikt

Bygg en Cockpit-modul kallad **cockpit-nspawn** för hantering av systemd-nspawn containers via `machinectl` och `systemd-machined`. Modulen ska följa samma arkitektur och kodstil som `cockpit-podman`.

## Referensprojekt

```bash
git clone https://github.com/cockpit-project/cockpit-podman
git clone https://github.com/cockpit-project/starter-kit
```

Använd **cockpit-starter-kit** som projektbas och **cockpit-podman** som referens för arkitektur, komponentstruktur och byggsystem.

---

## Projektstruktur

```
cockpit-nspawn/
├── package.json
├── build.js               # esbuild-baserat byggsystem (kopiera från podman)
├── Makefile
├── cockpit-nspawn.spec    # RPM-spec för AlmaLinux 9 / Fedora
├── manifest.json          # Cockpit-modul manifest
├── index.html
└── src/
    ├── app.jsx            # Root-komponent, hämtar data, håller state
    ├── machines.jsx       # Lista alla containers/machines
    ├── MachineActions.jsx # Start/stopp/restart/kill/remove
    ├── MachineDetails.jsx # Detaljvy för en container
    ├── MachineTerminal.jsx# Shell i containern via machinectl shell
    ├── MachineLogs.jsx    # Journald-loggar för containern
    ├── utils.js           # Hjälpfunktioner för cockpit.spawn()
    └── style.scss
```

---

## Teknisk stack

- **React** (funktionella komponenter med hooks)
- **PatternFly 5** (samma UI-bibliotek som resten av Cockpit)
- **esbuild** för bygge
- **cockpit.js** API för systemkommunikation

---

## Backend-kommunikation

Modulen kommunicerar med systemet via `cockpit.spawn()` — INTE via DBus direkt. Använd samma mönster som cockpit-podman använder för `systemctl`.

### Primära kommandon

```bash
# Lista alla containers
machinectl list --output=json

# Lista också stoppade (images)
machinectl list-images --output=json

# Status för en container
machinectl status <name>

# Starta
machinectl start <name>

# Stoppa (graceful)
machinectl poweroff <name>

# Forcera stopp
machinectl terminate <name>

# Ta bort container-image
machinectl remove <name>

# Shell i container
machinectl shell <name>

# Loggar (via journald)
journalctl -M <name> -n 100 --output=json

# Realtidsloggar
journalctl -M <name> -f --output=json

# Klonar en image
machinectl clone <source> <dest>

# Info om diskutrymme
machinectl image-status <name>
```

### Datahämtning i app.jsx

```javascript
// Hämta körande containers
cockpit.spawn(["machinectl", "list", "--output=json", "--no-pager"], 
  { superuser: "require", err: "message" })
  .then(output => JSON.parse(output))

// Hämta alla images (inkl. stoppade)
cockpit.spawn(["machinectl", "list-images", "--output=json", "--no-pager"],
  { superuser: "require", err: "message" })
  .then(output => JSON.parse(output))

// Polling var 5:e sekund (machinectl har ingen event-stream)
```

> **OBS:** machinectl list --output=json kräver systemd v246+. På äldre system, parsa textoutput.

---

## Funktioner (MVP)

### 1. Containers-lista (machines.jsx)

PatternFly Table med kolumner:
- Namn
- Status (badge: running=green, stopped=grey)
- OS/Version
- Adress (IP)
- Diskstorlek
- Åtgärder (kebab-meny)

### 2. Åtgärder per container (MachineActions.jsx)

| Åtgärd | Kommando | Visas när |
|--------|----------|-----------|
| Start | `machinectl start <name>` | Stoppad |
| Stop | `machinectl poweroff <name>` | Körande |
| Force Stop | `machinectl terminate <name>` | Körande |
| Shell | `machinectl shell <name>` | Körande |
| Loggar | journalctl -M | Alltid |
| Clone | `machinectl clone` | Alltid |
| Remove | `machinectl remove` | Stoppad |

### 3. Terminal (MachineTerminal.jsx)

Använd Cockpit's inbyggda terminal-widget exakt som cockpit-podman gör:
```javascript
import { Terminal } from "cockpit-components-terminal.jsx";
// Spawn: ["machinectl", "shell", name]
```

### 4. Loggar (MachineLogs.jsx)

- Hämta via `journalctl -M <name> -n 200 --output=json --no-pager`
- Realtidsuppdatering via `-f` flag och streaming
- Filtrera på prioritet (error/warning/info)
- "Jump to system logs"-länk: `cockpit.jump('/system/logs/#/?_MACHINE_ID=...')`

### 5. Detaljvy (MachineDetails.jsx)

Expanderbar rad eller separat panel med:
- Sökväg (`/var/lib/machines/<name>`)
- OS release info
- IP-adress(er)
- Leader PID
- Tidsstämplar

---

## manifest.json

```json
{
  "version": 0,
  "require": {
    "cockpit": ">=300"
  },
  "menu": {
    "nspawn": {
      "label": "Containers (nspawn)",
      "order": 45,
      "docs": []
    }
  }
}
```

---

## RPM-spec (cockpit-nspawn.spec)

Bygg för **AlmaLinux 9** och **Fedora**. Följ cockpit-podman.spec som mall.

```spec
Name:           cockpit-nspawn
Version:        0.1.0
Release:        1%{?dist}
Summary:        Cockpit UI for systemd-nspawn containers
License:        LGPL-2.1
URL:            https://github.com/YOURNAME/cockpit-nspawn

BuildRequires:  nodejs >= 18
BuildRequires:  make
Requires:       cockpit-bridge >= 300
Requires:       systemd

%description
A Cockpit module for managing systemd-nspawn containers via machinectl.

%install
make install DESTDIR=%{buildroot} PREFIX=/usr

%files
%{_datadir}/cockpit/nspawn/
```

---

## Makefile-targets

```makefile
all: dist

dist:
	npm ci
	npm run build

install: dist
	mkdir -p $(DESTDIR)$(PREFIX)/share/cockpit/nspawn
	cp -r dist/* $(DESTDIR)$(PREFIX)/share/cockpit/nspawn/

rpm:
	make dist
	rpmbuild -ba cockpit-nspawn.spec

dev:
	npm run watch &
	python3 -m http.server 8080
```

---

## Utvecklingsworkflow med Claude Code

### Steg 1 — Sätt upp projektet
```
"Skapa ett nytt Cockpit-modulprojekt baserat på cockpit-starter-kit. 
Projektnamn: cockpit-nspawn. Kopiera byggsystemet från cockpit-podman."
```

### Steg 2 — Grundstruktur
```
"Skapa app.jsx som:
1. Hämtar 'machinectl list --output=json' via cockpit.spawn()
2. Hämtar 'machinectl list-images --output=json' via cockpit.spawn()
3. Pollar var 5 sekunder
4. Hanterar fel med PatternFly Alert
5. Renderar <Machines> komponenten"
```

### Steg 3 — Lista
```
"Skapa machines.jsx med en PatternFly Table som visar containers 
från machinectl list. Kolumner: Namn, Status (badge), Adress, Diskstorlek, Åtgärder."
```

### Steg 4 — Åtgärder
```
"Skapa MachineActions.jsx med kebab-dropdown för varje container. 
Implementera start/stop/terminate via cockpit.spawn(['machinectl', action, name], 
{superuser: 'require'})"
```

### Steg 5 — Terminal
```
"Implementera MachineTerminal.jsx som öppnar ett shell i containern 
via 'machinectl shell <name>'. Använd samma terminal-komponent som cockpit-podman."
```

### Steg 6 — Loggar
```
"Implementera MachineLogs.jsx som streamer journald-loggar från containern 
via 'journalctl -M <name> -f --output=json'"
```

### Steg 7 — RPM
```
"Skapa cockpit-nspawn.spec för AlmaLinux 9. Basera på cockpit-podman.spec.
Lägg till RPMWorks-kompatibel struktur."
```

---

## Viktiga cockpit.js-mönster att använda

```javascript
// Spawn med superuser
cockpit.spawn(["machinectl", "list", "--output=json"], {
  superuser: "require",
  err: "message"
}).then(output => {
  // hantera output
}).catch(ex => {
  // ex.message = felmeddelande
});

// Streaming (för loggar)
const proc = cockpit.spawn(["journalctl", "-M", name, "-f", "--output=json"], {
  superuser: "require"
});
proc.stream(data => {
  // hantera streaming data
});

// Filhantering
cockpit.file("/etc/machine-id").read().then(content => { ... });

// Navigation
cockpit.jump("/system/logs/");

// Notifikationer via setState i parent
onAddNotification({ type: 'danger', error: "Fel", errorDetail: ex.message });
```

---

## Kända begränsningar att hantera

1. `machinectl list --output=json` kräver systemd 246+ — lägg till felhantering för äldre format
2. `machinectl shell` kräver att containern är körande
3. Terminal kräver WebGL2 i webbläsaren — visa fallback-meddelande
4. Kräver `superuser: "require"` för alla machinectl-kommandon
5. Containers i `/var/lib/machines/` vs anpassad sökväg — hantera båda

---

## Framtida utökning (efter MVP)

- Skapa ny container från image (bootstrap)
- Bind-mounts konfiguration
- nspawn-filer (`.nspawn`) editor
- Resursövervakning (CPU/RAM per container)
- Nätverkskonfiguration
- Systemd-unit integration för autostart

---

## Projektnamn och GitHub

Föreslaget repo-namn: `cockpit-nspawn`  
Licens: LGPL-2.1 (samma som cockpit-podman)
