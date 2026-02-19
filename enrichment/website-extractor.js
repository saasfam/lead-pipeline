import OpenAI from 'openai';
import { RateLimiter } from '../pipeline/rate-limiter.js';
import { logger } from '../services/logger.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 3 requests per second (shared limit with openai-messages.js if running concurrently)
const extractorLimiter = new RateLimiter(3, 1_000);

const SYSTEM_PROMPT = `You are a data extraction assistant. Given website content from a dental clinic, extract structured information.

Return ONLY valid JSON with these fields:
- staff: array of objects with { name, title, email, phone } for each person found (dentists, hygienists, office managers, assistants). If email/phone is not found for a person, use null.
- companyDescription: 1-2 sentence description of the practice (or null if not determinable)
- specialties: array of strings like "cosmetic", "pediatric", "orthodontics", "implants", "general", "emergency", "sedation" (empty array if none found)
- yearFounded: number or null
- locationCount: number or null

Rules:
- Only extract REAL people names — skip placeholder text, navigation labels, or generic titles without names.
- For titles, use the exact title from the website (e.g., "DDS", "DMD", "Office Manager", "Dental Hygienist").
- If the text is too short or uninformative, return { "staff": [], "companyDescription": null, "specialties": [], "yearFounded": null, "locationCount": null }.
- Return ONLY the JSON object, no markdown fences, no explanation.`;

/**
 * Extract structured data from dental clinic website text using GPT-4o-mini.
 *
 * @param {string} text - Combined page text from the website
 * @param {string} domain - Domain name for logging
 * @returns {object} - { staff, companyDescription, specialties, yearFounded, locationCount }
 */
export async function extractFromWebsite(text, domain) {
  const defaults = {
    staff: [],
    companyDescription: null,
    specialties: [],
    yearFounded: null,
    locationCount: null,
  };

  if (!text || text.length < 100) {
    return defaults;
  }

  if (!process.env.OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY not set — skipping website extraction');
    return defaults;
  }

  await extractorLimiter.acquire();

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Website: ${domain}\n\n${text}` },
      ],
      max_tokens: 1500,
      temperature: 0.1,
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn('GPT returned empty content', { domain });
      return defaults;
    }

    // Parse JSON — strip markdown fences if present
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON object found in GPT response');
      parsed = JSON.parse(match[0]);
    }

    // Normalize staff array
    const staff = Array.isArray(parsed.staff)
      ? parsed.staff
          .filter((s) => s && typeof s.name === 'string' && s.name.trim().length > 1)
          .map((s) => ({
            name: s.name.trim(),
            title: s.title?.trim() || null,
            email: s.email?.trim()?.toLowerCase() || null,
            phone: s.phone?.trim() || null,
          }))
      : [];

    const result = {
      staff,
      companyDescription: typeof parsed.companyDescription === 'string' ? parsed.companyDescription.trim() : null,
      specialties: Array.isArray(parsed.specialties) ? parsed.specialties.map((s) => String(s).trim()) : [],
      yearFounded: typeof parsed.yearFounded === 'number' ? parsed.yearFounded : null,
      locationCount: typeof parsed.locationCount === 'number' ? parsed.locationCount : null,
    };

    logger.debug('Website extraction complete', {
      domain,
      staffCount: result.staff.length,
      specialties: result.specialties.length,
      hasDescription: !!result.companyDescription,
    });

    return result;
  } catch (err) {
    logger.error('Website extraction error', { domain, error: err.message });
    return defaults;
  }
}
