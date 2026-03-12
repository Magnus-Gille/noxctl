# Fortnox MCP Server — Projektplan

## Vision

En MCP-server som låter dig hantera fakturering, bokföring och moms i Fortnox direkt från Claude Code. Open source, robust, vältestad, tydlig och transparent.

**Designprincip:** Så få tvivel och tveksamheter som möjligt för användaren. Setup ska vara en enda kommandorad — ingen manuell token-hantering, inga environment-variabler, ingen extern hosting.

## Målgrupp

Enmansföretagare/småföretag som har Fortnox (Mellan eller högre) och vill slippa webbgränssnittet.

## Användarupplevelse

```bash
npm install
npx fortnox-mcp setup    # öppnar webbläsaren, logga in på Fortnox, klart
```

Sen registrera i Claude Code:

```bash
claude mcp add fortnox -- npx fortnox-mcp
```

Klart. Inga manuella tokens, inga env-variabler.

## Scope — Fas 1

~15 MCP tools baserade på verkliga behov:

### Kunder
- `fortnox_list_customers` — lista/sök kunder
- `fortnox_get_customer` — hämta enskild kund
- `fortnox_create_customer` — skapa ny kund
- `fortnox_update_customer` — uppdatera befintlig kund

### Fakturor
- `fortnox_list_invoices` — lista/filtrera fakturor
- `fortnox_get_invoice` — hämta enskild faktura
- `fortnox_create_invoice` — skapa faktura
- `fortnox_send_invoice` — skicka faktura via e-post (eller markera för utskrift/snigelpost)
- `fortnox_bookkeep_invoice` — bokför faktura
- `fortnox_credit_invoice` — kreditera faktura

### Bokföring
- `fortnox_list_vouchers` — lista verifikationer
- `fortnox_create_voucher` — skapa verifikation
- `fortnox_list_accounts` — visa kontoplan

### Moms
- `fortnox_tax_report` — momsunderlag för period (skattedeklarationsstöd)

### Företag
- `fortnox_company_info` — företagsinformation och inställningar

## Arkitektur

### Stack
- **TypeScript** + Node.js
- **MCP SDK** (`@modelcontextprotocol/sdk`)
- **stdio-transport** (lokalt, ingen server att hosta)
- **Inga externa beroenden** — ingen Redis, ingen databas, ingen molntjänst

### Auth
- OAuth2 mot Fortnox API med `account_type=service`
- `npx fortnox-mcp setup` startar lokal HTTP-server, öppnar webbläsaren för Fortnox-inloggning, tar emot callback, hämtar tenant_id, sparar credentials lokalt
- **Client credentials flow (primär):** Efter initial auth används `client_credentials` grant med `TenantId` header — inga refresh tokens att hantera
- **Refresh token flow (fallback):** Om client credentials inte fungerar
- Token-refresh sker automatiskt och transparent
- Credentials sparas i `~/.fortnox-mcp/credentials.json` (gitignored, bara lokalt)
- Scopes: `customer invoice bookkeeping companyinformation settings`

### Fortnox API
- REST, JSON
- Base URL: `https://api.fortnox.se/3/`
- Rate limit: 25 requests per 5 sekunder — inbyggd rate limiter
- Felhantering: tydliga felmeddelanden som Claude kan förstå och vidarebefordra

## Kvalitetskrav

### Robusthet
- Automatisk token-refresh utan användarinteraktion
- Graceful error handling — aldrig kryptiska felmeddelanden
- Rate limiting som köar requests istället för att faila
- Retry med exponential backoff vid transienta fel

### Testning
- Unit tests för varje tool
- Integration tests med mocked Fortnox API
- Auth-flödet testat end-to-end
- CI kör alla tester på varje push

### Dokumentation
- README med quickstart, fullständig setup-guide, alla tools beskrivna
- ARCHITECTURE.md — hur koden är uppbyggd
- Inline JSDoc på alla publika funktioner
- CHANGELOG.md

### Transparens
- Tydlig loggning (vad skickas till Fortnox, vad kommer tillbaka)
- Inga dolda sidoeffekter — varje tool gör exakt vad den säger
- Open source under MIT-licens

## Faser

### Fas 1: Auth + scaffolding
- Projektstruktur (src/, tests/, tsconfig, eslint, prettier)
- OAuth2-flöde med `npx fortnox-mcp setup`
- Token management (refresh, lagring)
- MCP server shell med stdio-transport
- CI/CD med GitHub Actions

### Fas 2: Kunder + fakturor
- CRUD kunder
- CRUD fakturor + skicka + bokför + kreditera
- Tester för alla tools

### Fas 3: Bokföring
- Verifikationer (list, create)
- Kontoplan
- Tester

### Fas 4: Moms
- Momsrapport/underlag per period
- Tester

### Fas 5: Dokumentation + polish
- README med fullständig guide
- ARCHITECTURE.md
- Granska alla felmeddelanden
- Kantfall och edge cases

### Fas 6: Publicera
- GitHub repo (public, MIT)
- npm publish
- MCP Registry
- Anmäl till Fortnox Integrations Marketplace (valfritt)

## Tekniska beslut

| Beslut | Val | Motivering |
|--------|-----|------------|
| Språk | TypeScript | Samma som övriga MCP-servrar, naturligt för JSON API |
| Transport | stdio | Lokalt, enkelt, ingen hosting |
| Token-lagring | Lokal fil | Inga externa beroenden |
| Pakethanterare | npm | Standard |
| Testramverk | vitest | Snabbt, TypeScript-native |
| Licens | MIT | Maximalt öppet |

## Kontext

- Magnus Gille Consulting AB har Fortnox Mellan (529 kr/mån) — API ingår
- Fakturerar några gånger i månaden, blandat nya och återkommande kunder
- Bokför löpande, momsredovisning kvartalsvis
- Skickar fakturor via e-post och ibland snigelpost
- Community-alternativ (itzaks/fortnox-mcp) utvärderat och avvisat: 0 stjärnor, single author, inga tester, extern Redis-dependency
