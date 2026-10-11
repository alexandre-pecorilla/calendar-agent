import type { CalcomClient } from './client.js';
import type { CalendarRef, Schedule } from './types.js';

/**
 * Calendars and the default schedule change rarely: cached ten minutes.
 * Busy times are never cached (scope §7).
 */
export class CalcomCache {
  private calendarsAt = 0;
  private calendarsVal: CalendarRef[] | null = null;
  private scheduleAt = 0;
  private scheduleVal: Schedule | null | undefined;

  constructor(
    private readonly client: CalcomClient,
    private readonly ttlMs = 600_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async calendars(): Promise<CalendarRef[]> {
    if (this.calendarsVal && this.now() - this.calendarsAt < this.ttlMs) return this.calendarsVal;
    this.calendarsVal = await this.client.calendars();
    this.calendarsAt = this.now();
    return this.calendarsVal;
  }

  async selectedCalendars(): Promise<CalendarRef[]> {
    return (await this.calendars()).filter((c) => c.isSelected);
  }

  async defaultSchedule(): Promise<Schedule | null> {
    if (this.scheduleVal !== undefined && this.now() - this.scheduleAt < this.ttlMs) return this.scheduleVal;
    this.scheduleVal = await this.client.defaultSchedule();
    this.scheduleAt = this.now();
    return this.scheduleVal;
  }

  invalidate(): void {
    this.calendarsVal = null;
    this.scheduleVal = undefined;
    this.calendarsAt = 0;
    this.scheduleAt = 0;
  }
}
