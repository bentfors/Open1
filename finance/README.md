# Min ekonomi

Privatekonomi med inloggning, innehav till aktuell kurs, inklistrade kontoutdrag, resultat- och balansrapport. Version 1. Månadsrapport och rådgivarvy är inte byggda än, se [Nästa steg](#nästa-steg).

Inga externa beroenden. Kräver Node.js 22.13 eller senare (SQLite ingår i Node).

```bash
cd finance
npm start            # http://127.0.0.1:3100
npm test
```

| Variabel | Standard | Betydelse |
|---|---|---|
| `PORT` / `HOST` | `3100` / `127.0.0.1` | Adress att lyssna på. Standard är bara lokalt. |
| `DATA_DIR` | `./data` | Databasen `min-ekonomi.sqlite` |
| `NODE_ENV` | | `production` slår på Secure-kakor (kräver https) |
| `COOKIE_SECURE` | `1` i production | `0` för http, till exempel lokalt |
| `TRUST_PROXY` | `0` | `1` bakom en proxy, så att IP läses ur `X-Forwarded-For` |
| `ALLOW_SIGNUP` | `1` | `0` stänger registrering när alla som ska ha konto har det |
| `PRICE_PROVIDER` | `yahoo` | `none` stänger av automatiska kurser. Då gäller manuella kurser. |
| `PRICE_TTL_MINUTES` | `15` | Hur länge en hämtad kurs återanvänds |

## Så fungerar det

**Konton och saldo.** Lönekonto, sparkonto, ISK, pension, lån och kreditkort. Saldot är ingångsvärde plus importerade transaktioner. Du anger dagens saldo, så räknas ingångsvärdet fram. Skulder lagras som negativt saldo och visas som skuld.

**Kontoutdrag.** Klistra in text från bankens webb eller en CSV. Avgränsare (tabb, semikolon, komma, |), rubrikrad, datumformat och svenska talformat (`−1 234,56`, `123,45-`) gissas, och du kan rätta kolumnkopplingen i förhandsvisningen innan något sparas. Servern tolkar texten på nytt vid import. Rader som redan importerats hoppas över (fingeravtryck på datum, belopp och text, räknat per förekomst), så överlappande utdrag är ofarliga.

**Kategorisering.** Regler matchar hela ord i texten, längsta mönster vinner. Startreglerna är få och försiktiga. När du kategoriserar en rad frågar systemet om det ska bli en regel. Motsatta belopp mellan två egna konton inom tre dagar markeras som överföring (en gissning, märkt "gissad").

**Resultatrapport.** Inkomster och utgifter per kategori, per månad, och sparkvot. Kategorier av typen *Överföring* (egna överföringar, sparande, amortering) ingår inte. Okategoriserat räknas med men redovisas på egna rader med en varning.

**Balansrapport.** Kontosaldon och värdepapper till senaste kurs minus skulder. En ögonblicksbild sparas per dag för utvecklingen över tid, men aldrig när ett innehav saknar kurs, så att ett kursbortfall inte ser ut som en förlust.

**Innehav.** Automatisk kurs via börssymbol (Yahoo Finance, till exempel `VOLV-B.ST`, `AAPL`) med valutaomräkning till SEK, eller manuell kurs. Kurserna cachas. Om kurskällan svarar fel visas senast kända kurs märkt "gammal kurs". Innehav utan någon kurs räknas inte som noll: de varnas för och lämnas utanför summan.

**Dina data.** Export av allt som JSON och radering av kontot (kräver lösenord).

## Begränsningar du bör känna till

- **Kurskällan är inofficiell.** Yahoos API är inte dokumenterat för den här användningen, kan ändras eller spärra utan förvarning, och villkoren tillåter troligen inte kommersiell vidareförmedling. Duger för personligt bruk. Gör du en tjänst av det här, byt till en licensierad källa. Leverantören är utbytbar (`createPriceService` i `src/prices.js`).
- **Svenska fonder saknar normalt börssymbol** och måste prissättas manuellt.
- **Ingen e-post.** Det finns ingen lösenordsåterställning och ingen e-postverifiering. Glömt lösenord betyder att datan är nåbar bara via databasfilen.
- **Ingen kryptering av data i vila.** Databasen är en vanlig SQLite-fil. Använd krypterad disk och säkerhetskopiera filen.
- **Ingen automatisk bankkoppling.** Kontoutdrag klistras in för hand. Open banking kräver tillstånd (AISP) eller en leverantör som Tink eller Enable Banking.
- **Inget stöd för separata debet/kredit-kolumner**, bara ett signerat belopp.
- **Balansen visar bara idag.** Saldon och värden vid ett tidigare datum räknas inte om, utöver de dagliga ögonblicksbilderna.
- **Rapporterna är inga redovisningsrapporter.** Låneräntor och avskrivningar bokförs inte automatiskt, och kontantprincipen gäller.

## Nästa steg

1. **Månadsrapport.** Samma data, per månad: avvikelser mot snittet, nya och borttappade återkommande utgifter, sparkvot, kurspåverkan på innehav, färdig att skriva ut eller maila.
2. **Rådgivarvy.** Kräver en samtyckesmodell (kunden bjuder in och kan återkalla, rådgivaren får skrivskyddad åtkomst, allt loggas) och en roll per användare. Det är den enda delen med verklig juridisk tyngd: personuppgiftsansvar (GDPR) och, om systemet ger personliga rekommendationer, krav på tillstånd för investeringsrådgivning. Låt rådgivarvyn visa nyckeltal och flaggor, inte rekommendationer.
3. Budget och mål, återkommande utgifter, lånekalkyler och pension, importmallar per bank, tvåfaktorinloggning.
