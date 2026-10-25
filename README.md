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

**Fakturering.** Allt som rapporteras (tid, utlägg, körning) hamnar i en projektvy under Fakturering. Där väljer du rad för rad vad som ska med på ett fakturaunderlag. Det du inte väljer ligger kvar och dyker upp nästa gång, så att inget glöms bort. Under "Att fakturera" ser du alla projekt som har något ofakturerat, äldsta först. Bara godkända, debiterbara rader på löpande räkning kan faktureras. Övriga rader syns med en förklaring (väntar på attest, ej debiterbar, fast pris). Rader som aldrig ska faktureras kan avskrivas med en anledning. De lämnar då kön och upplupet men finns kvar i projektvyn.

**Upplupet.** Rapporter → Upplupet visar utfört men ännu inte fakturerat för valfri period, räknat på det datum timmarna avser. Förvalt är allt fram till sista dagen i förra månaden. Du kan gruppera på kund, projekt, användare eller månad, och exportera till CSV. Se [Upplupet](#upplupet) nedan.

**Övriga rapporter.** Tidrapport per projekt, kund, aktivitet, användare, kategori, månad, dag eller frånvarotyp, med CSV-export för svensk Excel. TB per konsult och provision.

**Periodlåsning.** Administratör kan låsa perioder till ett datum. Då kan vanliga användare varken ändra eller attestera i perioden.

### Provision

Under Admin → Provision skapar du regler. Varje regel hör till en mottagare och räknas per **månad eller kvartal**. Det finns tre typer:

| Typ | Räknas så här |
|---|---|
| Procent av TB | Procent × summan av TB för de konsulter du valt |
| Belopp per konsult i uppdrag | Belopp × antal konsulter i uppdrag, summerat över månaderna i perioden |
| Procent av TB, trappa | Procent av valda konsulters TB, där procenten bestäms av genomsnittligt antal konsulter i uppdrag per månad |

```
TB          = debiterbar intäkt − intern timkostnad
Intäkt      = debiterbara timmar × pris
Kostnad     = timmar × användarens timkostnad
```

- **Konsult i uppdrag** en månad: mer än *minsta antal timmar* (standard 0, alltså minst en minut) godkända debiterbara timmar den månaden. Du kan begränsa vilka kategorier som räknas.
- **Trappa**: trappsteget gäller för hela TB:n, inte marginellt. Exempel: 0 → 4 %, 11 → 6 %, 21 → 8 %.
- **Kvartal** summerar TB över hela kvartalet, så en dålig månad nettas mot en bra. Månadsregler räknas för sig.
- **Golv**: "Ingen negativ provision" ger 0 i stället för minus för perioden. Standard för nya regler.
- Regler kan ha giltighetstid. Bara tid inom den räknas.
- Perioder räknas alltid hela, även om du väljer ett kortare intervall i rapporten, och markeras som pågående tills de är slut.
- Bara godkänd tid räknas, om man inte väljer "All tid" som förhandsvisning. Frånvaro räknas inte.
- Under Admin → Inställningar väljer du om ej debiterbar projekttid (utbildning, internt) ska belasta TB. Standard är att den gör det.
- Fastprisprojekt räknas med sitt timpris som värde i TB, men hamnar inte i fakturaunderlaget.

Rapporten (Rapporter → TB och provision) visar underlaget för varje rad: vilka konsulter, vilken TB, och hur många konsulter som räknades per månad.

Äldre kopplingar (procent av en konsults TB) har flyttats över till regler av typen procent av TB, per månad och utan golv, så att tidigare siffror inte ändras.

### Upplupet

Upplupet är tid, utlägg och körning som är utförda men inte fakturerade. Rapporten tar tre datum:

- **Från och till** avser det datum timmarna gäller (arbetsdatum), inte när de rapporterades.
- **Fakturerat till och med** avgör vilka underlag som räknas som fakturerade. Tomt betyder idag. Sätter du det till förra månadens sista dag får du upplupet som det var då, även om underlaget skapades senare. Det är det du vill ha när du stänger en månad i efterhand. Fakturadatum sätts när underlaget skapas.

Godkänt och ej godkänt redovisas var för sig. Avslagen tid ingår inte, och avskriven tid räknas bort från avskrivningsdagen. Fastprisprojektens timmar redovisas för sig eftersom de inte faktureras per timme. Ej godkänd tid värderas med priset vid senaste sparning.

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
| Användare, kunder, projekt, provisionsregler | | | | ✔ |
| Fakturering och upplupet | | | | ✔ |

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
- Tester: `npm test` (76 tester som täcker behörigheter, tidregler, attest, provisionsregler, fakturering och upplupet).

## Begränsningar och antaganden

Jag har inte kunnat läsa Millnets egen dokumentation, så jämförelsen med Flow bygger på dina svar och allmän kännedom om hur den här typen av system fungerar. Följande saknas eller är gissningar:

- **Provisionsreglerna** är min tolkning av att provision kan hänga på procent av TB per månad eller kvartal, och på antalet konsulter i uppdrag. Hur "i uppdrag" ska avgränsas, hur kvartal räknas för trappan (jag använder snittet av månadsantalen) och om negativ provision ska finnas är inte bestämt av dig. Kontrollera med en period där du vet facit.
- **Fastprisprojekt** faktureras inte härifrån. Timmarna visas, och kan avskrivas när du fakturerat dem på annat sätt.
- **Ej debiterbar tid** kan inte göras debiterbar i fakturavyn. Ändra aktivitetens inställning och låt tiden sparas om.
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
