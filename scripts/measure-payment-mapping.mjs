#!/usr/bin/env node
// Offline, counts-only measurement of the invoice-payment mapping (NOX-211).
// Usage: node scripts/measure-payment-mapping.mjs <path-to-export.json>   (after `npm run build`)
// Makes no network request, writes nothing, and prints only integer counts by refusal reason.
import { measurePaymentExportFile } from '../dist/shadow/payment-measure.js';

const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length) {
  process.stderr.write('Usage: measure-payment-mapping.mjs <export.json>\n');
  process.exit(2);
}
try {
  const result = measurePaymentExportFile(path);
  const refused = Object.entries(result.refused).sort(([a], [b]) => a.localeCompare(b));
  process.stdout.write(
    `${JSON.stringify({ payments: result.payments, mapped: result.mapped, refused: Object.fromEntries(refused) }, null, 2)}\n`,
  );
} catch (error) {
  // Only the fixed message of a measurement error, never file content.
  process.stderr.write(
    `measure-payment-mapping: ${error instanceof Error ? error.message : 'failed'}\n`,
  );
  process.exit(1);
}
