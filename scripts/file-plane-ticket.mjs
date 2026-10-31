#!/usr/bin/env node

// Files the weekly API drift reports as tickets in noxctl's Plane project (NOX),
// through the ticket gateway's REST interface, instead of as GitHub issues.
//
//   node scripts/file-plane-ticket.mjs check
//   node scripts/file-plane-ticket.mjs file drift|fetch-error|schema
//
// Configuration comes from the environment, which the workflow fills from Actions
// secrets: TICKET_GATEWAY_URL and TICKET_GATEWAY_TOKEN. Both are required; there is no
// fallback, so a missing secret fails the job instead of filing nothing.
//
// This output lands in a public Actions log. Error messages are therefore built only
// from the tool name, the HTTP status and the gateway's short error code. They never
// include the token, the gateway address, the Plane address or free text from a
// response, and the success line names only the ticket key.

import { pathToFileURL } from 'node:url';

export const PROJECT = 'NOX';
export const LABEL = 'api-drift';

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 30_000;
const TICKET_KEY = /^NOX-\d+$/;
const ERROR_CODE = /^[a-z_]{1,40}$/;
const SYSTEM_ERROR_CODE = /^[A-Z0-9_]{1,40}$/;

class FilingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FilingError';
  }
}

function openConnection({ url, token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new FilingError('TICKET_GATEWAY_TOKEN is not set (is the Actions secret missing?)');
  if (!url) throw new FilingError('TICKET_GATEWAY_URL is not set (is the Actions secret missing?)');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new FilingError('TICKET_GATEWAY_URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new FilingError('TICKET_GATEWAY_URL must use https, so the token is never sent in clear text');
  }
  if (parsed.username || parsed.password) {
    throw new FilingError('TICKET_GATEWAY_URL must not contain credentials');
  }
  return { base: parsed.origin, token, fetchImpl };
}

function describeNetworkFailure(error) {
  if (error?.name === 'TimeoutError') return 'timed out';
  const code = error?.cause?.code;
  return typeof code === 'string' && SYSTEM_ERROR_CODE.test(code) ? code : 'network error';
}

async function gatewayErrorCode(response) {
  try {
    const body = await response.json();
    return typeof body?.error === 'string' && ERROR_CODE.test(body.error) ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** POST /api/v1/tools/<tool>. The token travels only in the Authorization header. */
async function call(connection, tool, args) {
  let response;
  try {
    response = await connection.fetchImpl(`${connection.base}/api/v1/tools/${tool}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(args),
      // A redirect (for example to a Cloudflare Access login) is reported, never followed.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new FilingError(`${tool}: request failed (${describeNetworkFailure(error)})`);
  }

  if (!response.ok) {
    const code = await gatewayErrorCode(response);
    throw new FilingError(`${tool}: HTTP ${response.status}${code ? ` (${code})` : ''}`);
  }
  try {
    return await response.json();
  } catch {
    throw new FilingError(`${tool}: answer was not JSON`);
  }
}

/** Fails unless the token works and NOX has the label the reports are filed under. */
export async function checkGateway(options) {
  const connection = openConnection(options);
  const meta = await call(connection, 'project_meta', { project: PROJECT });
  if (meta?.project?.identifier !== PROJECT) {
    throw new FilingError(`project_meta: unexpected project (expected ${PROJECT})`);
  }
  const labels = Array.isArray(meta.labels) ? meta.labels : [];
  if (!labels.some((label) => label?.name === LABEL)) {
    throw new FilingError(`project_meta: label "${LABEL}" does not exist in ${PROJECT}`);
  }
}

const fence = (text) => ['```', text, '```'];

/** The wording of each report, and which open ticket already covers it. */
function reportFor(kind, { summary, changed, error, today }) {
  switch (kind) {
    case 'drift':
      return {
        title: `Fortnox API spec changed (${today})`,
        // The same drift is detected every week until the committed fingerprint is
        // refreshed, so the history stays in one open ticket.
        covers: (title) => title.startsWith('Fortnox API spec changed'),
        description: [
          'The weekly API drift check detected changes in the Fortnox OpenAPI spec.',
          '',
          ...fence(summary),
          '',
          'Review the changes and update operations/tools if needed.',
          '',
          'The fingerprint is not updated automatically. Run `npm run check:api` locally to fetch the spec, inspect the actual diff, and commit the refreshed `api-spec/openapi-fingerprint.json` in the pull request that handles this change. The full Fortnox spec is not stored in the repo.',
        ].join('\n'),
        comment: [`Still differs from the committed fingerprint on ${today}:`, '', ...fence(summary)].join('\n'),
      };
    case 'fetch-error':
      return {
        title: `Fortnox API spec fetch failed (${today})`,
        // The fetch can fail every week for the same reason (for example a persistent
        // HTTP 429); keep the failure history in a single ticket.
        covers: (title) => /fetch failed|drift check|429/i.test(title),
        description: [
          'The weekly API drift check could not fetch the OpenAPI spec.',
          '',
          ...fence(summary),
          '',
          'This may be transient (rate limiting) or indicate a URL change.',
        ].join('\n'),
        comment: [`Still failing on ${today}:`, '', ...fence(summary)].join('\n'),
      };
    case 'schema': {
      if (changed === error) throw new FilingError('Expected exactly one write-schema audit outcome');
      const title = changed ? 'MCP write schema drift' : 'MCP write schema audit failed';
      const introduction = changed
        ? 'The weekly check detected a change in the opaque MCP write-schema coverage baseline.'
        : 'The weekly MCP write-schema audit could not complete.';
      const guidance = changed
        ? 'Review the affected mapping IDs locally and update tool schemas before refreshing the opaque baseline.'
        : 'Inspect the workflow failure and restore the privacy-safe audit path.';
      const report = [
        introduction,
        '',
        ...fence(summary),
        '',
        guidance,
        '',
        'The full Fortnox specification and raw property names are intentionally not included.',
      ].join('\n');
      return {
        title,
        covers: (existing) => existing === title,
        description: report,
        comment: [`Detected again on ${today}.`, '', report].join('\n'),
      };
    }
    default:
      throw new FilingError(`Unknown report kind "${kind}"`);
  }
}

/**
 * Key of the first open api-drift ticket the report covers, across every result page, or
 * undefined when none is open. The gateway orders results by last update and pages them by
 * offset, so a ticket updated between two requests can slip past the cursor. A miss is only
 * trustworthy when one page held every result; otherwise this fails rather than let the
 * caller create a possible duplicate.
 */
async function findOpenTicket(connection, covers) {
  let cursor;
  let pages = 0;
  while (pages < MAX_PAGES) {
    pages++;
    const result = await call(connection, 'ticket_search', {
      project: PROJECT,
      state: 'open',
      labels: [LABEL],
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result?.tickets)) throw new FilingError('ticket_search: unexpected answer');
    const hit = result.tickets.find((ticket) => typeof ticket?.title === 'string' && covers(ticket.title));
    if (hit) {
      if (!TICKET_KEY.test(hit.key)) throw new FilingError('ticket_search: unexpected answer');
      return hit.key;
    }
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  if (pages > 1) {
    throw new FilingError(
      `ticket_search: no match over several pages of open ${LABEL} tickets, and a ticket updated between pages can be missed; not creating a possible duplicate`,
    );
  }
  return undefined;
}

/**
 * Comment on the open ticket that already covers this report, or create one. Returns
 * `{ action: 'commented' | 'created', key }`.
 */
export async function fileReport(options, kind, { summary, changed = false, error = false, now = () => new Date() } = {}) {
  const today = now().toISOString().slice(0, 10);
  const text = summary && summary.trim() ? summary : '(no output)';
  const report = reportFor(kind, { summary: text, changed, error, today });
  const connection = openConnection(options);

  const existing = await findOpenTicket(connection, report.covers);
  if (existing) {
    const commented = await call(connection, 'ticket_comment', { key: existing, body: report.comment });
    if (commented?.key !== existing) throw new FilingError('ticket_comment: unexpected answer');
    return { action: 'commented', key: existing };
  }

  const created = await call(connection, 'ticket_create', {
    project: PROJECT,
    title: report.title,
    description: report.description,
    labels: [LABEL],
  });
  if (!TICKET_KEY.test(created?.key)) throw new FilingError('ticket_create: unexpected answer');
  return { action: 'created', key: created.key };
}

const REPORT_KINDS = ['drift', 'fetch-error', 'schema'];
const USAGE = `Usage: node scripts/file-plane-ticket.mjs check
       node scripts/file-plane-ticket.mjs file <${REPORT_KINDS.join('|')}>
`;

/** Returns the process exit code: 0 done, 1 failed, 2 usage error. */
export async function main(argv, env, { out, err, fetchImpl, now }) {
  const [command, kind] = argv;
  const valid = command === 'check' || (command === 'file' && REPORT_KINDS.includes(kind));
  if (!valid) {
    err(USAGE);
    return 2;
  }

  const connection = { url: env.TICKET_GATEWAY_URL, token: env.TICKET_GATEWAY_TOKEN, fetchImpl };
  try {
    if (command === 'check') {
      await checkGateway(connection);
      out(`Ticket gateway reachable; ${PROJECT} has the ${LABEL} label.\n`);
      return 0;
    }
    const summaryVariable = kind === 'schema' ? 'SCHEMA_AUDIT_SUMMARY' : 'DIFF_SUMMARY';
    const result = await fileReport(connection, kind, {
      summary: env[summaryVariable],
      changed: env.SCHEMA_AUDIT_CHANGED === 'true',
      error: env.SCHEMA_AUDIT_ERROR === 'true',
      now,
    });
    out(`${result.action === 'created' ? 'Created' : 'Commented on'} ${result.key}\n`);
    return 0;
  } catch (error) {
    // Only messages this script built are printed; anything else is reduced to its type.
    err(`${error instanceof FilingError ? error.message : `Unexpected error (${error?.name ?? 'unknown'})`}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
