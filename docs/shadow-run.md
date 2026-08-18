# Skuggkörning: Fortnox → Accounted

Plan och verktyg för att köra ett open source-bokföringssystem parallellt med
Fortnox under hösten 2026, för att kunna avgöra inför räkenskapsåret 2027 om det
håller att byta.

## Var arbetet står (2026-08-18)

Allt nedan ligger på branchen `claude/open-source-accounting-p9lhy4`.

**Klart och verifierat**

- `src/sie.ts` — SIE-läsare och diff. 22 enhetstester, körda mot CP437-kodade
  filer. Hanterar CP437/latin1/UTF-8 och avkodar svenska kontonamn rätt.
- `noxctl sie diff` — verifierad offline mot riktiga SIE-filer, både tabell- och
  JSON-utdata, och `--exit-code`.
- `skills/shadow-close/` — månadsrutinen som delad skill, symlänkad till
  `.claude/skills/` och listad i `AGENTS.md` för Codex och Pi.

**Byggt men otestat**

- `noxctl sie export` — mot `/3/sie/{Type}`, som finns i Fortnox OpenAPI-spec.
  **Inget skarpt anrop har gjorts.** Kräver `bookkeeping`-scope. Kör
  `noxctl sie export --file - | head -c 200` som allra första åtgärd; ser det ut
  som en SIE-header (`#FLAGGA`, `#PROGRAM`) är resten av kedjan trovärdig.

**Inte påbörjat**

- Instansen på `huginmunin`. Ingenting är installerat, konfigurerat eller startat.

### Nästa åtgärder, i ordning

1. Rök-testa `noxctl sie export` skarpt (se ovan).
2. Exportera RÅ 2025 och 2026 till `~/skugga/` som utgångsläge och säkerhetskopia.
3. Sätt upp Accounted på `huginmunin` enligt deras `docs/SELF-HOSTING.md`,
   sektionen *"Fully Self-Hosted (No Supabase Cloud)"*.
4. Importera de två SIE-filerna i instansen.
5. Från september: bokför oberoende i båda systemen, kör `shadow-close` varje
   månadsskifte.

### Fällor som redan är kartlagda

Deras compose-filer validerar (`docker compose config` rent för basen och
`resources`-overlayn; `caddy`-overlayn kräver `DOMAIN` satt i `.env`). Men:

- **Klon-instruktionen i deras doc är trasig** — `git clone .../gnubok.git`
  följt av `cd Accounted` matchar inte katalogen som skapas. Projektet håller på
  att byta namn från gnubok till Accounted och docs har inte hunnit med.
- **Migrationerna körs med `psql`, inte `supabase db push`** — CLI:t antar ett
  molnprojekt. Loopa `supabase/migrations/*.sql` in i `supabase-db`-containern.
- **GoTrue måste ha callback-URL:erna i `ADDITIONAL_REDIRECT_URLS`** och
  auth-containern startas om, annars fungerar inte inloggningen.
- **App-containern och Supabases `kong` måste dela ett externt Docker-nätverk**
  för att reverse-proxyn ska nå båda.
- **`pg_cron`** (migration 048) fungerar i den self-hostade stacken men kräver
  betald plan i Supabase moln. Går den inte igenom: hoppa över den, cron-sidecaren
  gör samma jobb över HTTP.

### Öppna frågor

- Är digital inlämning av årsredovisning faktiskt lagstadgad för räkenskapsår som
  inleds efter 2025-12-31? Kunde inte verifieras mot primärkälla. Avgör om iXBRL
  är ett krav eller ett val för RÅ 2026.
- Klarar Accounted Bolagsverkets iXBRL-inlämning? Belägg finns för INK2/SRU till
  Skatteverket, inget för iXBRL.
- Har projektet taggat en release? Vid kartläggningen: noll releaser, noll taggar,
  ~6 månader gammalt, 2–3 personer bakom över 90 % av koden.

## Varför skuggkörning och inte bara byte

Bolaget kör kontantmetoden, har två räkenskapsår i systemet och ett fyrtiotal
fakturor totalt. **Dataflytten är trivial** — två SIE-filer. Det som inte går att
bedöma på förhand är den återkommande rytmen: lön och AGI varje månad, moms varje
period, och bokslutet. Skuggkörningen finns till för att testa just den, med
riktiga siffror men utan att något ligger i vägen om det spricker.

Fortnox äger böckerna hela tiden. Skuggan är alltid sekundär.

## Tidslinje

| När | Vad |
|---|---|
| Aug 2026 | Sätt upp instansen. Importera RÅ 2025 + 2026 hittills via SIE. |
| Sep–dec 2026 | Bokför varje månad i **båda** systemen oberoende. Diffa vid månadsskifte. |
| Dec 2026 | Beslut: byter vi vid årsskiftet? |
| Jan 2027 | Vid ja: RÅ 2027 startar rent i Accounted. Fortnox behålls tills RÅ 2026 är inlämnad. |
| ~Jul 2027 | RÅ 2026 lämnas in — från Fortnox, oavsett beslut. |

Skälet att inte byta mitt i året: RÅ 2026 är sannolikt det första året med
**tvingande digital inlämning (iXBRL)** till Bolagsverket, och det är inte ett år
att experimentera med. Låt Fortnox ta det sista bokslutet.

> **Overifierat:** att kravet på digital inlämning faktiskt är antaget i lag och
> gäller räkenskapsår som inleds efter 2025-12-31 kunde inte bekräftas mot
> primärkälla. Kontrollera på bolagsverket.se innan planen låses.

## Instans

Körs på **huginmunin**, self-hostat enligt `docs/SELF-HOSTING.md` i
[erp-mafia/accounted](https://github.com/erp-mafia/accounted), sektionen
*"Fully Self-Hosted (No Supabase Cloud)"* — Accounted + cron parat med Supabases
egna Docker-stack, så ingenting ligger hos en molnleverantör.

Räkna med ~8–10 containrar (postgres, gotrue, postgrest, storage, kong, studio,
app, cron) och att du själv äger backup, TLS och Postgres-uppgraderingar.

Två saker att kontrollera vid uppsättning:

- **`pg_cron`** (migration 048) kräver betald Supabase-plan i molnet, men fungerar
  i den self-hostade stacken. Går den inte igenom: hoppa över den, cron-sidecaren
  gör samma jobb över HTTP.
- **Arkivering.** När/om detta blir produktion gäller BFL 7 kap: 7 års bevarande
  och omedelbar elektronisk åtkomst. Egen hårdvara löser datasuveräniteten men
  flyttar backupansvaret till dig — och en trasig disk är inte ett giltigt skäl
  mot Skatteverket.

## Månadsrytmen

Bokför självständigt i båda systemen — kopiera inte verifikat mellan dem, för då
testar du kopieringen i stället för systemet. Stäm sedan av:

```bash
# 1. Hämta Fortnox-facit
noxctl sie export --file ~/skugga/fortnox-$(date +%Y-%m).se

# 2. Exportera samma period ur Accounted (SIE-export i UI, eller dess API)
#    -> ~/skugga/accounted-2026-09.se

# 3. Jämför
noxctl -o table sie diff ~/skugga/accounted-2026-09.se \
                --against ~/skugga/fortnox-2026-09.se
```

Eller direkt mot Fortnox utan mellanfil:

```bash
noxctl -o table sie diff ~/skugga/accounted-2026-09.se
```

Vänster sida är Fortnox, höger är skuggan. Positiv diff betyder att Fortnox bär
mer på kontot än skuggan gör.

`--exit-code` ger exit 1 när ledgerna skiljer sig, så avstämningen kan köras som
ett skript eller från en cron-rad och larma bara när något faktiskt glider isär.

### Vad en diff brukar betyda

| Symptom | Trolig orsak |
|---|---|
| Ett momskonto skiljer | Olika momskod på en artikel/rad, eller olika avrundning |
| Konto bara i skuggan | Kontering hamnade på annat konto än i Fortnox |
| Olika antal verifikat | Något är obokfört, eller så slår systemen ihop poster olika |
| `OBALANS` | Ett verifikat går inte ihop — allvarligt, fixa direkt |
| Allt skiljer med samma belopp | Olika ingående balans; kontrollera SIE-importen |

Skillnader i **antal verifikat** är ofta ofarliga: systemen grupperar
betalningar olika. Skillnader i **UB och RES** är det som betyder något.

## Vad skuggkörningen ska besvara

Kryssa av under hösten. Det här är beslutsunderlaget i december:

- [ ] Går löpande bokföring med kontantmetoden att göra lika snabbt som i Fortnox?
- [ ] Fungerar lönekörningen, och blir AGI-underlaget rätt?
- [ ] Stämmer momsrapporten mot Fortnox alla perioder?
- [ ] Går kundfakturor att skicka i den form kunderna (AFRY, TRATON) accepterar?
- [ ] Finns iXBRL-stöd för årsredovisning till Bolagsverket — eller en plan för den?
- [ ] Har projektet taggat en release? *(Vid skrivande stund: noll releases, noll
      taggar, ~6 månader gammalt, 2–3 personer bakom >90 % av koden.)*

Sista punkten är inte en teknikdetalj. Ett bokföringssystem utan versionering går
inte att uppgradera kontrollerat, och sju års arkivplikt är fel ställe att
upptäcka det på.

## Verktyg

| Kommando | Vad |
|---|---|
| `noxctl sie export` | Hämtar SIE från Fortnox (typ 4 = balanser + alla verifikat) |
| `noxctl sie diff <skugga.se>` | Jämför skuggledgern mot Fortnox |
| `noxctl sie diff <a.se> --against <b.se>` | Jämför två lokala filer, utan nätverk |

SIE-filerna är CP437-kodade enligt spec och skrivs oförändrade — koda inte om dem
innan de går vidare till ett annat system eller till revisorn.

> **Otestat mot skarp API:** `sie export` är byggd mot `/3/sie/{Type}`, som finns
> i Fortnox OpenAPI-spec, men anropet har inte kunnat köras live. Verifiera med
> `noxctl sie export --file -  | head -c 200` första gången. Kräver
> `bookkeeping`-scope.
