import { CalcomClient } from '../calcom/client.js';
import { secretProvider } from '../services/keys.js';
import { cliContext } from './context.js';

/** `make calcom-check`: live, read-only, prints ids and emails only (the owner's own). Uses the key the instance uses (admin Settings, else .env). */
const { config, repos } = cliContext();
const apiKey = secretProvider(repos.settings, 'calcom_api_key', config.CALCOM_API_KEY);
if (!apiKey()) {
  console.error('No Cal.com API key: paste it in the admin Settings, or set CALCOM_API_KEY in .env before the first start.');
  repos.db.close();
  process.exit(2);
}
const client = new CalcomClient({ apiKey });
try {
  const me = await client.me();
  console.log(`me: username=${me.username ?? '?'} timeZone=${me.timeZone ?? '?'}`);
  const cals = await client.calendars();
  const selected = cals.filter((c) => c.isSelected);
  console.log(`calendars: ${cals.length} connected, ${selected.length} selected (checked for conflicts):`);
  for (const c of selected) console.log(`  cred=${c.credentialId} ${c.externalId}${c.readOnly ? ' (read-only)' : ''}`);
  const s = await client.defaultSchedule();
  if (!s) console.log('schedule: none (data null)');
  else {
    console.log(`schedule: "${s.name}" tz=${s.timeZone} default=${s.isDefault} overrides=${s.overrides.length}`);
    for (const a of s.availability) console.log(`  ${a.days.join(',')}: ${a.startTime}-${a.endTime}`);
  }
  console.log('calcom-check: OK');
} catch (err) {
  console.error('calcom-check: FAILED:', (err as Error).message);
  process.exit(1);
}
