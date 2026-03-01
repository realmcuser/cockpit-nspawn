# cockpit-nspawn — TODO

## Internationalisering (i18n) — EJ GJORD

All UI-text är för närvarande hårdkodad på **svenska** i källkoden.
Cockpit har ett fullt gettext-baserat i18n-system som ska användas.

### Vad som behöver göras

1. **Byt källspråk till engelska** (Cockpit-standard — engelska är alltid fallback)
   - Alla strängar i `.jsx`-filerna ändras till engelska

2. **Slå in strängar i `_()`**
   ```js
   import cockpit from 'cockpit';
   const _ = cockpit.gettext;

   // Före:  "Skapa container"
   // Efter: _("Create container")
   ```

3. **Skapa `po/sv.po`** med svenska översättningar
   ```
   msgid "Create container"
   msgstr "Skapa container"

   msgid "Remove"
   msgstr "Ta bort"
   ...
   ```

4. **Uppdatera `build.js`** med `cockpit-po-plugin`:
   ```js
   import { cockpitPoPlugin } from './pkg/lib/cockpit-po-plugin.js';
   // lägg till i plugins-arrayen
   ```

5. **Uppdatera `src/index.html`** — lägg till po.js:
   ```html
   <script src="po.js"></script>
   ```

### Filer som berörs

- `src/app.jsx`
- `src/machines.jsx`
- `src/MachineActions.jsx`
- `src/MachineDetails.jsx`
- `src/MachineLogs.jsx`
- `src/MachineTerminal.jsx`
- `src/CreateMachineDialog.jsx`
- `src/ExportMachineDialog.jsx`

### Referens

Se hur cockpit-podman gör det:
- `pkg/lib/cockpit-po-plugin.js` finns redan i projektet
- `gettext-parser` finns redan i `package.json`
- Cockpit laddar automatiskt rätt `po.LANG.js` baserat på
  användarens språkinställning i webbläsare/OS

---

## Övrigt att överväga

- RPM-paketering (.spec-fil finns: `cockpit-nspawn.spec`) — testa bygge
- nspawn-fil editor (visa/redigera `/etc/systemd/nspawn/<name>.nspawn`)
- CPU/RAM-statistik per container (via cgroup-filer eller `systemd-cgtop`)
- machinectl import-dialog (komplement till export)
