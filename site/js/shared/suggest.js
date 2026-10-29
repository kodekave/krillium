// Suggested 0-5 event scores for events found by discovery, on the same scales as the imported ones.
// The bands below are defaults, shown in the UI as "suggested" so a person can overrule them.
import { distanceKm } from '../map-geometry.js';

const DAY = 86400000;

const FIT_BY_HITS = [1, 2, 3, 4, 5];

// [upper bound in days (exclusive), score]; anything past the last bound scores TIMING_FAR.
const TIMING_BANDS = [[14, 1], [30, 2], [60, 3], [271, 5], [366, 4]];
const TIMING_FAR = 3;

// [upper bound in km (inclusive), score]; anything beyond the last bound scores DISTANCE_FAR.
const DISTANCE_BANDS = [[500, 5], [1500, 4], [4000, 3], [8000, 2]];
const DISTANCE_FAR = 1;

const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / DAY;

function fitFor(topicHits) {
  const hits = Number.isFinite(topicHits) && topicHits > 0 ? Math.floor(topicHits) : 0;
  return FIT_BY_HITS[Math.min(hits, FIT_BY_HITS.length - 1)];
}

function timingFor(startDate, now) {
  const start = typeof startDate === 'string' ? dayNumber(startDate) : Number.NaN;
  if (Number.isNaN(start)) return 1;
  const days = start - Math.floor(now / DAY);
  const band = TIMING_BANDS.find(([limit]) => days < limit);
  return band ? band[1] : TIMING_FAR;
}

function distanceFor(lat, lon, homeBases) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !homeBases?.length) return DISTANCE_FAR;
  const nearest = Math.min(...homeBases.map((b) => distanceKm(lat, lon, b.lat, b.lon)));
  const band = DISTANCE_BANDS.find(([limit]) => nearest <= limit);
  return band ? band[1] : DISTANCE_FAR;
}

export function suggestScore({ topicHits, startDate, lat, lon }, { homeBases, now }) {
  return {
    fit: fitFor(topicHits),
    public_names: 0,
    timing: timingFor(startDate, now),
    distance: distanceFor(lat, lon, homeBases),
  };
}
