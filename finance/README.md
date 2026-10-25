# Min ekonomi

Privatekonomi med inloggning, innehav till aktuell kurs, inklistrade kontoutdrag, resultat- och balansrapport. Version 3: hushåll, budget, mål, scenarier, månadsrapport och rådgivarvy med samtycke.

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
| `ADVISOR_ENABLED` | `1` | `0` stänger av rådgivarfunktionen helt (samtycke och rådgivarvy) |
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

## Hushåll, budget, mål och scenarier

**Hushåll.** Alla konton hör till ett hushåll. Invänd inte mot standardläget: du är ensam i ditt eget. Bjud in en annan person under Inställningar (engångskod, sju dagar), så delar ni kategorier, regler, budget, mål och scenarier. Konton är delade om de inte markerats privata. Privata konton, deras transaktioner och innehav syns bara för ägaren, och mål som länkar dem räknar dem inte för andra. Alla medlemmar kan importera till och ändra delade konton, men bara ägaren ändrar typ, delning och lånevillkor eller tar bort kontot. Med flera medlemmar finns en växel för vyn *Hushållet* eller *Bara mina*. Att gå med slår ihop kategorier på namn och ersätter din gamla budget. Att lämna ger dig ett eget hushåll med kopior av kategorierna.

**Budget.** Per kategori och månad, för inkomster och utgifter. Förslaget bygger på de tre senaste avslutade månaderna: typvärde (median) så att en engångsresa inte slår igenom, utgifter avrundade uppåt till hundralapp. Månader före din första transaktion räknas inte som noll. Förslaget sparas inte förrän du bekräftar. Uppföljningen visar budget mot utfall per kategori och månad, och visar utfall utan budget.

**Mål.** Målbelopp, datum, vad du sparar per månad och förväntad avkastning. "Sparat" är ett belopp du anger plus saldo och innehav på konton du länkar. Beräknar vad som krävs per månad, om du är på rätt väg och när målet nås, och jämför summan med månadsöverskottet.

**Scenarier.** Händelser: köp (med kontantinsats, lån, amortering, löpande kostnader, värdeutveckling och valfri försäljning), engångsbelopp och löpande ändringar. Motorn räknar månad för månad från din ekonomi idag (kassa, placeringar, skulder med ränta) och din budget, och jämför med att inte göra något. Stresstest med två procentenheter högre ränta, underskott när pengarna tar slut, skuldkvot, varning för bolån över 85 % av priset. Antagandena (avkastning, ränta på kontanter, värdeutveckling, inflation) sätts under Inställningar och är gissningar.

## Månadsrapport

Resultat mot snittet för de tre föregående månaderna, de största förändringarna per kategori, budget mot utfall, läget idag (kontanter, placeringar, skulder), mål och en lista med observationer. Observationerna är regelbaserade och kommer ur siffrorna: underskott, utgifter som sticker ut, återkommande poster som uteblivit (till exempel en lön som inte kommit), nya större utgifter, okategoriserat, gamla kontoutdrag, innehav utan kurs, buffert (tumregeln 3–6 månader), mål som ligger efter. Texterna beskriver vad siffrorna visar och aldrig vad du bör köpa eller sälja. Rapporten kan skrivas ut eller sparas som PDF via webbläsaren. Det finns ingen e-postutskick, eftersom servern inte har någon e-post.

## Rådgivare

**Samtycke.** Kunden skapar en engångskod (giltig sju dagar) och väljer nivå: *sammanfattning* (nyckeltal, rapporter, budget, mål, scenarier) eller *detaljer* (dessutom enskilda transaktioner), och hur länge samtycket gäller (högst 24 månader). Rådgivaren har ett vanligt konto och löser in koden. Samtycket är aktivt först när alla nuvarande hushållsmedlemmar godkänt det. Går en ny person med i hushållet vilar samtycket tills hen godkänt. Vem som helst i hushållet kan återkalla direkt. Ett återkallat samtycke kan inte återupplivas.

**Vad rådgivaren ser.** Bara det som är delat. Privata konton, deras transaktioner och innehav, och till och med att ett privat konto finns länkat till ett mål, syns aldrig. Rådgivaren kan bara läsa. Varje öppnad sida loggas, och kunden ser loggen under Inställningar.

**Samtalspunkter.** Rådgivarvyn har samma observationer som månadsrapporten plus en lista med punkter att ta upp: stor andel kontanter, koncentration i värdepapper (ett innehav över en fjärdedel), inget pensionskonto registrerat, inga försäkringspremier synliga, skuldsättning, dyra skulder, låg sparkvot, inga mål. Kunden ser samma lista i sin månadsrapport. Punkterna är underlag för ett samtal. De är tumregler och kan bero på uppgifter som saknas i appen.

**Anteckningar.** Rådgivaren kan skriva egna anteckningar per kund. Kunden ser dem aldrig. De stannar hos rådgivaren när samtycket upphör (men kan inte kompletteras), eftersom rådgivaren själv ansvarar för sin dokumentation.

## Begränsningar du bör känna till

- **Rådgivarfunktionen är ingen färdig tjänst för en reglerad verksamhet.** Det finns ingen identifiering av rådgivaren (vem som helst med ett konto kan lösa in en kod du ger bort), ingen kontroll av tillstånd hos Finansinspektionen, inget personuppgiftsbiträdesavtal, ingen gallringsrutin, ingen tvåfaktorinloggning och ingen revisionssäker logg (loggen är en tabell som en databasadministratör kan ändra). Kunden ansvarar för att koden ges till rätt person. Den som driver tjänsten är personuppgiftsansvarig eller biträde för kundernas ekonomiska uppgifter och behöver rutiner, rättslig grund och information till de registrerade enligt GDPR.
- **Observationerna är inte rådgivning.** Ger tjänsten automatiska personliga rekommendationer om finansiella instrument kan det kräva tillstånd. Därför innehåller texterna bara iakttagelser. Låt en jurist granska formuleringarna innan tjänsten erbjuds andra.

- **Scenarier är räkneövningar, inte förutsägelser.** Resultatet bestäms av antagandena. Skatt, ränteavdrag, bidrag och bankens kreditprövning är inte modellerade, och inkomsten är det som sätts in på kontot. Skuldkvoten är räknad på inkomst efter skatt och går därför inte att jämföra med bankens.
- **Standardvärdena för hus och båt är gissningar** (ränta, amorteringstid, driftkostnad, värdeutveckling). Byt mot dina egna.
- **Prognosen gäller hushållet som du ser det.** Delar en partner ett privat konto med dig inte syns det inte i din prognos.

- **Kurskällan är inofficiell.** Yahoos API är inte dokumenterat för den här användningen, kan ändras eller spärra utan förvarning, och villkoren tillåter troligen inte kommersiell vidareförmedling. Duger för personligt bruk. Gör du en tjänst av det här, byt till en licensierad källa. Leverantören är utbytbar (`createPriceService` i `src/prices.js`).
- **Svenska fonder saknar normalt börssymbol** och måste prissättas manuellt.
- **Ingen e-post.** Det finns ingen lösenordsåterställning och ingen e-postverifiering. Glömt lösenord betyder att datan är nåbar bara via databasfilen.
- **Ingen kryptering av data i vila.** Databasen är en vanlig SQLite-fil. Använd krypterad disk och säkerhetskopiera filen.
- **Ingen automatisk bankkoppling.** Kontoutdrag klistras in för hand. Open banking kräver tillstånd (AISP) eller en leverantör som Tink eller Enable Banking.
- **Inget stöd för separata debet/kredit-kolumner**, bara ett signerat belopp.
- **Raderar du ditt konto försvinner konton du äger, även delade.** Kategorier och regler stannar hos de andra.
- **Balansen visar bara idag.** Saldon och värden vid ett tidigare datum räknas inte om, utöver de dagliga ögonblicksbilderna.
- **Rapporterna är inga redovisningsrapporter.** Låneräntor och avskrivningar bokförs inte automatiskt, och kontantprincipen gäller.

## Nästa steg

1. E-postutskick av månadsrapporten och påminnelse när den är klar (kräver e-post, som saknas).
2. Identifiering och tvåfaktorinloggning för rådgivare, rådgivarregister och en riktig revisionslogg.
3. Budget och mål, återkommande utgifter, lånekalkyler och pension, importmallar per bank, tvåfaktorinloggning.
