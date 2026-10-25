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

**Användare.** Roll (administratör eller användare), ekonomibehörighet, kategori (AM, BM, TA, Konsult Talent … redigerbar), chef, intern timkostnad, standardpris och arbetstid per vecka.

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
| Låsa perioder (Fakturering → Periodlåsning) | | ✔ |

Gränsen går vid sådant som är svårt att ta tillbaka eller som ändrar vad andra får göra. Den är samlad i `isFinance` och `isFinanceSuper` i `src/domain.js` och i vilken rutt som kräver vilken nivå, så den går att flytta. Superuser ser hela administrationen och kan skapa och ändra användare (namn, kategori, BM, chef, kostnad, pris, arbetstid, aktiv, lösenord). Bland inställningarna ändrar hen bara periodlåsningen, och kunder, projekt, avtal och provisionsregler är administratörens. Skrivknapparna saknas i vyerna och servern nekar skrivningarna oavsett.

Det som en superuser **inte** kan göra med användare, eftersom det vore en väg till administratörsrättigheter: ändra någons roll eller ekonomibehörighet (sin egen inklusive), skapa administratörer eller ekonomianvändare, ändra eller återställa lösenord för en administratör, eller utse sig själv till någons BM eller chef.

Spärrarna är inte vattentäta. Den som kan sätta lösenord kan logga in som den personen, och den som kan sätta BM kan peka ut en annan person hen kontrollerar. Det betyder att en superuser i praktiken kan attestera i någon annans namn. Det är en förtroendefråga, inte något systemet kan förhindra. Om det är viktigt att kunna se efteråt vem som ändrat vad behövs en ändringslogg, som inte finns än. Administratörer har alltid båda nivåerna.

**Utlägg och körjournal.** Utlägg med kvitto (JPEG, PNG, WebP eller PDF, högst 5 MB) och körd sträcka. Båda kan vidarefaktureras till kund.

**Fakturering.** Allt som rapporteras (tid, utlägg, körning) hamnar i en projektvy under Fakturering. Där väljer du rad för rad vad som ska med på ett fakturaunderlag. Det du inte väljer ligger kvar och dyker upp nästa gång, så att inget glöms bort. Under "Att fakturera" ser du alla projekt som har något ofakturerat, äldsta först. Bara godkända, debiterbara rader på löpande räkning kan faktureras. Övriga rader syns med en förklaring (väntar på attest, ej debiterbar, fast pris). Rader som aldrig ska faktureras kan avskrivas med en anledning. De lämnar då kön och upplupet men finns kvar i projektvyn.

**Upplupet.** Rapporter → Upplupet visar utfört men ännu inte fakturerat för valfri period, räknat på det datum timmarna avser. Förvalt är allt fram till sista dagen i förra månaden. Du kan gruppera på kund, projekt, användare eller månad, och exportera till CSV. Se [Upplupet](#upplupet) nedan.

**Övriga rapporter.** Tidrapport per projekt, kund, aktivitet, användare, kategori, månad, dag eller frånvarotyp, med CSV-export för svensk Excel. TB per konsult och provision.

**Periodlåsning.** Ekonomi-superuser och administratörer kan låsa perioder till ett datum (Fakturering → Periodlåsning). Då kan användare, BM och ekonomi på lägre nivå varken ändra eller attestera i perioden. Bara administratörer kan fortfarande rätta i en låst period.

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

- Måndag–fredag räknas som arbetsdagar. Röda dagar dras inte av var för sig. I stället multipliceras allt med *beläggningen* (Admin → Inställningar, standard 90 %), som ska täcka semester, sjukdom och helgdagar.
- En dag med uppdrag ger intäkt = timmar per vecka ÷ 5 × timpris. Kostnaden följer inställningen för TB.
- En dag under anställning utan uppdrag är bänk. Den räknas som negativ TB enligt bänkgränsen, med räknaren som den står enligt attesterad tid.
- Hela innevarande period räknas på avtalen. Det som attesterats hittills visas som "hittills". Passerade perioder visar utfallet.
- Konsulter som saknar uppdrag i registret räknas som bänk, och den som saknar anställningsavtal antas vara anställd tillsvidare. Båda varnas för på sidan.
- I ett scenario räknas den tänkta konsulten bara under sin uppdragstid. Hen läggs till som källa i dina TB-regler och räknas med i regler som räknar antal konsulter, oavsett kategorifilter.

Prognosen är en uppskattning. Den förutsätter att avtalen i registret stämmer och att uppdragen inte förlängs eller ersätts, vilket är precis det man vill spela med i scenariot.

### Avtalsregister

Admin → Avtal. Här registreras:

- **Anställningar:** person, typ (tillsvidare, visstid, provanställning), start- och slutdatum, uppsägningstid. En person kan inte ha två överlappande anställningar. Visstid kräver slutdatum.
- **Uppdrag:** konsult, kund, valfritt projekt, roll, start- och slutdatum (tomt = löpande), timpris och timmar per vecka. Samtidiga uppdrag får tillsammans inte överstiga personens arbetstid.

Under Admin → Användare syns hur länge varje person varit anställd och hur länge det pågående uppdraget varar. Sidan Avtal varnar för konsulter utan uppdrag eller anställningsavtal, uppdrag som inte ryms inom anställningen och uppdrag som tar slut inom 90 dagar.

### Pris

Priset på en tidspost väljs i den här ordningen: medlemmens eget pris i projektet, aktivitetens pris, projektets pris, personens standardpris. Priset fastställs när tiden **godkänns**. Prisändringar före attest slår alltså igenom, efter attest gör de inte det.

## Behörigheter

| | Användare | BM / projektledare / chef | Mottagare av provision | Ekonomi | Ekonomi-superuser | Administratör |
|---|---|---|---|---|---|---|
| Egen tid, utlägg, körjournal | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Attestera tid, utlägg, körning | | BM: sina konsulter. Annars projektledare och chef | | | | allt |
| Tidrapporter (timmar) | egen | + sina konsulter, projekt och underställda | egen | allt | allt | allt |
| Intäkter och kostnader i tidrapporter | | | | ✔ | ✔ | ✔ |
| Skapa fakturaunderlag, upplupet | | | | ✔ | ✔ | ✔ |
| Avskrivning, ångra underlag, låsa perioder | | | | | ✔ | ✔ |
| Läsa kund- och projektlistor | | | | ✔ | ✔ | ✔ |
| Kvitton | egna | de man attesterar | egna | alla | alla | alla |
| TB per konsult och provisionsrapport | | | egen provision | | ✔ | ✔ |
| Statistik och prognos | | sina konsulter | egen | | alla (läsa) | alla |
| Läsa användare, avtal, provisionsregler, projektens team och inställningar | | | | | ✔ | ✔ |
| Ändra kunder, projekt, avtal, provisionsregler, övriga inställningar | | | | | | ✔ |
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
- Tester: `npm test` (126 tester som täcker behörigheter, tidregler, attest, provisionsregler, fakturering och upplupet).

## Begränsningar och antaganden

Jag har inte kunnat läsa Millnets egen dokumentation, så jämförelsen med Flow bygger på dina svar och allmän kännedom om hur den här typen av system fungerar. Följande saknas eller är gissningar:

- **Provisionsreglerna** är min tolkning av att provision kan hänga på procent av TB per månad eller kvartal, och på antalet konsulter i uppdrag. Hur "i uppdrag" ska avgränsas, hur kvartal räknas för trappan (jag använder snittet av månadsantalen) och hur en dag med både debiterbar och odebiterbar tid ska räknas (jag låter all debiterbar tid göra dagen till ett uppdrag) har du inte bestämt. Kontrollera med en period där du vet facit.
- **Fastprisprojekt** faktureras inte härifrån. Timmarna visas, och kan avskrivas när du fakturerat dem på annat sätt.
- **Ej debiterbar tid** kan inte göras debiterbar i fakturavyn. Ändra aktivitetens inställning och låt tiden sparas om.
- **Helgdagar och normtid.** Normen är arbetstid per vecka. Röda dagar räknas inte av, varken för normtid eller i prognosen. Prognosen använder en schablon för beläggning i stället.
- **Prognosen kan inte veta det som inte är inlagt.** Förlängningar, nya affärer och uppsägningar syns först när de finns i avtalsregistret. Kvartalsregler med trappa använder snittet av månadsantalen, vilket ger lågt utfall för ett kvartal som bara delvis har uppdrag.
- **Ingen integration** mot lön eller bokföring. Export sker via CSV.
- **Ingen moms** i fakturaunderlaget. Belopp är exklusive moms.
- **Inget lösenordsåterställande via e-post.** Administratör sätter ett tillfälligt lösenord.
- **Ingen flerbolagsfunktion.** Ett företag per installation.
- **Projektledare** kan inte själva ändra team eller aktiviteter. Det gör administratör.
- **Administratör kan inte rapportera tid åt andra i gränssnittet.** API:t stödjer det.
- Ingen revisionslogg över ändringar utöver vem som godkände och när.

## Utseende

Gränssnittet är mörkt och följer xamera.se: svart bakgrund (`#030303`), kortytor utan ram (`#0a0a0a`), ljus kaki för rubriker (`#bdbd7b`), starkare kaki för länkar och knapptext (`#b2aa52`), versala knappar med grå ram och en mörkbrun primärknapp med olivram. Färgerna är uppmätta i skärmbilder av sidan, inte hämtade ur deras CSS. Alla färger och mått ligger som variabler överst i `public/css/app.css`.

Typsnittet är Space Grotesk, som jag bedömt ser ut som det Xamera använder. Det ligger lokalt i `public/fonts/` (SIL Open Font License, se `OFL.txt`), så inga anrop går till Google. Det finns inget ljust läge.

## Struktur

```
src/        server, API, databasschema och affärsregler (inga beroenden)
public/     gränssnitt i vanlig JavaScript utan byggsteg
test/       node:test, kör mot en riktig server med databas i minnet
scripts/    demodata
```
