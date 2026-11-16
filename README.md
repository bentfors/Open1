# x-time

Tidrapportering med användare, kunder och projekt. Byggd efter samma grundmodell som Millnets tidigare Milltime (idag Milient Time Flow), men det här är ett eget system och inte en kopia. Se [Begränsningar och antaganden](#begränsningar-och-antaganden).

Inga externa beroenden. Kräver Node.js 22.13 eller senare (SQLite ingår i Node).

## Kom igång

**Windows:** dubbelklicka på `Starta x-time demo.cmd` för att prova med påhittad data, eller `Starta x-time.cmd` för att köra med riktig data. Webbläsaren öppnas av sig själv. Stäng fönstret för att stoppa. Filerna går inte via npm, så PowerShells spärr mot `npm.ps1` spelar ingen roll.

**Terminal (alla system):**

```bash
npm start                 # http://localhost:3000
```

Är Node för gammalt säger x-time det och avbryter, i stället för att krascha med ett obegripligt fel.

Första gången databasen är tom skapas grunddata och en administratör:

- Sätt `XTIME_ADMIN_EMAIL` och `XTIME_ADMIN_PASSWORD` (minst 10 tecken) för att välja själv, eller
- låt x-time skapa ett slumpat lösenord som skrivs ut **en gång** i terminalen. Det måste bytas vid första inloggningen.

Utan `COOKIE_SECURE=0` kräver `NODE_ENV=production` https, annars sparar webbläsaren aldrig inloggningskakan.

### Prova med demodata

```bash
npm run demo              # http://127.0.0.1:3000, egen databas i data-demo/
```

Demokontona har kända lösenord (`demo-password-1`) och lyssnar bara på 127.0.0.1. Använd aldrig demoläget mot riktig data. Ta bort mappen `data-demo/` för att börja om med nya demodata.

| Konto | Visar |
|---|---|
| `admin@demo.test` | allt |
| `ekonomi@demo.test` | ekonomi-superuser: fakturering, löneunderlag, budget, TB och provision |
| `ekonomi1@demo.test` | ekonomi på lägre nivå: fakturering och underkonsulter |
| `bm@demo.test` | BM: översikt, attest, inrapportering, debiteringsgrad, statistik |
| `am@demo.test`, `ta@demo.test` | provision och statistik för Account Manager och Talent Acquisition |
| `erik@demo.test`, `nora@demo.test`, `tim@demo.test` | konsulter |
| `sara@demo.test` | studentkonsult på timlön, 16 timmar i veckan |
| `ulf@demo.test` | underkonsult |

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

**Översikt.** Startsidan samlar det var och en behöver göra: den egna veckan och veckor som inte är inskickade, avslaget att rätta, att attestera, inrapporteringen för dem man följer upp, uppdrag som tar slut, och för ekonomi förra månadens fakturering, periodlåsning, löneunderlag och luckor i avtalsregistret. BM, chefer, ekonomi och administratörer börjar på översikten, konsulter på tidrapporteringen.

**Användare.** Roll (administratör eller användare), ekonomibehörighet, kategori (AM, BM, TA, Konsult Talent … redigerbar), chef, BM, kostnadsställe, ersättningsform (månadslön, timlön eller underkonsult), intern timkostnad, standardpris och arbetstid per vecka.

**Attest.** Varje konsult har en **BM (konsultchef)**, som attesterar allt hen rapporterar: tid (projekttid och frånvaro), utlägg och körningar, oavsett projekt. BM sätts på användaren under Admin → Användare. Har en användare ingen BM gäller den äldre ordningen: projektledaren attesterar på sina projekt, och det som saknar projektledare går till den anställdes chef. Ingen attesterar sin egen rad, utom administratör. Avslag kräver en anledning och går tillbaka till användaren. Administratör kan öppna godkänd tid igen (Attest → Godkända).

**Fakturering avgörs av ekonomi, inte av den som attesterar.** Attest svarar på "stämmer det som rapporterats?". Vad som sedan faktureras, avskrivs eller räknas upp i upplupet avgörs av ekonomiadministratörer. De har egen behörighet på användaren (Admin → Användare → Ekonomibehörighet) i två nivåer, och inga andra administratörsrättigheter. Den som attesterar kan alltså inte fakturera, och den som fakturerar kan inte attestera andras tid.

| | Ekonomi | Ekonomi-superuser |
|---|---|---|
| Se projekt och kunder att fakturera, välja rader, skapa fakturaunderlag, CSV | ✔ | ✔ |
| Upplupet och tidrapporter med pengar för alla | ✔ | ✔ |
| TB per konsult och provisionsrapporten för alla mottagare (läsa, inte ändra regler) | | ✔ |
| Läsa hela administrationen (användare, kunder, projekt med team, avtal, provisionsregler, kategorier, inställningar) och allas statistik och prognos | | ✔ |
| Skapa och ändra användare och sätta lösenord (inte roll, ekonomibehörighet eller administratörers konton) | | ✔ |
| Avskriva och ångra avskrivning | | ✔ |
| Ångra ett skapat fakturaunderlag | | ✔ |
| Låsa perioder (Ekonomi → Periodlåsning) | | ✔ |
| Månadsfakturering | ✔ | ✔ |
| Inköpsunderlag för underkonsulter | ✔ | ✔ |
| Löneunderlag | | ✔ |
| Budget per kostnadsställe | | ✔ |

Gränsen går vid sådant som är svårt att ta tillbaka eller som ändrar vad andra får göra. Den är samlad i `isFinance` och `isFinanceSuper` i `src/domain.js` och i vilken rutt som kräver vilken nivå, så den går att flytta. Superuser ser hela administrationen och kan skapa och ändra användare (namn, kategori, BM, chef, kostnad, pris, arbetstid, aktiv, lösenord). Bland inställningarna ändrar hen bara periodlåsningen, och kunder, projekt, avtal och provisionsregler är administratörens. Skrivknapparna saknas i vyerna och servern nekar skrivningarna oavsett.

Det som en superuser **inte** kan göra med användare, eftersom det vore en väg till administratörsrättigheter: ändra någons roll eller ekonomibehörighet (sin egen inklusive), skapa administratörer eller ekonomianvändare, ändra eller återställa lösenord för en administratör, eller utse sig själv till någons BM eller chef.

Spärrarna är inte vattentäta. Den som kan sätta lösenord kan logga in som den personen, och den som kan sätta BM kan peka ut en annan person hen kontrollerar. Det betyder att en superuser i praktiken kan attestera i någon annans namn. Det är en förtroendefråga, inte något systemet kan förhindra. Det som går att göra är att se det efteråt: varje lösenordsändring och BM-ändring står i [ändringsloggen](#ändringslogg). Administratörer har alltid båda nivåerna.

**Helgdagar och normtid.** Svenska helgdagar räknas fram per år (påsken med den gregorianska algoritmen, midsommar och alla helgons dag efter veckodag). Midsommar-, jul- och nyårsafton räknas som lediga, vilket går att stänga av under Admin → Inställningar. Normtiden är arbetstiden per vecka delad på fem, på arbetsdagar under anställningen. Veckovyn visar helgdagen i rubriken och räknar normtiden därefter, till exempel 32 timmar en vecka med Kristi himmelsfärd.

**Utlägg och körjournal.** Utlägg med kvitto (JPEG, PNG, WebP eller PDF, högst 5 MB) och körd sträcka. Båda kan vidarefaktureras till kund.

**Fakturering.** Menyn heter **Ekonomi**. Allt som rapporteras (tid, utlägg, körning) hamnar i en projektvy under Ekonomi. Där väljer du rad för rad vad som ska med på ett fakturaunderlag. Det du inte väljer ligger kvar och dyker upp nästa gång, så att inget glöms bort. Under "Att fakturera" ser du alla projekt som har något ofakturerat, äldsta först. Bara godkända, debiterbara rader på löpande räkning kan faktureras. Övriga rader syns med en förklaring (väntar på attest, ej debiterbar, fast pris). Rader som aldrig ska faktureras kan avskrivas med en anledning. De lämnar då kön och upplupet men finns kvar i projektvyn.

**Månadsfakturering.** Ekonomi → Månadsfakturering visar per kund vad som kan faktureras för en månad (förvalt förra månaden, med äldre ofakturerat), vad som väntar på attest och vad som inte är inskickat. Valda kunder får ett underlag var i ett steg, allt eller inget. Det som inte är klart ligger kvar till nästa gång.

**Underlag för ekonomisystemet.** Kunder har kundnummer, aktiviteter har artikelnummer, och utlägg och körningar har varsitt artikelnummer under Admin → Inställningar. Underlagets CSV har en rad per artikel med kundnummer, artikelnummer, projektnummer och konsultens kostnadsställe, alltså de fält en fakturarad har i ett ekonomisystem som Fortnox. Det finns ingen direkt koppling till Fortnox; se [Begränsningar](#begränsningar-och-antaganden).

**Löneunderlag.** Ekonomi → Löneunderlag visar för en månad attesterad frånvaro per typ (timmar och dagar), utlägg att ersätta, milersättning uppdelad i skattefri del (Skatteverkets 25 kr/mil för egen bil, inställbart) och skattepliktig del, och arbetade timmar för timlönade. Det som inte är attesterat visas som en varning och är inte med. Månadslönade utan avvikelser är inte med. Exporteras som en sammanställning per person eller en rad per löneart, med lönearter från frånvarotyperna och inställningarna. Bara ekonomi-superuser och administratörer ser det, eftersom det innehåller sjukfrånvaro.

**Underkonsulter.** En person med ersättningsformen underkonsult får ingen lön. Ekonomi → Underkonsulter visar attesterade timmar × inköpspris (timkostnaden när tiden attesterades) per projekt, att stämma av mot underkonsultens faktura, med vad som debiterats kunden. Underkonsulter behöver inget anställningsavtal och kostar ingenting i prognosen när de saknar uppdrag.

**Kostnadsställen och budget.** Kostnadsställen (KST) läggs upp under Admin → Kostnadsställen och kopplas till personer. Tidrapporten och debiteringsgraden kan grupperas på KST. Ekonomi → Budget visar budget per KST och månad för intäkt och TB, mot attesterat utfall för passerade månader och en prognos ur avtalsregistret för innevarande och kommande, med avvikelse per månad och helår. Budgeten matas in per KST, med jämn fördelning av ett årsbelopp om man vill.

**Inrapportering.** Rapporter → Inrapportering visar vecka för vecka vem som saknar tid, har utkast kvar, fått rader avslagna eller väntar på attest. BM ser sina konsulter, chefer sina underställda och ekonomi alla som förväntas rapportera. Innevarande vecka räknas inte som försenad.

**Debiteringsgrad.** Rapporter → Debiteringsgrad visar debiterbar tid av tillgänglig tid (normtid minus frånvaro) per person, BM, kategori, kostnadsställe eller månad. Ekonomi ser också intäkt och snittpris. Som konsult räknas den som har en BM, ett uppdrag eller debiterbar tid i perioden, så att administration och ledning inte drar ner siffran. Var och en ser sin egen.

**Rapportera åt någon annan.** En administratör kan välja person i veckovyn och rapportera, skicka in och ta tillbaka åt hen, till exempel när en konsult är sjuk. Det som ändras syns i ändringsloggen.

**Upplupet.** Rapporter → Upplupet visar utfört men ännu inte fakturerat för valfri period, räknat på det datum timmarna avser. Förvalt är allt fram till sista dagen i förra månaden. Du kan gruppera på kund, projekt, användare eller månad, och exportera till CSV. Se [Upplupet](#upplupet) nedan.

**Övriga rapporter.** Tidrapport per projekt, kund, aktivitet, användare, kategori, kostnadsställe, månad, dag eller frånvarotyp, med CSV-export för svensk Excel. TB per konsult och provision.

**Periodlåsning.** Ekonomi-superuser och administratörer kan låsa perioder till ett datum (Ekonomi → Periodlåsning). Då kan användare, BM och ekonomi på lägre nivå varken ändra eller attestera i perioden. Bara administratörer kan fortfarande rätta i en låst period.

### Ändringslogg

Admin → Ändringslogg visar vem som ändrat vad, och går att sortera och filtrera på nästan allt: utförd av, typ av ändring (skapad, ändrad, borttagen, lösenord satt, godkänd, avslagen, öppnad igen, avskriven, ångrad), vad ändringen avser (användare, kund, projekt, provisionsregel …), berörd kund, berört projekt och berörd användare, datum och fritext. Klicka på en kolumnrubrik för att sortera, eller på ett namn i tabellen för att filtrera på det. Det går att exportera urvalet till CSV. Ekonomi-superuser och administratörer läser loggen.

Varje rad visar tidpunkt, vem som gjorde det, vad som berördes och före och efter för varje ändrat fält (id:n visas som namn, till exempel `BM: – → Cia BM`). Namn sparas som de hette när ändringen gjordes, så ett namnbyte eller en borttagning skriver inte om historiken. Lösenord loggas aldrig, bara att ett tillfälligt lösenord sattes.

**Loggas:** användare (inklusive lösenord, roll, BM, kostnad), kunder, projekt, projektmedlemmar och aktiviteter, kategorier, frånvarotyper, provisionsregler (inklusive vilka konsulter och trappsteg som ingår, och hur en borttagen regel såg ut), anställningar och uppdrag, inställningar och periodlåsning, fakturaunderlag (skapat och ångrat), avskrivning och återställning, attest (godkänt, avslaget, öppnat igen, en rad per anrop med antal), samt tid, utlägg och körningar som någon ändrat åt en annan person eller en administratör ändrat i en låst period.

**Loggas inte:** egen tid och egna utlägg, inloggningar, vem som tittat på vad, och ändringar som görs direkt i databasfilen.

Loggen skrivs i samma transaktion som ändringen, så en ändring utan loggrad kan inte uppstå, och en misslyckad ändring lämnar ingen rad. Raderna kan inte ändras eller tas bort: det finns inga rutter som skriver till loggen och databasen stoppar `UPDATE` och `DELETE` med triggers. Den som har tillgång till själva databasfilen kan ändå ta bort triggers och skriva om loggen, så den skyddar mot missbruk i programmet, inte mot den som har serverns filer. Loggen växer utan gräns. Gamla rader rensas aldrig, så planera in sådant själv om den blir stor.

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
- **Kvartal** är kalenderkvartal: Q1 = januari–mars, Q2 = april–juni, Q3 = juli–september, Q4 = oktober–december. Kvartalsregler summerar TB över hela kvartalet, så en dålig månad nettas mot en bra. Månadsregler räknas för sig.
- **Negativa bidrag och golv**: en enskild konsult får bidra med negativ TB, och bidragen från reglens konsulter summeras. Provisionen per regel och period kan däremot aldrig bli lägre än 0. Ett negativt utfall på en regel kvittas inte mot en annan regel. Golvet går inte att stänga av.
- **Bänkgräns**: en konsult som saknar debiterbar tid räknas bara som negativ de första **300 timmarna** i sträck. Därefter bidrar hen med 0 tills hen har debiterbar tid igen, och då börjar räkningen om från noll nästa gång. Gränsen ställs in under Admin → Inställningar (tomt = ingen gräns) och gäller alla TB-baserade regler. Så avgörs det:
  - Räknaren går per arbetsdag. En dag med minst en debiterbar timme räknas som uppdrag, nollställer räknaren, och hela dagen räknas som vanligt.
  - Dagar med bara odebiterbar projekttid (utbildning, internt, väntan) räknas upp. Frånvaro ändrar ingenting.
  - Räknaren tar med historiken före perioden, så en månad räknas rätt även om bänktiden började tidigare.
  - Bara attesterad tid räknas. En ej attesterad uppdragsdag nollställer inte räknaren.
  - Rapporten Underlag visar verklig TB, TB för provision och hur många timmar som låg över gränsen. Rapporten TB per konsult visar alltid verklig TB.
- Regler kan ha giltighetstid. Bara tid inom den räknas.
- Perioder räknas alltid hela, även om du väljer ett kortare intervall i rapporten, och markeras som pågående tills de är slut.
- **Bara attesterad tid räknas**, både för TB och för antalet konsulter i uppdrag. Det finns ingen förhandsvisning på ej attesterad tid. Frånvaro räknas inte.
- Under Admin → Inställningar väljer du om ej debiterbar projekttid (utbildning, internt) ska belasta TB. Standard är att den gör det.
- Fastprisprojekt räknas med sitt timpris som värde i TB, men hamnar inte i fakturaunderlaget.

Rapporten (Rapporter → TB och provision) visar underlaget för varje rad: vilka konsulter, vilken TB, och hur många konsulter som räknades per månad.

Äldre kopplingar (procent av en konsults TB) har flyttats över till regler av typen procent av TB, per månad. De följer nu golvet och bänkgränsen, så tidigare negativa eller bänkbelastade siffror kan ha ändrats.

### Upplupet

Upplupet är tid, utlägg och körning som är utförda men inte fakturerade. Rapporten tar tre datum:

- **Från och till** avser det datum timmarna gäller (arbetsdatum), inte när de rapporterades.
- **Fakturerat till och med** avgör vilka underlag som räknas som fakturerade. Tomt betyder idag. Sätter du det till förra månadens sista dag får du upplupet som det var då, även om underlaget skapades senare. Det är det du vill ha när du stänger en månad i efterhand. Fakturadatum sätts när underlaget skapas.

Godkänt och ej godkänt redovisas var för sig. Avslagen tid ingår inte, och avskriven tid räknas bort från avskrivningsdagen. Fastprisprojektens timmar redovisas för sig eftersom de inte faktureras per timme. Ej godkänd tid värderas med priset vid senaste sparning.

### Statistik och prognos

Menyvalet **Statistik** visas för den som har provisionsregler eller är BM för någon. Var och en ser bara sin egen vy. Administratörer kan välja vem de tittar på.

- **Mina konsulter:** de man är BM för plus de vars TB ingår i ens regler. För varje konsult visas anställningstid, pågående och kommande uppdrag (kund, slutdatum, dagar kvar, timpris), TB förra månaden, TB hittills denna månad och prognostiserad TB de närmaste tre månaderna. Konsulter utan uppdrag märks som bänk.
- **Nyckeltal:** konsulter i uppdrag, TB förra månaden, intjänat i år, prognos för kommande 12 månader och antal uppdrag som löper ut inom 120 dagar.
- **Diagram:** provision per månad, utfall och prognos. Provisionen redovisas den månad perioden slutar, alltså när den tjänats in. En kvartalsregel hamnar i kvartalets sista månad.
- **Uppdrag som löper ut:** med vad de är värda för dig, alltså hur mycket prognosen sjunker om uppdraget inte förlängs.
- **Per regel och period:** utfall, pågående och prognos, med underlag för varje rad.
- **Vad händer om jag säljer in mer?** Lägg in en tänkt försäljning (antal konsulter, timpris, timkostnad, start, längd) och se vad den ger i provision, månad för månad, och om den tar dig upp ett trappsteg.

**Så räknas prognosen.** Varje konsult simuleras arbetsdag för arbetsdag utifrån avtalsregistret, och provisionen räknas sedan av exakt samma motor som utfallet. Alltså gäller samma trappa, golv vid 0 och bänkgräns.

- Måndag–fredag utom helgdagar (och aftnarna, om inställningen säger så) räknas som arbetsdagar. Allt multipliceras dessutom med *beläggningen* (Admin → Inställningar, standard 90 %), som ska täcka semester och sjukdom.
- En dag med uppdrag ger intäkt = timmar per vecka ÷ 5 × timpris. Kostnaden följer inställningen för TB.
- En dag under anställning utan uppdrag är bänk. Den räknas som negativ TB enligt bänkgränsen, med räknaren som den står enligt attesterad tid.
- Hela innevarande period räknas på avtalen. Det som attesterats hittills visas som "hittills". Passerade perioder visar utfallet.
- Konsulter som saknar uppdrag i registret räknas som bänk, och den som saknar anställningsavtal antas vara anställd tillsvidare. Båda varnas för på sidan. Underkonsulter är undantagna: de kostar bara under uppdrag.
- I ett scenario räknas den tänkta konsulten bara under sin uppdragstid. Hen läggs till som källa i dina TB-regler och räknas med i regler som räknar antal konsulter, oavsett kategorifilter.

Prognosen är en uppskattning. Den förutsätter att avtalen i registret stämmer och att uppdragen inte förlängs eller ersätts, vilket är precis det man vill spela med i scenariot.

### Avtalsregister

Admin → Avtal. Här registreras:

- **Anställningar:** person, typ (tillsvidare, visstid, provanställning), start- och slutdatum, uppsägningstid. En person kan inte ha två överlappande anställningar. Visstid kräver slutdatum.
- **Uppdrag:** konsult, kund, valfritt projekt, roll, start- och slutdatum (tomt = löpande), timpris och timmar per vecka. Samtidiga uppdrag får tillsammans inte överstiga personens arbetstid.

Under Admin → Användare syns hur länge varje person varit anställd och hur länge det pågående uppdraget varar. Sidan Avtal varnar för:

- konsulter utan uppdrag eller anställningsavtal (underkonsulter behöver inget)
- uppdrag som inte ryms inom anställningen och uppdrag som tar slut inom 90 dagar
- uppdrag vars timpris skiljer sig från det som faktiskt debiteras i projektet, så att prognos och provision stämmer med fakturan
- konsulter utan kostnadsställe, när kostnadsställen används
- underkonsulter utan inköpspris

### Pris

Priset på en tidspost väljs i den här ordningen: medlemmens eget pris i projektet, aktivitetens pris, projektets pris, personens standardpris. Priset fastställs när tiden **godkänns**. Prisändringar före attest slår alltså igenom, efter attest gör de inte det.

## Behörigheter

| | Användare | BM / projektledare / chef | Mottagare av provision | Ekonomi | Ekonomi-superuser | Administratör |
|---|---|---|---|---|---|---|
| Översikt (med det som gäller en själv) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Egen tid, utlägg, körjournal | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Rapportera tid åt någon annan | | | | | | ✔ |
| Attestera tid, utlägg, körning | | BM: sina konsulter. Annars projektledare och chef | | | | allt |
| Tidrapporter (timmar) | egen | + sina konsulter, projekt och underställda | egen | allt | allt | allt |
| Intäkter och kostnader i tidrapporter | | | | ✔ | ✔ | ✔ |
| Inrapportering | | BM och chef: sina | | alla | alla | alla |
| Debiteringsgrad | egen | BM och chef: sina | egen | alla, med intäkt | alla, med intäkt | alla, med intäkt |
| Månadsfakturering, inköpsunderlag för underkonsulter | | | | ✔ | ✔ | ✔ |
| Löneunderlag, budget per kostnadsställe | | | | | ✔ | ✔ |
| Skapa fakturaunderlag, upplupet | | | | ✔ | ✔ | ✔ |
| Avskrivning, ångra underlag, låsa perioder | | | | | ✔ | ✔ |
| Läsa kund- och projektlistor | | | | ✔ | ✔ | ✔ |
| Kvitton | egna | de man attesterar | egna | alla | alla | alla |
| TB per konsult och provisionsrapport | | | egen provision | | ✔ | ✔ |
| Statistik och prognos | | sina konsulter | egen | | alla (läsa) | alla |
| Läsa användare, avtal, provisionsregler, projektens team och inställningar | | | | | ✔ | ✔ |
| Läsa ändringsloggen | | | | | ✔ | ✔ |
| Ändra kunder, projekt, avtal, provisionsregler, kostnadsställen, övriga inställningar | | | | | | ✔ |
| Ändra användare | | | | | ✔, utom roll, ekonomibehörighet och administratörer | ✔ |

Ekonomi ser kundens pengar men inte provisioner. Det gör bara ekonomi-superuser och administratörer. Projektledare och BM ser timmar men inte pengar.

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
- Tester: `npm test`, 186 tester mot en riktig server med databas i minnet: behörigheter, tidregler, helgdagar, attest, provisionsregler, prognos, fakturering, månadsfakturering, upplupet, inrapportering, debiteringsgrad, löneunderlag, budget, översikt och ändringsloggen. Siffrorna i testerna är räknade för hand.
- Ändringsloggen ligger i samma databas (`audit_log`) och följer med säkerhetskopian.

## Begränsningar och antaganden

Jag har inte kunnat läsa Millnets egen dokumentation, så jämförelsen med Flow bygger på dina svar och allmän kännedom om hur den här typen av system fungerar. Följande saknas eller är gissningar:

- **Provisionsreglerna** är min tolkning av att provision kan hänga på procent av TB per månad eller kvartal, och på antalet konsulter i uppdrag. Hur "i uppdrag" ska avgränsas, hur kvartal räknas för trappan (jag använder snittet av månadsantalen) och hur en dag med både debiterbar och odebiterbar tid ska räknas (jag låter all debiterbar tid göra dagen till ett uppdrag) har du inte bestämt. Kontrollera med en period där du vet facit.
- **Fastprisprojekt** faktureras inte härifrån. Timmarna visas, och kan avskrivas när du fakturerat dem på annat sätt.
- **Ej debiterbar tid** kan inte göras debiterbar i fakturavyn. Ändra aktivitetens inställning och låt tiden sparas om.
- **Normtid för deltid** fördelas jämnt på fem dagar. En student på 16 timmar i veckan har alltså 3,2 timmars norm per dag, även om hen jobbar två hela dagar. Veckans summa blir rätt, men en vecka med helgdag på en dag hen inte jobbar får för låg norm.
- **Kostnadsställe** räknas på personens nuvarande kostnadsställe, även för gammal tid. Flyttar någon mellan kontor flyttar hela historiken med i budget och rapporter.
- **Budgetens prognos** för innevarande månad är hela månaden enligt avtalen, inte utfallet hittills plus resten.
- **Löneunderlaget räknar inte lön.** Det samlar timmar, frånvaro och ersättningar. Sjuklön, karensavdrag, semesterersättning och skatt räknar lönesystemet. Lönearterna är tomma tills ni fyller i era egna.
- **Prognosen kan inte veta det som inte är inlagt.** Förlängningar, nya affärer och uppsägningar syns först när de finns i avtalsregistret. Kvartalsregler med trappa använder snittet av månadsantalen, vilket ger lågt utfall för ett kvartal som bara delvis har uppdrag.
- **Ingen direkt integration** mot Fortnox, lönesystem eller bokföring. Underlag, löneunderlag och inköp exporteras som CSV med kundnummer, artikelnummer, lönearter och kostnadsställe, men de förs inte över automatiskt.
- **Ingen moms** i fakturaunderlaget. Belopp är exklusive moms.
- **Inget lösenordsåterställande via e-post.** Administratör sätter ett tillfälligt lösenord.
- **Ingen flerbolagsfunktion.** Ett företag per installation.
- **Projektledare** kan inte själva ändra team eller aktiviteter. Det gör administratör.
- **Ändringsloggen** täcker administration, fakturering och attest, men inte egen tid, egna utlägg eller inloggningar. Se [Ändringslogg](#ändringslogg).

## Anpassat efter Xamera

Det jag vet om Xamera och hur det har styrt systemet. Det mesta kommer från dig. Det som kommer från offentliga källor eller dina skärmbilder är markerat, och de delarna bör du kontrollera.

- **Från dig:** kategorierna (AM, BM, TA, Konsult Talent/Next/Expert, Underkonsult, OH, Chef), att BM attesterar allt för sina konsulter, att ekonomi fakturerar i två nivåer, provision på TB per månad och kvartal och per konsult i uppdrag, golvet vid 0 och bänkgränsen på 300 timmar, fasta kalenderkvartal och att bara attesterad tid räknas.
- **Från offentliga källor:** Xamera arbetar med långsiktig talangförsörjning av unga ingenjörer och studenter inom IT, teknik och ekonomi, med kontor i bland annat Linköping och Stockholm, och har Business Managers, Account Managers och Talent Acquisition. Därför finns timlön för studentkonsulter, provision för TA på rekryterade konsulter i demon, och kostnadsställen per kontor. Det är min tolkning, inte något Xamera har bekräftat.
- **Från din skärmbild:** mappnamn som "BUDGET KST 2027", "Fakturering månad", "Prognoser" och "Löner" ledde till budget per kostnadsställe, månadsfakturering och löneunderlag. Att fakturaunderlagen har kolumner som i Fortnox bygger på att Fortnox verkar användas hos er. Det är en gissning.

xamera.se gick inte att läsa härifrån (nätverket i miljön där systemet byggdes släppte inte igenom sidan), så designen bygger på dina skärmbilder.

## Utseende

Gränssnittet är mörkt och följer xamera.se: svart bakgrund (`#030303`), kortytor utan ram (`#0a0a0a`), ljus kaki för rubriker (`#bdbd7b`), starkare kaki för länkar och knapptext (`#b2aa52`), versala knappar med grå ram och en mörkbrun primärknapp med olivram. Färgerna är uppmätta i skärmbilder av sidan, inte hämtade ur deras CSS. Alla färger och mått ligger som variabler överst i `public/css/app.css`.

Typsnittet är Space Grotesk, som jag bedömt ser ut som det Xamera använder. Det ligger lokalt i `public/fonts/` (SIL Open Font License, se `OFL.txt`), så inga anrop går till Google. Det finns inget ljust läge.

## Struktur

```
src/        server, API, databasschema och affärsregler (inga beroenden). src/start.js är startpunkten.
public/     gränssnitt i vanlig JavaScript utan byggsteg
test/       node:test, kör mot en riktig server med databas i minnet
scripts/    demodata
*.cmd       startfiler för Windows
```
