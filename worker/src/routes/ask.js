import { error, json } from '../http.js';
import { getFeed, getRankedEvents, parseTime } from '../db.js';

const DAY = 86400000;
const ISO_DATE = /^\d{4}-\d\d-\d\d$/;

const INTENTS = {
  async top_events_in_range({ env, url }) {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!ISO_DATE.test(from ?? '') || !ISO_DATE.test(to ?? '')) return error(400, 'from and to must be YYYY-MM-DD dates');
    const { events } = await getRankedEvents(env.DB);
    const rows = events
      .filter((e) => e.startDate && e.startDate <= to && (e.endDate ?? e.startDate) >= from)
      .map(({ id, name, city, startDate, endDate, priority, status }) => ({ id, name, city, startDate, endDate, priority, status }));
    return json({ intent: 'top_events_in_range', rows });
  },

  async changed_this_week({ env }) {
    const feed = await getFeed(env.DB, 200);
    const cutoff = Date.now() - 7 * DAY;
    const rows = feed.filter((c) => c.kind !== 'imported' && parseTime(c.at) >= cutoff);
    return json({ intent: 'changed_this_week', rows });
  },

  async tier_a_by_event({ env, url }) {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if ((from || to) && !(ISO_DATE.test(from ?? '') && ISO_DATE.test(to ?? ''))) return error(400, 'from and to must be YYYY-MM-DD dates');
    const { events } = await getRankedEvents(env.DB);
    const rows = events
      .filter((e) => !from || !e.startDate || (e.startDate <= to && (e.endDate ?? e.startDate) >= from))
      .map((e) => ({ id: e.id, name: e.name, tierA: e.counts.tierA, priority: e.priority }))
      .sort((a, b) => b.tierA - a.tierA || b.priority - a.priority)
      .slice(0, 10);
    return json({ intent: 'tier_a_by_event', rows });
  },
};

export async function ask(ctx) {
  const handler = Object.hasOwn(INTENTS, ctx.url.searchParams.get('intent') ?? '')
    ? INTENTS[ctx.url.searchParams.get('intent')]
    : null;
  return handler ? handler(ctx) : error(400, 'unknown intent');
}
