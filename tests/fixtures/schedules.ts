import type { Schedule } from '../../src/calcom/types.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;

export const parisOfficeHours: Schedule = {
  id: 1,
  name: 'Office',
  timeZone: 'Europe/Paris',
  availability: [{ days: [...WEEKDAYS], startTime: '09:00', endTime: '17:00' }],
  isDefault: true,
  overrides: [],
};

export const newYorkAllWeek: Schedule = {
  id: 2,
  name: 'All week',
  timeZone: 'America/New_York',
  availability: [{ days: [...WEEKDAYS, 'Saturday', 'Sunday'], startTime: '07:00', endTime: '19:00' }],
  isDefault: true,
  overrides: [],
};

export const splitHours: Schedule = {
  id: 3,
  name: 'Split',
  timeZone: 'Europe/Paris',
  availability: [
    { days: [...WEEKDAYS], startTime: '09:00', endTime: '12:00' },
    { days: [...WEEKDAYS], startTime: '14:00', endTime: '18:00' },
  ],
  isDefault: true,
  overrides: [],
};

export const withOverride: Schedule = {
  ...parisOfficeHours,
  id: 4,
  overrides: [{ date: '2026-10-14', startTime: '13:00', endTime: '15:00' }],
};

export const midnightEnd: Schedule = {
  ...parisOfficeHours,
  id: 5,
  availability: [{ days: [...WEEKDAYS], startTime: '20:00', endTime: '24:00' }],
};
