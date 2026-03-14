import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResponse } from '../tool-output.js';

export function registerStatusTools(server: McpServer): void {
  server.tool(
    'fortnox_status',
    'Diagnostik: kontrollera anslutning, autentisering och behörigheter (scopes). Motsvarar CLI-kommandot `noxctl doctor`.',
    {},
    async () => {
      const lines: string[] = [];
      let ok = true;

      function pass(label: string, detail?: string) {
        lines.push(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
      }
      function fail(label: string, detail?: string) {
        ok = false;
        lines.push(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
      }

      // 1. Node version
      const nodeVersion = process.versions.node;
      const major = parseInt(nodeVersion.split('.')[0]!, 10);
      if (major >= 20) {
        pass('Node.js', `v${nodeVersion}`);
      } else {
        fail('Node.js', `v${nodeVersion} (need 20+)`);
      }

      // 2. Credentials
      const { loadCredentials } = await import('../auth.js');
      const creds = await loadCredentials();
      if (!creds) {
        fail('Credentials', 'not found — run `noxctl init` to set up');
        lines.push('');
        lines.push(ok ? 'All checks passed.' : 'Some checks failed.');
        return textResponse(lines.join('\n'));
      }
      pass('Credentials', 'found');

      // 3. Client ID
      if (creds.client_id) {
        pass('Client ID', `${creds.client_id.slice(0, 8)}...`);
      } else {
        fail('Client ID', 'missing');
      }

      // 4. Service account
      if (creds.tenant_id) {
        pass('Service account', `tenant ${creds.tenant_id}`);
      } else {
        pass('Service account', 'not configured (using refresh token flow)');
      }

      // 5. Token expiry
      const now = Date.now();
      if (creds.expires_at > now) {
        const minutesLeft = Math.round((creds.expires_at - now) / 60000);
        pass('Access token', `valid for ~${minutesLeft} min`);
      } else {
        pass('Access token', 'expired (will auto-refresh on next request)');
      }

      // 6. API connectivity
      try {
        const { getCompanyInfo } = await import('../operations/company.js');
        const data = await getCompanyInfo();
        const company = data as Record<string, unknown>;
        const name = company['CompanyName'] || 'unknown';
        pass('API connection', `${name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fail('API connection', msg);
        lines.push('');
        lines.push(ok ? 'All checks passed.' : 'Some checks failed.');
        return textResponse(lines.join('\n'));
      }

      // 7. Scope validation
      const { SCOPES } = await import('../auth.js');
      const { fortnoxRequest, FortnoxApiError } = await import('../fortnox-client.js');

      const scopeEndpoints: Record<string, string> = {
        article: 'articles?limit=1',
        customer: 'customers?limit=1',
        invoice: 'invoices?limit=1',
        supplier: 'suppliers?limit=1',
        supplierinvoice: 'supplierinvoices?limit=1',
        bookkeeping: 'vouchers?limit=1',
        companyinformation: 'companyinformation',
        settings: 'settings/company',
      };

      const required = SCOPES.split(' ');
      const missing: string[] = [];

      for (const scope of required) {
        const endpoint = scopeEndpoints[scope];
        if (!endpoint) continue;
        try {
          await fortnoxRequest(endpoint);
        } catch (err) {
          if (err instanceof FortnoxApiError && err.statusCode === 403) {
            missing.push(scope);
          }
        }
      }

      if (missing.length === 0) {
        pass('Scopes', `all ${required.length} scopes authorized`);
      } else {
        fail(
          'Scopes',
          `missing: ${missing.join(', ')}. Enable them in your Fortnox app at developer.fortnox.se`,
        );
      }

      lines.push('');
      lines.push(ok ? 'All checks passed.' : 'Some checks failed.');
      return textResponse(lines.join('\n'));
    },
  );
}
