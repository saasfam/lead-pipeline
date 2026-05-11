/**
 * Pure synth: build a Perplexity-shaped signals object out of Apollo's
 * org-level fields. No network. Tests can import this directly without
 * pulling in the OpenAI client that website-extractor instantiates at
 * module load.
 *
 * Output matches enrichment/perplexity-signals.searchCompanySignals():
 *   { properCompanyName, industry,
 *     recentFunding, hiringSignal, recentNews, growthSignal,
 *     personalizedHook }
 */

export const NONE = 'None found';

export function signalsFromApollo(contact) {
  const company = contact.companyName || '';
  const industry = contact.companyIndustry || '';
  const description = contact.companyDescription || '';

  return {
    properCompanyName: company,
    industry,
    recentFunding: composeFundingSignal(contact),
    // Hiring + news signals can't be derived from Apollo people-search
    // alone. The variety picker (config/message-variety.js) handles missing
    // data gracefully — pain-point-direct and question-lead openers don't
    // need any signals.
    hiringSignal: NONE,
    recentNews: NONE,
    growthSignal: composeGrowthSignal(contact),
    personalizedHook: composeHook(contact, description),
  };
}

export function composeFundingSignal(contact) {
  const stage = contact.latestFundingStage || '';
  const date = contact.latestFundingDate || '';
  const amount = contact.latestFundingAmount || '';

  if (!stage && !date && !amount) return NONE;

  // Recency filter: only surface funding within the last 18 months. Otherwise
  // it's stale and a "Raised Series A in 2019" hook embarrasses the SDR.
  if (date) {
    const fundedAt = new Date(date);
    const ageDays = (Date.now() - fundedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (!Number.isNaN(ageDays) && ageDays > 540) return NONE;
  }

  const parts = [];
  if (amount) parts.push(`Raised ${amount}`);
  else if (stage) parts.push(`Closed ${stage}`);
  if (stage && amount && !parts[0]?.includes(stage)) parts.push(`(${stage})`);
  if (date) parts.push(`as of ${date.slice(0, 10)}`);

  return parts.join(' ') || NONE;
}

export function composeGrowthSignal(contact) {
  const employees = parseInt(contact.companyEmployees, 10);
  const revenue = (contact.companyRevenue || '').trim();
  const keywords = Array.isArray(contact.companyKeywords) ? contact.companyKeywords : [];

  if (!employees && !revenue && keywords.length === 0) return NONE;

  const parts = [];
  if (employees > 0) parts.push(`${employees}-person team`);
  if (revenue) parts.push(`${revenue} revenue`);
  const filteredKeywords = keywords
    .filter((k) => k && k.length > 2 && k.length < 30)
    .slice(0, 3);
  if (filteredKeywords.length > 0) parts.push(`focused on ${filteredKeywords.join(', ')}`);

  return parts.length > 0 ? parts.join(', ') : NONE;
}

export function composeHook(contact, description) {
  const company = contact.companyName || '';
  const founded = parseInt(contact.companyFounded, 10);

  if (description && description.length > 25 && description.length < 220) {
    return description.replace(/\s+/g, ' ').trim();
  }

  if (founded && founded > 1800) {
    const years = new Date().getFullYear() - founded;
    if (years > 2 && years < 200) return `${company} — ${years} years in business`;
  }

  return company || '';
}
