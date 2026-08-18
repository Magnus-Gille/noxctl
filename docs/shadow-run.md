# Skuggkörning: Fortnox → Accounted

Plan och verktyg för att köra ett open source-bokföringssystem parallellt med
Fortnox under hösten 2026, för att kunna avgöra inför räkenskapsåret 2027 om det
håller att byta.

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
