import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { pathSegment } from '../identifiers.js';

interface ScheduleTimeResponse {
  ScheduleTime: Record<string, unknown>;
}

export function createScheduleTimeOperations(transport: FortnoxTransport) {
  async function getScheduleTime(
    employeeId: string,
    date: string,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<ScheduleTimeResponse>(
      `scheduletimes/${pathSegment('employee id', employeeId)}/${pathSegment('date', date)}`,
    );
    return data.ScheduleTime;
  }

  async function updateScheduleTime(
    employeeId: string,
    date: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // EmployeeId and Date are the path keys — never send them in the PUT body.
    const { EmployeeId: _employeeId, Date: _date, ...body } = fields;
    const data = await transport.request<ScheduleTimeResponse>(
      `scheduletimes/${pathSegment('employee id', employeeId)}/${pathSegment('date', date)}`,
      {
        method: 'PUT',
        body: { ScheduleTime: body },
      },
    );
    return data.ScheduleTime;
  }

  async function resetScheduleTimeDay(
    employeeId: string,
    date: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // EmployeeId and Date are the path keys — never send them in the PUT body.
    const { EmployeeId: _employeeId, Date: _date, ...body } = fields;
    const data = await transport.request<ScheduleTimeResponse>(
      `scheduletimes/${pathSegment('employee id', employeeId)}/${pathSegment('date', date)}/resetday`,
      {
        method: 'PUT',
        body: { ScheduleTime: body },
      },
    );
    return data.ScheduleTime;
  }

  return { getScheduleTime, updateScheduleTime, resetScheduleTimeDay };
}

export const { getScheduleTime, updateScheduleTime, resetScheduleTimeDay } =
  createScheduleTimeOperations(defaultFortnoxTransport);
