import { error, json } from '../http.js';
import { getActiveConfig, getEventDetail, getFeed, getGraph, getRankedEvents } from '../db.js';
import { listMemory } from '../memory.js';

export async function radar({ env, user }) {
  const { events } = await getRankedEvents(env.DB, user.workspaceId);
  return json(events);
}

export async function eventDetail({ env, params, user }) {
  const detail = await getEventDetail(env.DB, user.workspaceId, decodeURIComponent(params[0]), user.email);
  return detail ? json(detail) : error(404, 'event not found');
}

export async function feed({ env, user }) {
  return json(await getFeed(env.DB, user.workspaceId));
}

export async function icp({ env, user }) {
  return json(await getActiveConfig(env.DB, user.workspaceId));
}

export async function graph({ env, user }) {
  return json(await getGraph(env.DB, user.workspaceId));
}

// The workspace's memory: how many entries there are and the newest few.
export async function memory({ env, user, url }) {
  return json(await listMemory(env.DB, user.workspaceId, { limit: url.searchParams.get('limit') ?? 20 }));
}
