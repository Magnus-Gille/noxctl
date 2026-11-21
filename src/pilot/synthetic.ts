/**
 * Deterministic in-memory Fortnox transport for rehearsal (`server --synthetic-source`) and tests.
 * Models only what the pilot touches: companyinformation, customers, articles, invoices and
 * (read-only) vouchers.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { FortnoxTransport, RequestOptions } from '../fortnox-client.js';

type Entity = Record<string, unknown>;

export interface SyntheticFortnox {
  transport: FortnoxTransport;
  state: {
    customers: Map<string, Entity>;
    articles: Map<string, Entity>;
    invoices: Map<string, Entity>;
    /** Invoice payments by payment number. */
    payments: Map<string, Entity>;
    /** Keyed "financialYear:series:number" (read-only; tests seed them). */
    vouchers: Map<string, Entity>;
    /** "METHOD endpoint" for every request. */
    requests: string[];
    /** Mutable so tests can simulate the Fortnox company changing underneath the host. */
    orgNr: string;
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

export interface SyntheticOptions {
  /** Rehearsal across processes: customers, invoices and counters are shared through this file. */
  persistPath?: string;
}

export function createSyntheticFortnox(
  orgNr: string,
  options: SyntheticOptions = {},
): SyntheticFortnox {
  const state: SyntheticFortnox['state'] = {
    customers: new Map<string, Entity>([
      [
        '1',
        {
          CustomerNumber: '1',
          Name: 'Exempel AB',
          Type: 'COMPANY',
          VATType: 'SEVAT',
          Currency: 'SEK',
          CountryCode: 'SE',
          Country: 'Sverige',
        },
      ],
      [
        '2',
        {
          CustomerNumber: '2',
          Name: 'Andra AB',
          Type: 'COMPANY',
          VATType: 'SEVAT',
          Currency: 'SEK',
          CountryCode: 'SE',
          Country: 'Sverige',
        },
      ],
    ]),
    articles: new Map<string, Entity>([
      ['A-1', { ArticleNumber: 'A-1', Description: 'Synthetic' }],
    ]),
    invoices: new Map<string, Entity>(),
    payments: new Map<string, Entity>(),
    vouchers: new Map<string, Entity>(),
    requests: [],
    orgNr,
  };
  let nextCustomer = 100;
  let nextInvoice = 1;
  let nextPayment = 1;
  let nextVoucher = 1;
  /** Financial year id of every synthetic voucher. */
  const YEAR = 1;

  function buildInvoice(input: Entity): Entity {
    const rows = (input.InvoiceRows as Entity[]).map((row) => {
      const quantity = Number(row.DeliveredQuantity ?? 1);
      const price = Number(row.Price ?? 0);
      return {
        Description: row.Description,
        DeliveredQuantity: String(quantity),
        Price: price,
        PriceExcludingVAT: price,
        TotalExcludingVAT: round(price * quantity),
        Total: round(price * quantity),
        Discount: 0,
        VAT: row.VAT ?? 25,
        Unit: row.Unit ?? 'st',
        HouseWork: false,
        CostCenter: '',
        Project: '',
        ArticleNumber: row.ArticleNumber ?? '',
        AccountNumber: 3001,
      };
    });
    const net = round(rows.reduce((sum, row) => sum + row.TotalExcludingVAT, 0));
    const vat = round(net / 4);
    return {
      CustomerNumber: input.CustomerNumber,
      InvoiceDate: input.InvoiceDate,
      DueDate: input.DueDate,
      Currency: 'SEK',
      DocumentNumber: String(nextInvoice++),
      AccountingMethod: 'CASH',
      InvoiceType: 'INVOICE',
      Country: 'Sverige',
      Booked: false,
      Sent: false,
      Cancelled: false,
      Credit: 'false',
      VATIncluded: false,
      CurrencyRate: 1,
      CurrencyUnit: 1,
      AdministrationFee: 0,
      AdministrationFeeVAT: 0,
      Freight: 0,
      FreightVAT: 0,
      RoundOff: 0,
      TaxReduction: 0,
      HouseWork: false,
      Net: net,
      TotalVAT: vat,
      Total: round(net + vat),
      TotalToPay: round(net + vat),
      Balance: round(net + vat),
      InvoiceRows: rows,
    };
  }

  const persistPath = options.persistPath;
  function load(): void {
    if (!persistPath || !existsSync(persistPath)) return;
    const saved = JSON.parse(readFileSync(persistPath, 'utf8')) as {
      customers: [string, Entity][];
      invoices: [string, Entity][];
      nextCustomer: number;
      nextInvoice: number;
      payments?: [string, Entity][];
      vouchers?: [string, Entity][];
      nextPayment?: number;
      nextVoucher?: number;
    };
    state.customers = new Map(saved.customers);
    state.invoices = new Map(saved.invoices);
    nextCustomer = saved.nextCustomer;
    nextInvoice = saved.nextInvoice;
    state.payments = new Map(saved.payments ?? []);
    state.vouchers = new Map(saved.vouchers ?? []);
    nextPayment = saved.nextPayment ?? 1;
    nextVoucher = saved.nextVoucher ?? 1;
  }
  function save(): void {
    if (!persistPath) return;
    const temp = `${persistPath}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({
        customers: [...state.customers],
        invoices: [...state.invoices],
        nextCustomer,
        nextInvoice,
        payments: [...state.payments],
        vouchers: [...state.vouchers],
        nextPayment,
        nextVoucher,
      }),
      { mode: 0o600 },
    );
    renameSync(temp, persistPath);
  }

  const last = (endpoint: string) => decodeURIComponent(endpoint.split('/').pop() ?? '');
  async function request<T>(endpoint: string, requestOptions: RequestOptions = {}): Promise<T> {
    load();
    const result = await handle<T>(endpoint, requestOptions);
    if ((requestOptions.method ?? 'GET') !== 'GET') save();
    return result;
  }
  async function handle<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    state.requests.push(`${method} ${endpoint}`);
    const body = options.body as Record<string, Entity> | undefined;
    const found = (map: Map<string, Entity>, key: string, wrap: string): T => {
      const entity = map.get(key);
      if (!entity) throw new Error(`Synthetic Fortnox: ${wrap} not found`);
      return { [wrap]: structuredClone(entity) } as T;
    };
    if (method === 'GET' && endpoint === 'companyinformation')
      return {
        CompanyInformation: { OrganizationNumber: state.orgNr, CompanyName: 'Synthetic AB' },
      } as T;
    if (method === 'GET' && endpoint.startsWith('customers/'))
      return found(state.customers, last(endpoint), 'Customer');
    if (method === 'GET' && /^articles(-v2)?\//.test(endpoint))
      return found(state.articles, last(endpoint), 'Article');
    if (method === 'GET' && /^invoicepayments\/[^/]+$/.test(endpoint))
      return found(state.payments, last(endpoint), 'InvoicePayment');
    if (method === 'GET' && /^invoices(-v2)?\//.test(endpoint))
      return found(state.invoices, last(endpoint), 'Invoice');
    const voucher = endpoint.match(/^vouchers\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && voucher) {
      const year = options.params?.financialyear;
      return found(
        state.vouchers,
        `${String(year)}:${decodeURIComponent(voucher[1]!)}:${decodeURIComponent(voucher[2]!)}`,
        'Voucher',
      );
    }
    if (method === 'POST' && endpoint === 'customers') {
      const input = body!.Customer!;
      const customer: Entity = {
        Currency: 'SEK',
        VATType: 'SEVAT',
        Country: 'Sverige',
        ...input,
        CustomerNumber: String(nextCustomer++),
      };
      state.customers.set(customer.CustomerNumber as string, customer);
      return { Customer: structuredClone(customer) } as T;
    }
    if (method === 'POST' && endpoint === 'invoicepayments') {
      const input = body!.InvoicePayment!;
      const invoice = state.invoices.get(String(input.InvoiceNumber));
      if (!invoice) throw new Error('Synthetic Fortnox: Invoice not found');
      const amount = Number(input.Amount);
      const payment: Entity = {
        Number: nextPayment++,
        InvoiceNumber: Number(input.InvoiceNumber),
        Amount: amount,
        AmountCurrency: amount,
        Currency: 'SEK',
        CurrencyRate: 1,
        CurrencyUnit: 1,
        InvoiceTotal: Number(invoice.Total).toFixed(2),
        WriteOffs: [],
        ModeOfPaymentAccount: 1930,
        PaymentDate: input.PaymentDate,
        Booked: false,
        VoucherYear: 0,
        VoucherSeries: '',
        VoucherNumber: 0,
      };
      state.payments.set(String(payment.Number), payment);
      return { InvoicePayment: structuredClone(payment) } as T;
    }
    const bookkeep = endpoint.match(/^invoicepayments\/([^/]+)\/bookkeep$/);
    if (method === 'PUT' && bookkeep) {
      const payment = state.payments.get(decodeURIComponent(bookkeep[1]!));
      if (!payment || payment.Booked) throw new Error('Synthetic Fortnox: payment not bookable');
      const invoice = state.invoices.get(String(payment.InvoiceNumber))!;
      const row = (Account: number, Debit: number, Credit: number) => ({
        Account,
        Debit,
        Credit,
        Removed: false,
        CostCenter: '',
        Project: '',
        Quantity: 0,
        Description: '',
        TransactionInformation: '',
      });
      const number = nextVoucher++;
      state.vouchers.set(`${YEAR}:D:${number}`, {
        Year: YEAR,
        VoucherSeries: 'D',
        VoucherNumber: number,
        ReferenceType: 'INVOICEPAYMENT',
        ReferenceNumber: String(payment.InvoiceNumber),
        TransactionDate: payment.PaymentDate,
        CostCenter: '',
        Project: '',
        Description: `Inbetalning faktura ${String(payment.InvoiceNumber)}`,
        VoucherRows: [
          row(1930, Number(payment.Amount), 0),
          row(3001, 0, Number(invoice.Net)),
          row(2611, 0, Number(invoice.TotalVAT)),
        ],
      });
      Object.assign(payment, {
        Booked: true,
        VoucherYear: YEAR,
        VoucherSeries: 'D',
        VoucherNumber: number,
      });
      return { InvoicePayment: structuredClone(payment) } as T;
    }
    const credit = endpoint.match(/^invoices(?:-v2)?\/([^/]+)\/credit$/);
    if (method === 'PUT' && credit) {
      // Real shape (export 2026-10-27): the response is the updated ORIGINAL; the new credit note
      // has negated rows and totals, a text row, Credit "true", CreditInvoiceReference "0".
      const original = state.invoices.get(decodeURIComponent(credit[1]!));
      if (!original || original.Credit !== 'false' || original.CreditInvoiceReference)
        throw new Error('Synthetic Fortnox: invoice cannot be credited');
      const number = String(nextInvoice++);
      const negate = (value: unknown) => -Number(value);
      const rows = (original.InvoiceRows as Entity[]).map((row) => ({
        ...row,
        DeliveredQuantity: String(negate(row.DeliveredQuantity)),
        Total: negate(row.Total),
        TotalExcludingVAT: negate(row.TotalExcludingVAT),
      }));
      state.invoices.set(number, {
        ...structuredClone(original),
        DocumentNumber: number,
        Credit: 'true',
        CreditInvoiceReference: '0',
        InvoiceReference: original.DocumentNumber,
        Net: negate(original.Net),
        TotalVAT: negate(original.TotalVAT),
        Total: negate(original.Total),
        TotalToPay: negate(original.TotalToPay),
        Balance: negate(original.Balance),
        InvoiceRows: [
          ...rows,
          { Description: `Kreditering av faktura ${String(original.DocumentNumber)}` },
        ],
      });
      original.CreditInvoiceReference = number;
      return { Invoice: structuredClone(original) } as T;
    }
    if (method === 'POST' && (endpoint === 'invoices' || endpoint === 'invoices-v2')) {
      const invoice = buildInvoice(body!.Invoice!);
      state.invoices.set(invoice.DocumentNumber as string, invoice);
      return { Invoice: structuredClone(invoice) } as T;
    }
    throw new Error(`Synthetic Fortnox does not support ${method} ${endpoint}`);
  }
  const unsupported = async () => {
    throw new Error('Synthetic Fortnox does not support this request kind');
  };
  const transport = {
    request,
    requestWithMetadata: unsupported,
    requestPdf: unsupported,
    requestPdfFromMutation: unsupported,
    requestFile: unsupported,
    fetchAllPages: unsupported,
  } as unknown as FortnoxTransport;
  return { transport, state };
}
