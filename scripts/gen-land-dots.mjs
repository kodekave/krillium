#!/usr/bin/env node
// One-off, dev-time: samples the world-atlas land polygons onto a regular dot grid in map space.
// Output (committed): site/data/land-dots.json. The site ships no map library.
import { readFileSync, writeFileSync } from 'node:fs';
import { geoContains } from 'd3-geo';
import { feature } from 'topojson-client';
import { WORLD, unproject } from '../site/js/map-geometry.js';

const STEP = 9;
const topology = JSON.parse(readFileSync(new URL('../node_modules/world-atlas/land-110m.json', import.meta.url), 'utf8'));
const land = feature(topology, topology.objects.land);

const dots = [];
for (let cy = 0; cy * STEP <= WORLD.height; cy += 1) {
  for (let cx = 0; cx * STEP <= WORLD.width; cx += 1) {
    const [lat, lon] = unproject(cx * STEP, cy * STEP, WORLD);
    if (lat > 80 || lat < -58 || lon < -180 || lon > 180) continue;
    if (geoContains(land, [lon, lat])) dots.push(cx, cy);
  }
}
writeFileSync(new URL('../site/data/land-dots.json', import.meta.url), JSON.stringify({ width: WORLD.width, height: WORLD.height, step: STEP, dots }));
console.log(`wrote ${dots.length / 2} dots`);
