import { scrapeDomain } from './website-scraper.js';
import { signalsFromApollo, NONE } from './signals-from-apollo.js';
import { logger } from '../services/logger.js';

// Re-export the pure helper so callers have one import path.
export { signalsFromApollo };

/**
 * Augment Apollo-only signals with a website scrape + LLM extraction.
 *
 * Falls back to signalsFromApollo() output if the scrape fails or returns
 * nothing useful. Cost: one HTTP scrape + one gpt-4o-mini call
 * (~$0.001 per domain) vs Perplexity's ~$0.005 per call.
 *
 * The LLM extractor (`enrichment/website-extractor.js`) instantiates an
 * OpenAI client at module load and crashes if OPENAI_API_KEY is unset —
 * dynamic import keeps this module testable when no key is in env.
 *
 * @param {object} contact - Must have companyDomain + Apollo org fields
 * @param {string} [verticalLabel] - Used to flavor the extraction prompt
 */
export async function signalsFromExtraction(contact, verticalLabel) {
  const base = signalsFromApollo(contact);
  const domain = contact.companyDomain;
  if (!domain) return base;

  try {
    const scrape = await scrapeDomain(domain);
    if (!scrape || !scrape.pageTexts?.[0]) return base;

    const { extractFromWebsite } = await import('./website-extractor.js');
    const extracted = await extractFromWebsite(
      scrape.pageTexts[0],
      domain,
      verticalLabel || contact.verticalLabel
    );

    // Prefer website description over Apollo's when both exist — the LLM
    // rephrases site copy into prose that reads more naturally.
    const hookFromSite = extracted.companyDescription
      ? extracted.companyDescription.trim().slice(0, 220)
      : '';
    const specialtyHook =
      extracted.specialties && extracted.specialties.length > 0
        ? `${contact.companyName || domain} specializes in ${extracted.specialties.slice(0, 3).join(', ')}`
        : '';

    return {
      ...base,
      personalizedHook: hookFromSite || specialtyHook || base.personalizedHook,
      growthSignal:
        base.growthSignal !== NONE
          ? base.growthSignal
          : extracted.locationCount > 1
          ? `Multi-location operator (${extracted.locationCount} locations)`
          : base.growthSignal,
    };
  } catch (err) {
    logger.warn('signalsFromExtraction failed, falling back to Apollo-only', {
      domain,
      error: err.message,
    });
    return base;
  }
}
