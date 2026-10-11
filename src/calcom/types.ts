import { z } from 'zod';

/** Shapes from the Cal.com API v2 OpenAPI spec (read 2026-10-09). */

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const scheduleSchema = z.object({
  id: z.number(),
  name: z.string(),
  timeZone: z.string().min(1),
  availability: z.array(
    z.object({
      days: z.array(z.enum(WEEKDAYS)),
      startTime: hhmm,
      endTime: hhmm,
    }),
  ),
  isDefault: z.boolean(),
  overrides: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: hhmm, endTime: hhmm })).default([]),
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const scheduleResponseSchema = z.object({
  status: z.enum(['success', 'error']),
  data: scheduleSchema.nullable(),
});

const calendarSchema = z.object({
  externalId: z.string(),
  integration: z.string().optional(),
  name: z.string().nullable().optional(),
  primary: z.boolean().nullable().optional(),
  readOnly: z.boolean(),
  email: z.string().nullable().optional(),
  isSelected: z.boolean(),
  credentialId: z.number(),
});

export const calendarsResponseSchema = z.object({
  status: z.enum(['success', 'error']),
  data: z.object({
    connectedCalendars: z.array(
      z.object({
        integration: z.object({ name: z.string().optional(), slug: z.string().optional(), type: z.string().optional() }).passthrough(),
        credentialId: z.number(),
        calendars: z.array(calendarSchema).optional(),
      }),
    ),
  }),
});

export interface CalendarRef {
  credentialId: number;
  externalId: string;
  name: string | null;
  email: string | null;
  integration: string | null;
  isSelected: boolean;
  readOnly: boolean;
  primary: boolean;
}

/** `source` is deliberately absent: it is dropped at parse time (scope §3.1). */
export const busyTimesResponseSchema = z.object({
  status: z.enum(['success', 'error']),
  data: z.array(z.object({ start: z.string(), end: z.string() }).strip()),
});

export interface BusyInterval {
  start: string;
  end: string;
}

export const meResponseSchema = z.object({
  status: z.enum(['success', 'error']),
  data: z.object({ username: z.string().optional(), timeZone: z.string().optional() }).passthrough(),
});
