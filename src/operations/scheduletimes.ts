import { fortnoxRequest } from '../fortnox-client.js';

interface ScheduleTimeResponse {
  ScheduleTime: Record<string, unknown>;
}

export async function getScheduleTime(
  employeeId: string,
  date: string,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<ScheduleTimeResponse>(
    `scheduletimes/${encodeURIComponent(employeeId)}/${encodeURIComponent(date)}`,
  );
  return data.ScheduleTime;
}

export async function updateScheduleTime(
  employeeId: string,
  date: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // EmployeeId and Date are the path keys — never send them in the PUT body.
  const { EmployeeId: _employeeId, Date: _date, ...body } = fields;
  const data = await fortnoxRequest<ScheduleTimeResponse>(
    `scheduletimes/${encodeURIComponent(employeeId)}/${encodeURIComponent(date)}`,
    {
      method: 'PUT',
      body: { ScheduleTime: body },
    },
  );
  return data.ScheduleTime;
}

export async function resetScheduleTimeDay(
  employeeId: string,
  date: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // EmployeeId and Date are the path keys — never send them in the PUT body.
  const { EmployeeId: _employeeId, Date: _date, ...body } = fields;
  const data = await fortnoxRequest<ScheduleTimeResponse>(
    `scheduletimes/${encodeURIComponent(employeeId)}/${encodeURIComponent(date)}/resetday`,
    {
      method: 'PUT',
      body: { ScheduleTime: body },
    },
  );
  return data.ScheduleTime;
}
