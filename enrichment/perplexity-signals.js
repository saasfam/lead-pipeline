import { RateLimiter } from '../pipeline/rate-limiter.js';
import { logger } from '../services/logger.js';

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

/**
 * Strip Perplexity citation markers like [1], [3][5] and collapse extra whitespace.
 */
function stripCitations(text) {
  return text.replace(/\[\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// 1 request per second — conservative to avoid rate limits
const perplexityLimiter = new RateLimiter(1, 1_000);

const SYSTEM_PROMPT = `You are a company research assistant. Given a company name and domain,
return a JSON object with these fields:
- recentFunding: any funding rounds in the last 12 months (amount, stage, date) or "None found"
- hiringSignal: notable hiring activity or job postings, or "None found"
- recentNews: most notable recent news/announcement, or "None found"
- growthSignal: evidence of growth (new markets, partnerships, revenue milestones), or "None found"
- personalizedHook: one sentence an SDR could use to open a cold email referencing the strongest signal
Return ONLY valid JSON, no markdown.`;

/**
 * Search Perplexity for company signals (funding, hiring, news, growth).
 *
 * @param {string} domain - Company domain
 * @param {string} companyName - Company name
 * @returns {object} - Signal fields or defaults
 */
export async function searchCompanySignals(domain, companyName) {
  await perplexityLimiter.acquire();

  const defaults = {
    recentFunding: 'None found',
    hiringSignal: 'None found',
    recentNews: 'None found',
    growthSignal: 'None found',
    personalizedHook: '',
  };

  if (!PERPLEXITY_API_KEY) {
    logger.error('PERPLEXITY_API_KEY not set');
    return defaults;
  }

  const query = `"${companyName}" (${domain}) recent news funding hiring 2025 2026`;

  try {
    const res = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: query },
        ],
        max_tokens: 500,
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error('Perplexity API error', {
        domain,
        status: res.status,
        error: errText,
      });
      return defaults;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      logger.warn('Perplexity returned empty content', { domain });
      return defaults;
    }

    // Parse JSON from response — strip markdown fences and trailing text
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let signals;
    try {
      signals = JSON.parse(cleaned);
    } catch {
      // Extract first JSON object if there's trailing text after it
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON object found in response');
      signals = JSON.parse(match[0]);
    }

    logger.info('Perplexity signals fetched', {
      domain,
      hasSignals: Object.values(signals).some((v) => v && v !== 'None found'),
    });

    return {
      recentFunding: stripCitations(signals.recentFunding || defaults.recentFunding),
      hiringSignal: stripCitations(signals.hiringSignal || defaults.hiringSignal),
      recentNews: stripCitations(signals.recentNews || defaults.recentNews),
      growthSignal: stripCitations(signals.growthSignal || defaults.growthSignal),
      personalizedHook: stripCitations(signals.personalizedHook || defaults.personalizedHook),
    };
  } catch (err) {
    logger.error('Perplexity search error', {
      domain,
      error: err.message,
    });
    return defaults;
  }
}

