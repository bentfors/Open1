# x-time

Tidrapportering med användare, kunder och projekt. Byggd efter samma grundmodell som Millnets tidigare Milltime (idag Milient Time Flow), men det här är ett eget system och inte en kopia. Se [Begränsningar och antaganden](#begränsningar-och-antaganden).

Inga externa beroenden. Kräver Node.js 22.13 eller senare (SQLite ingår i Node).

## Kom igång

```bash
npm start                 # http://localhost:3000
```

Första gången databasen är tom skapas grunddata och en administratör:

- Sätt `XTIME_ADMIN_EMAIL` och `XTIME_ADMIN_PASSWORD` (minst 10 tecken) för att välja själv, eller
- låt x-time skapa ett slumpat lösenord som skrivs ut **en gång** i terminalen. Det måste bytas vid första inloggningen.

Utan `COOKIE_SECURE=0` kräver `NODE_ENV=production` https, annars sparar webbläsaren aldrig inloggningskakan.

### Prova med demodata

```bash
npm run demo              # http://127.0.0.1:3000, egen databas i data-demo/
```

Demokontona har kända lösenord (`demo-password-1`) och lyssnar bara på 127.0.0.1. Använd aldrig demoläget mot riktig data.

### Konfiguration

| Variabel | Standard | Betydelse |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Adress att lyssna på |
| `DATA_DIR` | `./data` | Databas (`x-time.sqlite`) och kvitton (`receipts/`) |
| `NODE_ENV` | | `production` slår på Secure-kakor |
| `COOKIE_SECURE` | `1` i production | `0` för http, till exempel lokalt |
| `TRUST_PROXY` | `0` | `1` om x-time står bakom en proxy, så att klientens IP läses ur `X-Forwarded-For` |
| `XTIME_TZ` | `Europe/Stockholm` | Avgör vad som är "idag" |
| `XTIME_ADMIN_EMAIL`, `XTIME_ADMIN_PASSWORD` | | Första administratören |

Kör bakom en https-proxy. Proxyn måste behålla `Host`-headern, eftersom x-time jämför den med `Origin` som skydd mot CSRF.

## Det systemet gör

**Tid.** Veckovy med en rad per aktivitet eller frånvarotyp och en kolumn per dag. Skriv `7,5` eller `7:30`, ändringar sparas direkt. Användaren skickar in veckan för attest. Inskickad och godkänd tid är låst.

**Struktur.** Kund → Projekt → Aktivitet. Aktiviteter är debiterbara eller inte. Projekt har projektledare, debiteringsform (löpande, fast pris, internt), timpris, budget, datum och medlemmar. Ett projekt kan vara öppet för alla.

**Användare.** Roll (administratör eller användare), kategori (AM, BM, TA, Konsult Talent … redigerbar), chef, intern timkostnad, standardpris och arbetstid per vecka.

**Attest.** Projektledaren attesterar tid, utlägg och körningar på sina projekt. Det som saknar projekt, eller ligger på projekt utan projektledare, attesteras av den anställdes chef. Ingen attesterar sig själv, utom administratör. Avslag kräver en anledning och går tillbaka till användaren. Administratör kan öppna godkänd tid igen (Attest → Godkända).

**Utlägg och körjournal.** Utlägg med kvitto (JPEG, PNG, WebP eller PDF, högst 5 MB) och körd sträcka. Båda kan vidarefaktureras till kund.

**Rapporter.** Tidrapport per projekt, kund, aktivitet, användare, kategori, månad, dag eller frånvarotyp, med CSV-export för svensk Excel. Fakturaunderlag per kund och period. TB och provision.

**Periodlåsning.** Administratör kan låsa perioder till ett datum. Då kan vanliga användare varken ändra eller attestera i perioden.

### Provision på TB

En användare (mottagare) kan kopplas till flera konsulter och få en procentandel av deras TB. Varje koppling kan ha en giltighetsperiod. Det görs under Admin → Provision.

```
TB          = debiterbar intäkt − intern timkostnad
Intäkt      = debiterbara timmar × pris
Kostnad     = timmar × användarens timkostnad
Provision   = TB × procent, per tidspost så att kopplingens period respekteras
```

- Bara godkänd tid räknas, om man inte väljer "All tid" som förhandsvisning.
- Frånvaro räknas inte.
- Under Admin → Inställningar väljer du om ej debiterbar projekttid (utbildning, internt) ska belasta TB. Standard är att den gör det.
- Fastprisprojekt räknas med sitt timpris som värde i TB, men hamnar inte i fakturaunderlaget.
- Negativ TB ger negativ provision. Det finns ingen golvning.

### Pris

Priset på en tidspost väljs i den här ordningen: medlemmens eget pris i projektet, aktivitetens pris, projektets pris, personens standardpris. Priset fastställs när tiden **godkänns**. Prisändringar före attest slår alltså igenom, efter attest gör de inte det.

## Behörigheter

| | Användare | Projektledare / chef | Mottagare av provision | Administratör |
|---|---|---|---|---|
| Egen tid, utlägg, körjournal | ✔ | ✔ | ✔ | ✔ |
| Attestera | | på egna projekt och underställda | | allt |
| Tidrapporter (timmar) | egen | + egna projekt och underställda | egen | allt |
| Priser, kostnader, TB | | | | ✔ |
| Egen provision | | | ✔ | ✔ |
| Användare, kunder, projekt, fakturaunderlag | | | | ✔ |

Projektledare ser alltså timmar men inte pengar. Det är ett medvetet val för första versionen.

## Säkerhet

- Lösenord hashas med scrypt. Minst 10 tecken. Nya konton och återställda lösenord måste bytas direkt.
- Sessionskaka med `HttpOnly` och `SameSite=Lax`, `Secure` i produktion. Sessioner avslutas när ett konto inaktiveras eller byter lösenord.
- Begränsning av misslyckade inloggningar per konto och IP. Inloggningssvaret avslöjar inte om kontot finns.
- CSRF: `SameSite`, kontroll av `Origin` mot `Host`, och att API:t bara tar JSON.
- Strikt CSP utan inline-skript. Gränssnittet skriver aldrig användardata som HTML.
- Kvitton valideras på innehållet, lagras under slumpade namn och serveras bara till ägare, attestant och administratör.
- Alla SQL-frågor använder parametrar.

## Drift

- Databasen är en SQLite-fil i WAL-läge. Säkerhetskopiera med `sqlite3 data/x-time.sqlite ".backup 'backup.sqlite'"` och kopiera `data/receipts/` med.
- Inloggningsspärren ligger i minnet och nollställs vid omstart. Kör en enda instans.
- Tester: `npm test` (51 tester som täcker behörigheter, tidregler, attest, TB/provision och fakturaunderlag).

## Begränsningar och antaganden

Jag har inte kunnat läsa Millnets egen dokumentation, så jämförelsen med Flow bygger på dina svar och allmän kännedom om hur den här typen av system fungerar. Följande saknas eller är gissningar:

- **Provisionsmodellen** (procent av TB per koppling) är min tolkning av önskemålet. Hur TB ska räknas, om negativ TB ska golvas, och om procenten kan variera med kategori är inte bestämt.
- **Helgdagar och normtid.** Normen är arbetstid per vecka. Röda dagar räknas inte av.
- **Ingen integration** mot lön eller bokföring. Export sker via CSV.
- **Ingen moms** i fakturaunderlaget. Belopp är exklusive moms.
- **Inget lösenordsåterställande via e-post.** Administratör sätter ett tillfälligt lösenord.
- **Ingen flerbolagsfunktion.** Ett företag per installation.
- **Projektledare** kan inte själva ändra team eller aktiviteter. Det gör administratör.
- **Administratör kan inte rapportera tid åt andra i gränssnittet.** API:t stödjer det.
- Ingen revisionslogg över ändringar utöver vem som godkände och när.

## Struktur

```
src/        server, API, databasschema och affärsregler (inga beroenden)
public/     gränssnitt i vanlig JavaScript utan byggsteg
test/       node:test, kör mot en riktig server med databas i minnet
scripts/    demodata
```
