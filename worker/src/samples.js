// The ten public case-study events, loaded into a new workspace on request so its radar has something to show. Public
// facts only: no people, no companies. The dev seed script reads the same list.
import { coordsForCity } from '../../site/js/shared/cities.js';
import { wsId } from './scope.js';

const sample = (id, name, organiser, url, city, country, startDate, endDate, sourceUrl, fit, publicNames, timing, distance) =>
  ({ id, name, organiser, url, city, country, startDate, endDate, sourceUrl, fit, publicNames, timing, distance });

export const SAMPLE_EVENTS = [
  sample('bvl', 'BVL Supply Chain CX', 'BVL', 'https://cx.bvl.de/en/', 'Berlin', 'DE', '2026-10-21', '2026-10-22', 'https://cx.bvl.de/en/speaker', 5, 5, 5, 4),
  sample('ssow-dach', 'SSOW DACH', 'SSON', 'https://www.ssonetwork.com/events-shared-services-week', 'Berlin', 'DE', '2026-11-17', '2026-11-19', 'https://www.ssonetwork.com/events-sharedserviceswoche/agenda-mc', 5, 3, 5, 5),
  sample('bme-sym', 'BME Symposium Procurement and Logistics', 'BME', 'https://www.bme.de/symposium-procurement-logistics/', 'Berlin', 'DE', '2026-11-18', '2026-11-19', 'https://www.bme.de/veranstaltungen/grossveranstaltungen/60th-symposium-procurement-and-logistics/speakers/', 5, 5, 5, 5),
  sample('naw', 'NAW Executive Summit', 'NAW', 'https://www.naw.org/events/naw-executive-summit/', 'Washington, DC', 'US', '2027-01-19', '2027-01-21', 'https://www.naw.org/events/naw-executive-summit/', 5, 4, 4, 4),
  sample('ssow-orl', 'SSOW Orlando', 'SSON', 'https://www.ssonetwork.com/events-ssoweek', 'Orlando', 'US', '2027-03-08', '2027-03-11', 'https://www.luminik.io/events/shared-services-outsourcing-week-conference-orlando-b90f29ef22c7/attendees/', 4, 4, 4, 3),
  sample('sapinsider', 'SAPinsider Las Vegas', 'SAPinsider', 'https://vegas.sapinsider.org/', 'Las Vegas', 'US', '2027-03-15', '2027-03-18', 'https://vegas.sapinsider.org/', 4, 3, 3, 3),
  sample('bme-eu', 'BME European Procurement and Supply Chain Excellence Summit', 'BME', 'https://www.bme.de/veranstaltungen/grossveranstaltungen/european-procurement-supply-chain-excellence-summit/', 'Berlin', 'DE', '2027-04-19', '2027-04-20', 'https://www.bme.de/veranstaltungen/grossveranstaltungen/european-procurement-supply-chain-excellence-summit/summit-speakers/', 4, 3, 4, 3),
  sample('impact-nyc', 'Industry Impact Summit NYC', 'Supply Chain LIVE', 'https://supplychaindigital.com/events/procurement-supply-chain-live/the-new-york-summit-supply-chain-live-2027', 'New York', 'US', '2027-04-20', '2027-04-21', 'https://supplychaindigital.com/events/procurement-supply-chain-live/the-new-york-summit-procurement-live-2027', 4, 3, 3, 3),
  sample('ssow-eu', 'SSOW Europe', 'SSON', 'https://www.ssonetwork.com/events-ssoweek', 'Estoril', 'PT', '2027-05-10', '2027-05-13', 'https://ssonetwork.com/events-ssoweek/downloads/shared-services-outsourcing-week-europe-2025-attendee-snapshot', 4, 3, 3, 2),
  sample('applied-ai', 'Applied AI for Distributors', 'Distribution Strategy Group', 'https://distributionstrategy.com/2026/09/applied-ai-2027-expands-as-distributors-move-from-pilots-to-deployment/', 'Schaumburg', 'US', '2027-06-22', '2027-06-24', 'https://distributionstrategy.com/2026/06/graybar-grainger-executives-to-headline-dsg-ai-conference-in-chicago/', 4, 3, 3, 2),
];

// Adds the samples that this workspace does not have yet and says how many it added, so a second click adds nothing.
// One statement per event, in one batch.
export async function loadSamples(db, workspaceId) {
  wsId(workspaceId);
  const results = await db.batch(
    SAMPLE_EVENTS.map((e) => {
      const [lat, lon] = coordsForCity(e.city);
      return db
        .prepare(
          `INSERT OR IGNORE INTO events (workspace_id, id, name, organiser, url, city, country, lat, lon, start_date, end_date,
             source_url, last_checked, fit, public_names, timing, distance, origin, auto_added, sectors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'import', 0, '["procurement"]')`,
        )
        .bind(workspaceId, e.id, e.name, e.organiser, e.url, e.city, e.country, lat, lon, e.startDate, e.endDate, e.sourceUrl, e.fit, e.publicNames, e.timing, e.distance);
    }),
  );
  return { added: results.reduce((n, r) => n + r.meta.changes, 0) };
}
