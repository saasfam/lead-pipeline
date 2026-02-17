import { RateLimiter } from '../pipeline/rate-limiter.js';
import { logger } from '../services/logger.js';
import { getVerticalKpis } from '../config/vertical-kpis.js';

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

const MESSAGE_SYSTEM_PROMPT = `You are a cold email copywriter for Anyreach, an AI-powered customer engagement platform. Write a personalized cold email body (around 100 words) for an SDR to send to a specific contact.

Rules:
- Open with a specific reference to their company's recent activity, news, or role
- Reference specific KPIs relevant to the contact's industry — do NOT use generic feature lists
- Tie Anyreach's value to a measurable outcome (e.g. "cut no-shows by 35%"), not generic features
- Keep the tone conversational and peer-to-peer, not salesy
- End with a soft CTA (e.g. "Worth a quick chat?" or "Open to exploring this?")
- Do NOT include subject line, greeting (Hi/Hey Name), or sign-off — just the body
- Do NOT include citation markers like [1], [2], [3]
- Return ONLY the message text, no quotes or formatting`;

/**
 * Generate a ~100-word personalized cold email message for a contact.
 *
 * @param {object} contact - Contact with firstName, lastName, title, companyName, companyDomain, verticalLabel, companyEmployees
 * @param {object} signals - Company signals (recentFunding, hiringSignal, recentNews, growthSignal)
 * @returns {string} - Personalized message body
 */
export async function generatePersonalizedMessage(contact, signals) {
  await perplexityLimiter.acquire();

  if (!PERPLEXITY_API_KEY) {
    logger.error('PERPLEXITY_API_KEY not set');
    return '';
  }

  const signalSummary = Object.entries(signals)
    .filter(([k, v]) => v && v !== 'None found' && k !== 'personalizedHook')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  // Look up vertical-specific context
  const verticalKey = contact.verticalKey || '';
  const kpiContext = getVerticalKpis(verticalKey);
  const verticalLabel = contact.verticalLabel || 'their industry';
  const companySize = contact.companyEmployees || 'unknown';

  let industryBlock = '';
  if (kpiContext) {
    industryBlock = `
Industry pain points: ${kpiContext.painPoints}
Key KPIs: ${kpiContext.kpis}
How Anyreach helps: ${kpiContext.anyreachValue}`;
  }

  const prompt = `Contact: ${contact.firstName} ${contact.lastName}, ${contact.title} at ${contact.companyName} (${contact.companyDomain})
Industry: ${verticalLabel} | Company size: ${companySize} employees
${industryBlock}

Company signals:
${signalSummary || 'No specific signals found — use their role and industry context instead.'}

Write a ~100 word cold email body. Reference their specific role and a KPI that matters in ${verticalLabel}. Connect it to how Anyreach improves that KPI.`;

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
          { role: 'system', content: MESSAGE_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error('Perplexity message generation error', {
        contact: `${contact.firstName} ${contact.lastName}`,
        status: res.status,
        error: errText,
      });
      return '';
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || '';
    const content = stripCitations(raw);

    logger.info('Personalized message generated', {
      contact: `${contact.firstName} ${contact.lastName}`,
      company: contact.companyName,
      words: content.split(/\s+/).length,
    });

    return content;
  } catch (err) {
    logger.error('Perplexity message generation error', {
      contact: `${contact.firstName} ${contact.lastName}`,
      error: err.message,
    });
    return '';
  }
}
