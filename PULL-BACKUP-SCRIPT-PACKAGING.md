# Paketera source-host-skripten i cockpit-nspawn.spec — LÖST 2026-08-03

**Status:** Genomfört i v1.0.0-72. `dispatch.sh`/`pre-snapshot.sh`/`snapshot-db.sh`/
`restore-after-backup.sh` paketeras nu statiskt till `/usr/local/lib/nspawn-pull/`
via `cockpit-nspawn.spec`s `%install`/`%files` (alternativ (a) nedan, vald
framför att bara behålla toggle-planen). En dold, viktig detalj: RPMWorks
bygger INTE från detta repots `.spec`-fil direkt — den har en egen kopia
(`build_config.spec_template`, projekt-id 4) som hade drivit isär lika mycket
som `src/pull-backup/*.sh` hade. Uppdaterades via `PUT /api/projects/4/spec`.
Samtidigt uppdaterades RPMWorks `pre_fetch_script` (källkonfigurationen, inte
del av det här repot) att även bädda in `src/pull-backup/*.sh` i tarbollen —
annars hade `%install` inte haft några filer att paketera, eftersom tarbollen
tidigare bara innehöll `dist/`-utdata. `%post` installerar `rrsync` om den
saknas, samma kontroll som `BackupDialog.jsx` redan gjorde i JS (kvar som
fallback). Verifierat: byggde för alla 4 distros, installerade paketet på
riktigt lokalt, kontrollerade att filerna hamnade i `/usr/local/lib/nspawn-pull/`
med rätt innehåll (byte-identiskt med `nspawn-vault/source-host/` bortsett
från en ofarlig shebang-normalisering `rpmbuild` gör automatiskt).

Ursprunglig briefing nedan, kvar för historik.

---

# TODO: paketera source-host-skripten i cockpit-nspawn.spec

Skriven 2026-08-03 av Claude i en `nspawn-vault`-session, som en briefing
inför en ny Claude Code-session här i `nspawn-cockpit`-repot. Ingen kod är
ändrad i det här repot ännu - det här är bara problemet + ett förslag.

## Bakgrund

`nspawn-vault` (`nspawn-vault/source-host/`, se README.md där) har fyra
skript som måste installeras manuellt på varje **källserver** (den
nspawn-cockpit-host som säkerhetskopieras) för att pull-backup ska fungera:
`dispatch.sh`, `snapshot-db.sh`, `pre-snapshot.sh`, `restore-after-backup.sh`.
De körs helt separat från `nspawn-vault`-paketet (som bara installeras på
valvet) - se `nspawn-vault/pull-backup-threat-model.md` för hela
säkerhetsmodellen (varför källservern aldrig får ha en credential som når
valvet).

Idag är installationen helt manuell: `scp` filerna till
`/usr/local/lib/nspawn-pull/` på varje källserver för hand, varje gång
något ändras i `nspawn-vault/source-host/`. Det har redan orsakat en
verklig bugg: den här repots egen kopia (`src/pull-backup/*.sh`) hann
driva isär från `nspawn-vault`s (då gällande) kopia av `snapshot-db.sh` -
någon lade till en `write_status()`-förbättring här som aldrig
synkades tillbaka. Fixat i `nspawn-vault` 2026-08-03 (v1.0.0-18, samma
release som lade till `pre-snapshot.sh`), men mekanismen som orsakade
drivningen finns kvar.

**Konkret upptäckt**: `cockpit-nspawn.spec` paketerar inte
`src/pull-backup/*.sh` alls just nu - inget `%install`/`%files`-steg
refererar dem. De ligger som lösa filer i repot, helt oanvända av RPM:et.
Det är sannolikt precis därför de kunde bli inaktuella utan att någon
märkte det - ingen bygger/installerar om dem någonsin.

## Johans fråga (som triggade det här dokumentet)

"Ska filerna inte vara med i nspawn-cockpit-RPM:en, så de uppdateras
automatiskt när man uppdaterar cockpit-nspawn-paketet?" - ja, det stämmer,
och skulle lösa hela synk-problemet på en gång.

## Förslag att utvärdera i den nya sessionen

Eftersom `cockpit-nspawn` redan installeras på varje källserver den
hanterar, kan `source-host/*.sh` paketeras **statiskt** i
`cockpit-nspawn.spec`s `%install`/`%files` (t.ex. till
`/usr/local/lib/nspawn-pull/`, `chmod 755`) - då sprider en vanlig
`dnf update cockpit-nspawn` senaste skriptversionen till alla källservrar
automatiskt, utan manuell `scp`.

Kvar att göra manuellt (kräver ett admin-beslut, inte del av den här
paketeringsfixen): `authorized_keys`-raden med valvets publika nyckel, och
per-container `.cnf`/`.hook`-filerna (DB-credentials respektive
pre-snapshot-hook-kommando).

**Källa till sanning**: `nspawn-vault/source-host/` (repo
`github.com/realmcuser/nspawn-vault`) är den kanoniska kopian - bekräftat
via `nspawn-vault/source-host/README.md` och den här repots egen
`PULL-BACKUP-INTEGRATION.md`. Den här repots `src/pull-backup/*.sh` ska
behandlas som en vendorad kopia som ska synkas *från* den kanoniska källan,
inte redigeras självständigt - det var precis så den förra drivningen
uppstod.

## Öppen designfråga att ta ställning till

`PULL-BACKUP-INTEGRATION.md` beskriver redan en större plan: en toggle i
cockpit-nspawns egna UI som skriver dessa filer till disk vid körning via
`cockpit.file(...).replace(...)` (skripten inbakade som JS-strängkonstanter,
genererade från `nspawn-vault/source-host/*.sh` vid build-tid). Det är
fortfarande värdefullt för det som faktiskt är per-container/dynamiskt
(`authorized_keys`-raden, `.cnf`/`.hook`-filerna) - men kanske överkurs för
själva de delade, per-host-skripten, som lika gärna kan paketeras statiskt
i RPM:et istället.

Två vägar att välja mellan:
- **(a) Statisk paketering** (det här dokumentets förslag): skripten i
  `%files`, uppdateras av `dnf update`. Enklare, löser det faktiska
  synk-problemet med minst arbete.
- **(b) Behåll hela toggle-planen** som den redan är beskriven i
  `PULL-BACKUP-INTEGRATION.md`, där skripten också skrivs via toggeln.

(a) är sannolikt rätt första steg oavsett - toggeln (om den någonsin byggs)
kan fortfarande hantera bara de dynamiska bitarna ovanpå en statisk
skriptpaketering.

## Relevanta filer

- `nspawn-vault/source-host/*.sh` - kanoniska skripten (facit)
- `nspawn-vault/source-host/README.md` - dagens manuella installationssteg
  (det som ska automatiseras bort)
- `nspawn-vault/source-host/example.cnf`, `example.hook` - config-mallar
- `nspawn-vault/pull-backup-threat-model.md` - hela designen/säkerhetsmodellen
- `PULL-BACKUP-INTEGRATION.md` (den här repot) - den befintliga
  toggle-planen
- `src/pull-backup/*.sh` (den här repot) - dagens inaktuella, opaketerade
  vendorade kopia
- `cockpit-nspawn.spec` - där `%install`/`%files` behöver läggas till

Värt att också kolla under det arbetet: om `rrsync` behöver säkerställas på
`$PATH` (README.md:s installationssteg hanterar det manuellt idag) borde
det också bli en `%post`/`Requires` i det här paketet.
