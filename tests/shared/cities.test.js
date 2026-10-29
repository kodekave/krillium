import { describe, it, expect } from 'vitest';
import { CITY_COORDS, coordsForCity, countryCode } from '../../site/js/shared/cities.js';

const DEV_SEED_CITIES = ['Berlin', 'Washington, DC', 'Orlando', 'Las Vegas', 'New York', 'Estoril', 'Schaumburg'];

describe('coordsForCity', () => {
  it('resolves a known city', () => {
    expect(coordsForCity('Berlin')).toEqual([52.52, 13.405]);
  });

  it('folds accents and case', () => {
    expect(coordsForCity('Zürich')[0]).not.toBeNull();
    expect(coordsForCity('Zürich')).toEqual(coordsForCity('zurich'));
    expect(coordsForCity('São Paulo')[0]).not.toBeNull();
  });

  it('drops a trailing state or DC suffix as the importer always did', () => {
    expect(coordsForCity('Washington, DC')).toEqual([38.9072, -77.0369]);
    expect(coordsForCity('Washington DC')).toEqual([38.9072, -77.0369]);
  });

  it('knows common local-language aliases', () => {
    expect(coordsForCity('München')).toEqual(coordsForCity('Munich'));
    expect(coordsForCity('Bangalore')).toEqual(coordsForCity('Bengaluru'));
    expect(coordsForCity('NYC')).toEqual(coordsForCity('New York'));
  });

  it('gives [null, null] for unknown, empty and inherited property names', () => {
    for (const bad of ['Nowhereville', null, undefined, '', 'constructor', '__proto__', 'toString']) {
      expect(coordsForCity(bad)).toEqual([null, null]);
    }
  });

  it('covers every dev-seed city', () => {
    for (const city of DEV_SEED_CITIES) expect(coordsForCity(city)[0], city).not.toBeNull();
  });

  it('holds about 150 cities with valid coordinates', () => {
    const entries = Object.entries(CITY_COORDS);
    expect(entries.length).toBeGreaterThanOrEqual(140);
    for (const [city, [lat, lon]] of entries) {
      expect(Math.abs(lat), city).toBeLessThanOrEqual(90);
      expect(Math.abs(lon), city).toBeLessThanOrEqual(180);
    }
  });
});

describe('countryCode', () => {
  it('maps English names and ISO-2 codes to ISO-2', () => {
    expect(countryCode('Germany')).toBe('DE');
    expect(countryCode('de')).toBe('DE');
    expect(countryCode('DE')).toBe('DE');
    expect(countryCode('United Arab Emirates')).toBe('AE');
    expect(countryCode('United States')).toBe('US');
    expect(countryCode('USA')).toBe('US');
    expect(countryCode('UK')).toBe('GB');
    expect(countryCode('Türkiye')).toBe('TR');
  });

  it('gives null for unknown or empty input', () => {
    for (const bad of ['Narnia', 'ZZ', '', null, undefined, 'constructor']) expect(countryCode(bad)).toBeNull();
  });
});
