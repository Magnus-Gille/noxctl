import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { employeeListColumns, employeeDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

// Writable Employee fields exposed to the MCP tool. The Fortnox Employee
// resource has ~100 fields, most of them read-only (vacation balances, computed
// totals). These are the ones a caller realistically sets; power users can set
// any field via the CLI `--input` JSON.
const employeeWritableFields = {
  PersonalIdentityNumber: z.string().optional().describe('Personnummer (ÅÅMMDD-XXXX)'),
  Address1: z.string().optional().describe('Adressrad 1'),
  Address2: z.string().optional().describe('Adressrad 2'),
  PostCode: z.string().optional().describe('Postnummer'),
  City: z.string().optional().describe('Ort'),
  Country: z.string().optional().describe('Land'),
  Phone1: z.string().optional().describe('Telefon 1'),
  Phone2: z.string().optional().describe('Telefon 2'),
  JobTitle: z.string().optional().describe('Befattning (max 30 tecken)'),
  CostCenter: z.string().optional().describe('Kostnadsställe'),
  Project: z.string().optional().describe('Projekt'),
  EmploymentDate: z.string().optional().describe('Anställningsdatum (YYYY-MM-DD)'),
  EmployedTo: z.string().optional().describe('Anställd t.o.m. (YYYY-MM-DD)'),
  EmploymentForm: z
    .string()
    .optional()
    .describe('Anställningsform: TV, PRO, TID, SVT, VIK, PRJ, PRA, FER, SES, NEJ'),
  PersonelType: z
    .string()
    .optional()
    .describe('Personalkategori: TJM (tjänsteman) eller ARB (arbetare)'),
  SalaryForm: z.string().optional().describe('Löneform: MAN (månadslön) eller TIM (timlön)'),
  ScheduleId: z.string().optional().describe('Schema-ID'),
  MonthlySalary: z
    .string()
    .optional()
    .describe('Månadslön (ange antingen MonthlySalary eller HourlyPay)'),
  HourlyPay: z.string().optional().describe('Timlön (ange antingen MonthlySalary eller HourlyPay)'),
  TaxTable: z.string().optional().describe('Skattetabell'),
  TaxColumn: z.number().optional().describe('Skattekolumn (1-6)'),
  TaxAllowance: z.string().optional().describe('Skattereduktion: HUV, EXT, TMP, STU, EJ'),
  NonRecurringTax: z.string().optional().describe('Engångsskatt (procent)'),
  AutoNonRecurringTax: z.boolean().optional().describe('Automatisk engångsskatt'),
  Inactive: z.boolean().optional().describe('Om den anställde är inaktiv'),
  BankAccountNo: z.string().optional().describe('Bankkontonummer'),
  ClearingNo: z.string().optional().describe('Clearingnummer'),
  PayslipType: z.string().optional().describe('Lönebeskedstyp: pdf, digital eller kivra'),
};

export function registerEmployeeTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const { listEmployees, getEmployee, createEmployee, updateEmployee } = operations;
  server.tool(
    'fortnox_list_employees',
    'Lista anställda i Fortnox (kräver Lön-behörigheten). Returnerar: EmployeeId, FullName, JobTitle, Inactive.',
    {
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z
        .boolean()
        .optional()
        .describe('Inkludera rå JSON; kan exponera personnummer, lön och bankuppgifter'),
    },
    async ({ page, limit, all, includeRaw }) => {
      const data = await listEmployees({ page, limit, all });
      return listResponse(
        data.Employees ?? [],
        employeeListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_employee',
    'Hämta en enskild anställd från Fortnox (kräver Lön-behörigheten).',
    {
      employeeId: z.string().describe('EmployeeId för den anställde'),
      includeRaw: z
        .boolean()
        .optional()
        .describe('Inkludera rå JSON; kan exponera personnummer, lön och bankuppgifter'),
    },
    async ({ employeeId, includeRaw }) => {
      const data = await getEmployee(employeeId);
      return detailResponse(data, employeeDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_employee',
    'Skapa en ny anställd i Fortnox (kräver Lön-behörigheten). FirstName, LastName och Email krävs. Tips: ange även EmploymentForm, PersonelType och SalaryForm — annars kan Fortnox inte tilldela ett företagsavtal (felet "ftgavtalid").',
    {
      EmployeeId: z
        .string()
        .optional()
        .describe('EmployeeId (genereras automatiskt om det utelämnas)'),
      FirstName: z.string().describe('Förnamn'),
      LastName: z.string().describe('Efternamn'),
      Email: z.string().describe('E-postadress'),
      ...employeeWritableFields,
      confirm: z.boolean().optional().describe('Bekräfta att den anställde ska skapas'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle skickas utan att skapa'),
      includeRaw: z
        .boolean()
        .optional()
        .describe('Inkludera rå JSON; kan exponera personnummer, lön och bankuppgifter'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create employee "${params.FirstName} ${params.LastName}"`, {
          Employee: params,
        });
      }
      if (!confirm) requireConfirmation(`create employee "${params.FirstName} ${params.LastName}"`);

      const data = await createEmployee(params);
      return detailResponse(data, employeeDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_employee',
    'Uppdatera en befintlig anställd i Fortnox (kräver Lön-behörigheten).',
    {
      employeeId: z.string().describe('EmployeeId för den anställde att uppdatera'),
      FirstName: z.string().optional().describe('Förnamn'),
      LastName: z.string().optional().describe('Efternamn'),
      Email: z.string().optional().describe('E-postadress'),
      ...employeeWritableFields,
      confirm: z.boolean().optional().describe('Bekräfta att den anställde ska uppdateras'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle skickas utan att uppdatera'),
      includeRaw: z
        .boolean()
        .optional()
        .describe('Inkludera rå JSON; kan exponera personnummer, lön och bankuppgifter'),
    },
    async ({ employeeId, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update employee ${employeeId}`, { Employee: fields });
      }
      if (!confirm) requireConfirmation(`update employee ${employeeId}`);

      const data = await updateEmployee(employeeId, fields);
      return detailResponse(data, employeeDetailColumns, data, includeRaw);
    },
  );
}
