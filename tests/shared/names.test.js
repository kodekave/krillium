import { describe, it, expect } from 'vitest';
import { nameKey, nameSimilarity, nameTokens, registrableDomain, slugify } from '../../site/js/shared/names.js';

describe('nameTokens and nameKey', () => {
  it('drops years, ordinals, filler words and punctuation', () => {
    expect(nameTokens('SSOW Europe 2027')).toEqual(['europe', 'ssow']);
    expect(nameTokens('The 21st Annual Shared Services & Outsourcing Week 2026 (DACH)')).toEqual([
      'dach', 'outsourcing', 'services', 'shared', 'week',
    ]);
  });

  it('folds accents and case, and is stable for the same event written two ways', () => {
    expect(nameKey('SSOW Europe 2027')).toBe(nameKey('ssow  EUROPE'));
    expect(nameKey('Zürich Summit')).toBe(nameKey('zurich'));
  });

  it('joins tokens with one space', () => {
    expect(nameKey('Procurement Logistics Symposium')).toBe('logistics procurement symposium');
  });
});

describe('nameSimilarity', () => {
  it('treats the same event written two ways as identical', () => {
    expect(
      nameSimilarity('BME Symposium Procurement and Logistics', 'BME Symposium Procurement & Logistics 2026'),
    ).toBe(1);
  });

  it('keeps sibling events from one organiser apart', () => {
    expect(nameSimilarity('SSOW Orlando', 'SSOW Europe')).toBeLessThan(0.6);
  });

  it('deliberately does not merge an acronym with its full name', () => {
    expect(nameSimilarity('SSOW DACH', 'Shared Services and Outsourcing Week DACH')).toBeLessThan(0.6);
  });

  it('returns 0 when either name has no usable tokens', () => {
    expect(nameSimilarity('', 'SSOW Europe')).toBe(0);
    expect(nameSimilarity('2027', 'SSOW Europe')).toBe(0);
  });
});

describe('registrableDomain', () => {
  it('returns the site, ignoring subdomains and paths', () => {
    expect(registrableDomain('https://www.ssonetwork.com/events-ssoweek')).toBe('ssonetwork.com');
    expect(registrableDomain('https://events.bme.de/x')).toBe('bme.de');
  });

  it('keeps three labels under known second-level domains', () => {
    expect(registrableDomain('https://foo.co.uk/a')).toBe('foo.co.uk');
    expect(registrableDomain('https://www.x.com.au/')).toBe('x.com.au');
  });

  it('gives null for anything that is not an http(s) URL', () => {
    for (const bad of ['not a url', '', null, undefined, 'mailto:a@b.com', 'ftp://x.com/a']) {
      expect(registrableDomain(bad)).toBeNull();
    }
  });
});

describe('slugify', () => {
  it('makes a lower-case dash slug', () => {
    expect(slugify('BVL Supply Chain CX')).toBe('bvl-supply-chain-cx');
    expect(slugify('  Zürich & Co. 2027! ')).toBe('zurich-co-2027');
  });
});
