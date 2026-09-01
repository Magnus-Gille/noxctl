import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { projectListColumns, projectDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';

export function registerProjectTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const { listProjects, getProject, createProject, updateProject, deleteProject } = operations;
  server.tool(
    'fortnox_list_projects',
    'Lista projekt i Fortnox. Returnerar: ProjectNumber, Description, Status, StartDate, EndDate.',
    {
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ page, limit, all, includeRaw }) => {
      const data = await listProjects({ page, limit, all });
      return listResponse(
        data.Projects ?? [],
        projectListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_project',
    'Hämta ett enskilt projekt från Fortnox. Returnerar: ProjectNumber, Description, Status, StartDate, EndDate, ContactPerson, Comments.',
    {
      projectNumber: z.string().describe('Projektnummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ projectNumber, includeRaw }) => {
      const data = await getProject(projectNumber);
      return detailResponse(data, projectDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_project',
    'Skapa ett nytt projekt i Fortnox',
    {
      Description: z.string().describe('Projektbeskrivning'),
      ProjectNumber: z
        .string()
        .optional()
        .describe('Projektnummer (genereras automatiskt om det utelämnas)'),
      Status: z
        .enum(['ONGOING', 'COMPLETED'])
        .optional()
        .describe('Status (ONGOING eller COMPLETED)'),
      StartDate: z.string().optional().describe('Startdatum (YYYY-MM-DD)'),
      EndDate: z.string().optional().describe('Slutdatum (YYYY-MM-DD)'),
      ContactPerson: z.string().optional().describe('Kontaktperson'),
      ProjectLeader: z.string().optional().describe('Projektledare'),
      Comments: z.string().optional().describe('Kommentarer'),
      confirm: z.boolean().optional().describe('Bekräfta att projektet ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa projektet'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create project "${params.Description}"`, { Project: params });
      }
      if (!confirm) requireConfirmation(`create project "${params.Description}"`);

      const data = await createProject(params);
      return detailResponse(data, projectDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_project',
    'Uppdatera ett befintligt projekt i Fortnox',
    {
      projectNumber: z.string().describe('Projektnummer att uppdatera'),
      Description: z.string().optional().describe('Projektbeskrivning'),
      Status: z
        .enum(['ONGOING', 'COMPLETED'])
        .optional()
        .describe('Status (ONGOING eller COMPLETED)'),
      StartDate: z.string().optional().describe('Startdatum (YYYY-MM-DD)'),
      EndDate: z.string().optional().describe('Slutdatum (YYYY-MM-DD)'),
      ContactPerson: z.string().optional().describe('Kontaktperson'),
      ProjectLeader: z.string().optional().describe('Projektledare'),
      Comments: z.string().optional().describe('Kommentarer'),
      confirm: z.boolean().optional().describe('Bekräfta att projektet ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera projektet'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ projectNumber, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update project ${projectNumber}`, { Project: fields });
      }
      if (!confirm) requireConfirmation(`update project ${projectNumber}`);

      const data = await updateProject(projectNumber, fields);
      return detailResponse(data, projectDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_delete_project',
    'Ta bort ett projekt i Fortnox',
    {
      projectNumber: z.string().describe('Projektnummer'),
      confirm: z.boolean().optional().describe('Bekräfta borttagningen'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att ta bort'),
    },
    async ({ projectNumber, confirm, dryRun }) => {
      if (dryRun) return dryRunResponse(`delete project ${projectNumber}`);
      if (!confirm) requireConfirmation(`delete project ${projectNumber}`);
      await deleteProject(projectNumber);
      return textResponse(`Project ${projectNumber} deleted.`);
    },
  );
}
