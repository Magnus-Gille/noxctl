import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface ProjectResponse {
  Project: Record<string, unknown>;
}

interface ProjectsResponse {
  Projects: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListProjectsParams {
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listProjects(params: ListProjectsParams = {}): Promise<ProjectsResponse> {
  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'projects',
      'Projects',
    );
    return {
      Projects: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<ProjectsResponse>('projects', {
    params: { page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getProject(projectNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<ProjectResponse>(
    `projects/${encodeURIComponent(projectNumber)}`,
  );
  return data.Project;
}

export async function createProject(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<ProjectResponse>('projects', {
    method: 'POST',
    body: { Project: params },
  });
  return data.Project;
}

export async function updateProject(
  projectNumber: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { ProjectNumber: _, ...body } = fields;
  const data = await fortnoxRequest<ProjectResponse>(
    `projects/${encodeURIComponent(projectNumber)}`,
    {
      method: 'PUT',
      body: { Project: body },
    },
  );
  return data.Project;
}
