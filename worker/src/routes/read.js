import { error, json } from '../http.js';
import { getActiveConfig, getEventDetail, getFeed, getRankedEvents } from '../db.js';

export async function radar({ env }) {
  const { events } = await getRankedEvents(env.DB);
  return json(events);
}

export async function eventDetail({ env, params }) {
  const detail = await getEventDetail(env.DB, decodeURIComponent(params[0]));
  return detail ? json(detail) : error(404, 'event not found');
}

export async function feed({ env }) {
  return json(await getFeed(env.DB));
}

export async function icp({ env }) {
  return json(await getActiveConfig(env.DB));
}
