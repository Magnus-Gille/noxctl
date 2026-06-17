import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface EmployeeResponse {
  Employee: Record<string, unknown>;
}

interface EmployeesResponse {
  Employees: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListEmployeesParams {
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listEmployees(params: ListEmployeesParams = {}): Promise<EmployeesResponse> {
  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'employees',
      'Employees',
    );
    return {
      Employees: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<EmployeesResponse>('employees', {
    params: { page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getEmployee(employeeId: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<EmployeeResponse>(
    `employees/${encodeURIComponent(employeeId)}`,
  );
  return data.Employee;
}

export async function createEmployee(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<EmployeeResponse>('employees', {
    method: 'POST',
    body: { Employee: params },
  });
  return data.Employee;
}

export async function updateEmployee(
  employeeId: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // EmployeeId is the path key — never send it in the PUT body.
  const { EmployeeId: _, ...body } = fields;
  const data = await fortnoxRequest<EmployeeResponse>(
    `employees/${encodeURIComponent(employeeId)}`,
    {
      method: 'PUT',
      body: { Employee: body },
    },
  );
  return data.Employee;
}
