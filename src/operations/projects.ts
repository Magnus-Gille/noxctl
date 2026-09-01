import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

interface ProjectResponse {
  Project: Record<string, unknown>;
}

export interface ProjectsResponse {
  Projects: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListProjectsParams {
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createProjectOperations(transport: FortnoxTransport) {
  async function listProjects(params: ListProjectsParams = {}): Promise<ProjectsResponse> {
    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'projects',
        'Projects',
      );
      return {
        Projects: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<ProjectsResponse>('projects', {
      params: { page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getProject(projectNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<ProjectResponse>(
      `projects/${encodeURIComponent(projectNumber)}`,
    );
    return data.Project;
  }

  async function createProject(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<ProjectResponse>('projects', {
      method: 'POST',
      body: { Project: params },
    });
    return data.Project;
  }

  async function updateProject(
    projectNumber: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { ProjectNumber: _, ...body } = fields;
    const data = await transport.request<ProjectResponse>(
      `projects/${encodeURIComponent(projectNumber)}`,
      {
        method: 'PUT',
        body: { Project: body },
      },
    );
    return data.Project;
  }

  async function deleteProject(projectNumber: string): Promise<void> {
    await transport.request(`projects/${encodeURIComponent(projectNumber)}`, { method: 'DELETE' });
  }

  return { listProjects, getProject, createProject, updateProject, deleteProject };
}

export const { listProjects, getProject, createProject, updateProject, deleteProject } =
  createProjectOperations(defaultFortnoxTransport);
