import type { Secret } from '../crypto/secret.js';
import type { Logger } from '../logging/logger.js';
import {
  busyTimesResponseSchema,
  calendarsResponseSchema,
  meResponseSchema,
  scheduleResponseSchema,
  type BusyInterval,
  type CalendarRef,
  type Schedule,
} from './types.js';

/**
 * The entire Cal.com surface this application can reach. Scope §6.2:
 * four read functions, one literal HTTP method, a frozen path allowlist.
 * Nothing else exists, so no prompt and no bug in a caller can book, cancel
 * or read anything beyond free/busy. `tests/repo/calcom-allowlist.test.ts`
 * enforces this file's shape.
 */
export const CALCOM_BASE_URL = 'https://api.cal.com';

export const ALLOWED_PATHS = Object.freeze({
  me: '/v2/me',
  calendars: '/v2/calendars',
  defaultSchedule: '/v2/schedules/default',
  busyTimes: '/v2/calendars/busy-times',
} as const);
export type AllowedPath = (typeof ALLOWED_PATHS)[keyof typeof ALLOWED_PATHS];

/** `cal-api-version` per endpoint (API v2 reference). */
const API_VERSION_DEFAULT = '2024-08-13';
const API_VERSION_SCHEDULES = '2024-06-11';

export type CalcomErrorKind = 'not_configured' | 'unauthorized' | 'unavailable' | 'bad_response' | 'refused';

export class CalcomError extends Error {
  constructor(
    readonly kind: CalcomErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CalcomError';
  }
}

export interface CalcomClientOptions {
  apiKey: () => Secret | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const ALLOWED_SET: ReadonlySet<string> = new Set(Object.values(ALLOWED_PATHS));

export class CalcomClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: CalcomClientOptions) {
    this.baseUrl = (opts.baseUrl ?? CALCOM_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The only HTTP call in this module. GET, allowlisted path, nothing else. */
  private async get(path: AllowedPath, params: URLSearchParams, version: string): Promise<unknown> {
    if (!ALLOWED_SET.has(path)) throw new CalcomError('refused', 'Path not in the Cal.com allowlist.');
    const key = this.opts.apiKey();
    if (!key) throw new CalcomError('not_configured', 'No Cal.com API key is configured.');
    const url = `${this.baseUrl}${path}${params.size ? `?${params.toString()}` : ''}`;
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${key.reveal()}`,
            'cal-api-version': version,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt <= this.retries) {
          await this.sleep(300 * 3 ** (attempt - 1));
          continue;
        }
        throw new CalcomError('unavailable', `Cal.com unreachable: ${(err as Error).name}`);
      }
      if (res.status === 401 || res.status === 403) throw new CalcomError('unauthorized', 'Cal.com rejected the API key.', res.status);
      if (res.status === 429 || res.status >= 500) {
        if (attempt <= this.retries) {
          await this.sleep(300 * 3 ** (attempt - 1));
          continue;
        }
        throw new CalcomError('unavailable', `Cal.com responded ${res.status}.`, res.status);
      }
      if (!res.ok) throw new CalcomError('bad_response', `Cal.com responded ${res.status}.`, res.status);
      try {
        return (await res.json()) as unknown;
      } catch {
        throw new CalcomError('bad_response', 'Cal.com returned a non-JSON body.', res.status);
      }
    }
  }

  async me(): Promise<{ username: string | null; timeZone: string | null }> {
    const body = meResponseSchema.safeParse(await this.get(ALLOWED_PATHS.me, new URLSearchParams(), API_VERSION_DEFAULT));
    if (!body.success || body.data.status !== 'success') throw new CalcomError('bad_response', 'Unexpected /v2/me payload.');
    return { username: body.data.data.username ?? null, timeZone: body.data.data.timeZone ?? null };
  }

  async calendars(): Promise<CalendarRef[]> {
    const body = calendarsResponseSchema.safeParse(await this.get(ALLOWED_PATHS.calendars, new URLSearchParams(), API_VERSION_DEFAULT));
    if (!body.success || body.data.status !== 'success') throw new CalcomError('bad_response', 'Unexpected /v2/calendars payload.');
    const out: CalendarRef[] = [];
    for (const cc of body.data.data.connectedCalendars) {
      for (const c of cc.calendars ?? []) {
        out.push({
          credentialId: c.credentialId,
          externalId: c.externalId,
          name: c.name ?? null,
          email: c.email ?? null,
          integration: c.integration ?? cc.integration.slug ?? cc.integration.name ?? null,
          isSelected: c.isSelected,
          readOnly: c.readOnly,
          primary: c.primary ?? false,
        });
      }
    }
    return out;
  }

  async defaultSchedule(): Promise<Schedule | null> {
    const body = scheduleResponseSchema.safeParse(await this.get(ALLOWED_PATHS.defaultSchedule, new URLSearchParams(), API_VERSION_SCHEDULES));
    if (!body.success || body.data.status !== 'success') throw new CalcomError('bad_response', 'Unexpected /v2/schedules/default payload.');
    return body.data.data;
  }

  /**
   * Busy intervals for the given calendars between two dates (inclusive,
   * YYYY-MM-DD, interpreted in `timeZone`). Only `start` and `end` survive
   * parsing; `source` never enters the application.
   */
  async busyTimes(args: {
    dateFrom: string;
    dateTo: string;
    timeZone: string;
    calendars: Array<{ credentialId: number; externalId: string }>;
  }): Promise<BusyInterval[]> {
    if (args.calendars.length === 0) return [];
    const params = new URLSearchParams();
    params.set('dateFrom', args.dateFrom);
    params.set('dateTo', args.dateTo);
    params.set('timeZone', args.timeZone);
    for (const c of args.calendars) params.append('calendar', `${c.credentialId},${c.externalId}`);
    const body = busyTimesResponseSchema.safeParse(await this.get(ALLOWED_PATHS.busyTimes, params, API_VERSION_DEFAULT));
    if (!body.success || body.data.status !== 'success') throw new CalcomError('bad_response', 'Unexpected busy-times payload.');
    return body.data.data.map((b) => ({ start: b.start, end: b.end }));
  }
}
