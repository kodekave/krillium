import { describe, it, expect } from 'vitest';
import { domainMatches, classifyPersona, normaliseCompanyName } from '../../site/js/shared/clean.js';

describe('domainMatches', () => {
  it('rejects the three domain-mismatch emails from the case study', () => {
    expect(domainMatches('janssen.ie', 'jnj.com', [])).toBe(false);
    expect(domainMatches('paloaltonetworks.com', 'johnsoncontrols.com', [])).toBe(false);
    expect(domainMatches('cef.co.uk', 'cityelectricsupply.com', [])).toBe(false);
  });

  it('accepts the same domain and subdomains of it', () => {
    expect(domainMatches('wesco.com', 'wesco.com', [])).toBe(true);
    expect(domainMatches('mail.wesco.com', 'wesco.com', [])).toBe(true);
  });

  it('accepts a known alias regardless of case', () => {
    expect(domainMatches('EFFEM.com', 'mars.com', ['effem.com'])).toBe(true);
  });

  it('does not accept a look-alike suffix', () => {
    expect(domainMatches('notwesco.com', 'wesco.com', [])).toBe(false);
  });
});

describe('classifyPersona', () => {
  it('maps economic buyer titles in English and German', () => {
    expect(classifyPersona('CFO')).toBe('economic_buyer');
    expect(classifyPersona('Leiter Einkauf')).toBe('economic_buyer');
    expect(classifyPersona('GESCHÄFTSFÜHRER')).toBe('economic_buyer');
  });

  it('maps champion titles', () => {
    expect(classifyPersona('Head of Order to Cash')).toBe('champion');
    expect(classifyPersona('Leiter Supply Chain Management')).toBe('champion');
  });

  it('maps influencer titles', () => {
    expect(classifyPersona('Global Process Owner')).toBe('influencer');
    expect(classifyPersona('ERP Lead')).toBe('influencer');
  });

  it('sends unclear titles to the reviewer as null', () => {
    expect(classifyPersona('Prof. Dr. Erika Mustermann, Präsidentin')).toBeNull();
    expect(classifyPersona('Senior Intern')).toBeNull();
  });
});

describe('normaliseCompanyName', () => {
  it('treats name variants as the same company', () => {
    expect(normaliseCompanyName('Siemens AG')).toBe(normaliseCompanyName('SIEMENS'));
  });

  it('strips legal suffixes and diacritics', () => {
    expect(normaliseCompanyName('Müller Logistik GmbH')).toBe('muller logistik');
    expect(normaliseCompanyName('Acme Corp.')).toBe('acme');
  });
});
