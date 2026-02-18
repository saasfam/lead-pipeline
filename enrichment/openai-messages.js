import OpenAI from 'openai';
import { RateLimiter } from '../pipeline/rate-limiter.js';
import { logger } from '../services/logger.js';
import { getVerticalKpis, VERTICAL_INDUSTRY_MAP } from '../config/vertical-kpis.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 3 requests per second (GPT-4o-mini supports 500 RPM)
const openaiLimiter = new RateLimiter(3, 1_000);

const BANNED_PHRASES = [
  'laser-focused',
  'laser focused',
  "you're likely",
  'you are likely',
  'worth a quick chat',
  'no doubt',
  "in today's competitive",
  "in today's fast-paced",
  "in today's rapidly",
  'ever-evolving',
  'cutting-edge',
  'game-changer',
  'game changer',
  'leverage',
  'synergy',
  'revolutionize',
  'transform the way',
];

// ── Structure-specific system prompts ────────────────────────────────────────

function buildSystemPrompt(variety) {
  const base = `You are writing a cold email body for an SDR at Anyreach, an AI-powered voice agent platform.

ABSOLUTE RULES (violations = rejection):
- Do NOT start any sentence with "I noticed" or "I came across" or "I saw that"
- Do NOT use markdown — no **bold**, no *italics*, no bullet points, no numbered lists
- Do NOT include a subject line, greeting (Hi/Hey Name), or sign-off (Best, Cheers, etc.)
- Do NOT use any of these filler phrases: "no doubt", "in today's competitive", "ever-evolving", "cutting-edge", "game-changer", "leverage", "synergy", "revolutionize", "transform the way"
- You MUST mention the company name at least once in the message body
- Write in plain text only. Return ONLY the message body.`;

  if (variety.structure.id === 1) {
    return `${base}

STRUCTURE: Hook → Pain → Solution → CTA
1. Open with a ${variety.openerType} opener (see user instructions for details)
2. Identify a specific pain point for their role/industry
3. Present Anyreach's solution tied to a measurable outcome
4. End with the EXACT CTA provided in user instructions
${variety.mentionBrand ? '- Mention "Anyreach" by name once.' : '- Do NOT mention "Anyreach" by name — describe the solution generically (e.g., "we built an AI voice agent that...")'}
- Target length: ${variety.targetChars.min}-${variety.targetChars.max} characters`;
  }

  if (variety.structure.id === 2) {
    return `${base}

STRUCTURE: Pain → Proof point → Offer → CTA
1. Lead with the industry problem statement — make it specific to their vertical
2. Cite one specific result or proof point (stat, percentage, outcome)
3. Brief offer to share more
4. End with the EXACT CTA provided in user instructions
${variety.mentionBrand ? '- Mention "Anyreach" by name once.' : '- Do NOT mention "Anyreach" by name — describe the solution generically.'}
- Target length: ${variety.targetChars.min}-${variety.targetChars.max} characters (80-100 words)`;
  }

  // Structure 3: Observation → Question (ultra-short)
  return `${base}

STRUCTURE: Short observation + question (2-3 sentences ONLY)
1. Reference one specific thing about their company (from the data provided)
2. End with a question about their challenge — genuinely curious tone
3. That's it. NO product pitch. NO statistics. NO features.
${variety.mentionBrand ? '' : '- Do NOT mention "Anyreach" at all.'}
- Target length: ${variety.targetChars.min}-${variety.targetChars.max} characters (40-60 words)
- This should read like a peer asking a question, not a sales pitch`;
}

// ── Opener type instructions ─────────────────────────────────────────────────

function getOpenerInstruction(openerType, contact, signals) {
  switch (openerType) {
    case 'news-reference': {
      const news = signals.recentNews || signals.recentFunding || '';
      return `Start by referencing this company news/funding as a direct statement (NOT "I noticed"): "${news.slice(0, 200)}"`;
    }
    case 'growth-observation': {
      const growth = signals.growthSignal || signals.hiringSignal || '';
      return `Start by referencing their growth/hiring pattern as a statement: "${growth.slice(0, 200)}"`;
    }
    case 'hook-lead':
      return `Start with this hook (rewrite naturally, don't copy verbatim): "${(signals.personalizedHook || '').slice(0, 200)}"`;
    case 'pain-point-direct':
      return `Start directly with a pain point specific to ${contact.verticalLabel || 'their industry'} — no preamble, no "I noticed", just state the problem.`;
    case 'role-empathy': {
      const size = contact.companyEmployees ? `${contact.companyEmployees}-person` : '';
      return `Start with role empathy: "Running ${contact.title ? contact.title.split(/[,\/]/)[0].trim() : 'operations'} at a ${size} company means..." (adapt naturally)`;
    }
    case 'milestone': {
      const founded = contact.companyFounded || '';
      const years = founded ? new Date().getFullYear() - parseInt(founded, 10) : '';
      return years
        ? `Start by referencing their company's longevity: "After ${years} years in ${contact.verticalLabel || 'the industry'}..." (adapt naturally)`
        : `Start with a role-specific observation about ${contact.companyName}.`;
    }
    case 'industry-trend':
      return `Start with a broader industry trend relevant to ${contact.verticalLabel || 'their space'} — something happening market-wide that affects companies like ${contact.companyName}.`;
    case 'question-lead':
      return `Start with a direct question about a challenge common in ${contact.verticalLabel || 'their industry'} for someone in a ${contact.title || 'leadership'} role.`;
    default:
      return `Start with a specific, relevant observation about ${contact.companyName}. Do NOT use "I noticed".`;
  }
}

// ── User prompt builder ──────────────────────────────────────────────────────

function buildUserPrompt(contact, signals, variety) {
  const verticalKey = contact.verticalKey || '';
  const verticalLabel = contact.verticalLabel || 'their industry';
  const companySize = contact.companyEmployees || 'unknown';

  const signalLines = Object.entries(signals)
    .filter(([k, v]) => v && v !== 'None found' && k !== 'personalizedHook')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  let industryBlock = '';
  const kpiContext = getVerticalKpis(verticalKey);
  if (kpiContext && variety.structure.id !== 3) {
    industryBlock = `
Industry pain points: ${kpiContext.painPoints}
Key KPIs: ${kpiContext.kpis}
How Anyreach helps: ${kpiContext.anyreachValue}`;
  }

  const openerInstruction = getOpenerInstruction(variety.openerType, contact, signals);

  const ctaInstruction = variety.structure.id === 3
    ? ''
    : `\nEND with exactly this CTA: "${variety.cta.replace('[vertical]', verticalLabel)}"`;

  const brandInstruction = variety.mentionBrand
    ? '\nMention "Anyreach" by name exactly once.'
    : '\nDo NOT mention "Anyreach" by name. Describe the solution generically.';

  return `Contact: ${contact.firstName} ${contact.lastName}, ${contact.title} at ${contact.companyName} (${contact.companyDomain})
Industry: ${verticalLabel} | Apollo industry: ${contact.companyIndustry || 'unknown'} | Size: ${companySize} employees
${industryBlock}

Company signals:
${signalLines || 'No specific signals — use their role and industry context.'}

OPENER: ${openerInstruction}
${ctaInstruction}
${brandInstruction}
REQUIRED: You MUST mention "${contact.companyName}" by name in the message.
Target: ${variety.targetChars.min}-${variety.targetChars.max} characters.

Write the message now.`;
}

// ── Post-processing ──────────────────────────────────────────────────────────

/**
 * Check if a vertical assignment is a mismatch with the company's actual industry.
 */
export function detectVerticalMismatch(verticalKey, companyIndustry) {
  if (!verticalKey || !companyIndustry) return false;

  const expectedIndustries = VERTICAL_INDUSTRY_MAP[verticalKey];
  if (!expectedIndustries) return false;

  const industryLower = companyIndustry.toLowerCase();
  return !expectedIndustries.some((tag) => industryLower.includes(tag));
}

/**
 * Post-process a generated message: strip formatting, ban phrases, validate quality.
 * Returns { cleaned, flags[] }.
 */
export function postProcessMessage(text, contact) {
  if (!text) return { cleaned: '', flags: ['empty-response'] };

  let cleaned = text;
  const flags = [];

  // Strip markdown bold / italics
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*(.*?)\*/g, '$1');
  // Strip citation markers [1], [2], etc.
  cleaned = cleaned.replace(/\[\d+\]/g, '');
  // Strip bullet points at line start
  cleaned = cleaned.replace(/^[\s]*[-•]\s*/gm, '');

  // Ban "I noticed" / "I came across" / "I saw that" at sentence start
  cleaned = cleaned.replace(/(^|\.\s+)I (noticed|came across|saw that|recently noticed|recently came across)\b[^.?!]*[.?!]?\s*/gi, '');
  if (/\bI noticed\b/i.test(text)) flags.push('had-i-noticed');

  // Remove banned phrases (case-insensitive)
  for (const phrase of BANNED_PHRASES) {
    const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (regex.test(cleaned)) flags.push('had-banned-phrase');
    cleaned = cleaned.replace(regex, '');
  }

  // Strip sign-offs
  cleaned = cleaned.replace(/\n\s*(Best|Cheers|Regards|Thanks|Warm regards|Looking forward)[,]?\s*$/i, '');

  // Strip greeting if it snuck in
  cleaned = cleaned.replace(/^(Hi|Hey|Hello|Dear)\s+\w+[,!]?\s*/i, '');

  // Validate company name appears (if we have a company name)
  if (contact && contact.companyName && contact.companyName.length > 2) {
    const companyLower = contact.companyName.toLowerCase();
    if (!cleaned.toLowerCase().includes(companyLower)) {
      flags.push('no-company-name');
    }
  }

  // Detect "as [Title], focused on" grammar pattern
  if (/\bas\s+[A-Z][^,]*,\s*focused on/i.test(cleaned)) {
    flags.push('grammar-issue');
  }

  // Collapse extra whitespace
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  // Enforce character cap — 550 soft warn, 800 hard cut
  if (cleaned.length > 800) {
    const truncated = cleaned.slice(0, 800);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastQuestion = truncated.lastIndexOf('?');
    const cutPoint = Math.max(lastPeriod, lastQuestion);
    cleaned = cutPoint > 400 ? truncated.slice(0, cutPoint + 1) : truncated.slice(0, 797) + '...';
  }

  if (cleaned.length > 550) flags.push('over-550-chars');
  if (cleaned.length < 100 && cleaned.length > 0) flags.push('under-100-chars');

  return { cleaned, flags };
}

// ── Fallback hook generation ─────────────────────────────────────────────────

/**
 * Generate a deterministic fallback hook for leads with empty/bad personalizedHook.
 */
export function generateFallbackHook(contact) {
  const company = contact.companyName || 'your company';
  const employees = parseInt(contact.companyEmployees, 10);
  const revenue = contact.companyRevenue || '';
  const founded = contact.companyFounded ? String(contact.companyFounded).trim() : '';
  const title = contact.title || '';
  const vertical = contact.verticalLabel || 'your industry';

  if (employees > 0 && revenue) {
    return `${company}'s ${employees}-person team`;
  }

  if (founded && /^\d{4}$/.test(founded)) {
    const years = new Date().getFullYear() - parseInt(founded, 10);
    if (years > 0) return `After ${years} years in ${vertical}`;
  }

  if (title) {
    const shortTitle = title.split(/[,\/]/)[0].trim();
    return `As ${shortTitle} at ${company}`;
  }

  return `${company} in ${vertical}`;
}

// ── Main generation function ─────────────────────────────────────────────────

/**
 * Generate a personalized cold email message using GPT-4o-mini.
 *
 * @param {object} contact - Contact fields
 * @param {object} signals - Company signals
 * @param {object} variety - From assignVariety(): { structure, openerType, cta, mentionBrand, targetChars }
 * @returns {{ message: string, flags: string[], messageStructure: number }}
 */
export async function generatePersonalizedMessage(contact, signals, variety) {
  await openaiLimiter.acquire();

  if (!process.env.OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY not set');
    return { message: '', flags: ['missing-api-key'], messageStructure: variety?.structure?.id || 0 };
  }

  const systemPrompt = buildSystemPrompt(variety);
  const userPrompt = buildUserPrompt(contact, signals, variety);

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 400,
      temperature: 0.8,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || '';
    const { cleaned, flags } = postProcessMessage(raw, contact);

    logger.info('Message generated (GPT-4o-mini)', {
      contact: `${contact.firstName} ${contact.lastName}`,
      company: contact.companyName,
      chars: cleaned.length,
      structure: variety.structure.name,
      opener: variety.openerType,
      flags: flags.length ? flags.join(',') : 'clean',
    });

    return { message: cleaned, flags, messageStructure: variety.structure.id };
  } catch (err) {
    logger.error('OpenAI message generation error', {
      contact: `${contact.firstName} ${contact.lastName}`,
      error: err.message,
    });
    return { message: '', flags: ['api-error'], messageStructure: variety.structure.id };
  }
}

// ── Sequence generation (4-step value ladder) ────────────────────────────────

// Step-specific char limits: { soft, hard }
const STEP_CHAR_LIMITS = {
  2: { soft: 300, hard: 400 },
  3: { soft: 300, hard: 400 },
  4: { soft: 200, hard: 250 },
};

/**
 * Build system prompt for 4-step sequence generation with JSON output.
 */
function buildSequenceSystemPrompt(variety) {
  const base = `You are writing a 4-step cold email sequence for an SDR at Anyreach, an AI-powered voice agent platform.

ABSOLUTE RULES (apply to ALL steps):
- Do NOT start any sentence with "I noticed" or "I came across" or "I saw that"
- Do NOT use markdown — no **bold**, no *italics*, no bullet points, no numbered lists
- Do NOT include subject lines, greetings (Hi/Hey Name), or sign-offs (Best, Cheers, etc.) in ANY step
- Do NOT use filler phrases: "no doubt", "in today's competitive", "ever-evolving", "cutting-edge", "game-changer", "leverage", "synergy", "revolutionize", "transform the way"
- Plain text only for every step

OUTPUT FORMAT: Return valid JSON with exactly these keys: "step_1", "step_2", "step_3", "step_4"
Each value is the plain-text email body for that step. No extra keys.`;

  let step1Instructions;
  if (variety.structure.id === 1) {
    step1Instructions = `STEP 1 — Initial outreach (Hook → Pain → Solution → CTA):
- Open with a ${variety.openerType} opener (see user instructions)
- Identify a specific pain point for their role/industry
- Present Anyreach's solution tied to a measurable outcome
- End with the EXACT CTA provided in user instructions
${variety.mentionBrand ? '- Mention "Anyreach" by name once.' : '- Do NOT mention "Anyreach" by name — describe the solution generically (e.g., "we built an AI voice agent that...")'}
- You MUST mention the company name at least once
- Target: ${variety.targetChars.min}-${variety.targetChars.max} characters`;
  } else if (variety.structure.id === 2) {
    step1Instructions = `STEP 1 — Initial outreach (Pain → Proof point → Offer → CTA):
- Lead with the industry problem — specific to their vertical
- Cite one specific result or proof point (stat, percentage, outcome)
- Brief offer to share more
- End with the EXACT CTA provided in user instructions
${variety.mentionBrand ? '- Mention "Anyreach" by name once.' : '- Do NOT mention "Anyreach" by name — describe the solution generically.'}
- You MUST mention the company name at least once
- Target: ${variety.targetChars.min}-${variety.targetChars.max} characters`;
  } else {
    step1Instructions = `STEP 1 — Initial outreach (Observation + Question, 2-3 sentences ONLY):
- Reference one specific thing about their company
- End with a question about their challenge — genuinely curious tone
- NO product pitch, NO statistics, NO features
${variety.mentionBrand ? '' : '- Do NOT mention "Anyreach" at all.'}
- You MUST mention the company name at least once
- Target: ${variety.targetChars.min}-${variety.targetChars.max} characters`;
  }

  return `${base}

${step1Instructions}

STEP 2 — Value-add follow-up (sent ~3 days after step 1):
- Assume they saw step 1 but didn't reply. Do NOT repeat step 1 content.
- Share a specific result, stat, or social proof relevant to their vertical.
- Use the industry KPI data / Anyreach value props as source material.
- 2-3 sentences. Target: 150-300 characters.
- End with a low-commitment CTA different from step 1's CTA.

STEP 3 — Case study / credibility (sent ~5 days after step 2):
- Brief reference to a result for a similar company in their vertical.
- Pattern: "A [vertical] company achieved [specific metric]" — adapt naturally.
- 2-3 sentences. Target: 150-300 characters.
- Different CTA from step 1 and step 2.

STEP 4 — Breakup (sent ~7 days after step 3):
- Ultra-short. 1-2 sentences max. Target: 80-200 characters.
- Tone: respectful close-the-loop. "Last note on this" energy.
- Leave the door open without being pushy.
- No product pitch, no stats, no features.`;
}

/**
 * Post-process a follow-up sequence step with step-specific char limits.
 * Reuses core postProcessMessage logic but relaxes company name check for steps 2-4.
 */
function postProcessSequenceStep(text, stepNum, contact) {
  if (!text) return { cleaned: '', flags: [`step${stepNum}:empty`] };

  // Run core post-processing (strips markdown, banned phrases, greetings, etc.)
  const { cleaned: base, flags: baseFlags } = postProcessMessage(text, null);

  // Prefix flags with step number
  const flags = baseFlags
    .filter((f) => f !== 'no-company-name') // Don't require company name in follow-ups
    .map((f) => `step${stepNum}:${f}`);

  let cleaned = base;

  // Apply step-specific char limits
  const limits = STEP_CHAR_LIMITS[stepNum];
  if (limits && cleaned.length > limits.hard) {
    const truncated = cleaned.slice(0, limits.hard);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastQuestion = truncated.lastIndexOf('?');
    const cutPoint = Math.max(lastPeriod, lastQuestion);
    cleaned = cutPoint > limits.hard * 0.5
      ? truncated.slice(0, cutPoint + 1)
      : truncated.slice(0, limits.hard - 3) + '...';
  }

  if (limits && cleaned.length > limits.soft) {
    flags.push(`step${stepNum}:over-${limits.soft}-chars`);
  }

  return { cleaned, flags };
}

/**
 * Generate a 4-step cold email sequence using a single GPT-4o-mini call.
 *
 * @param {object} contact - Contact fields
 * @param {object} signals - Company signals
 * @param {object} variety - From assignVariety()
 * @returns {{ message: string, sequenceStep2: string, sequenceStep3: string, sequenceStep4: string, flags: string[], messageStructure: number }}
 */
export async function generateSequence(contact, signals, variety) {
  await openaiLimiter.acquire();

  const emptyResult = {
    message: '',
    sequenceStep2: '',
    sequenceStep3: '',
    sequenceStep4: '',
    flags: ['missing-api-key'],
    messageStructure: variety?.structure?.id || 0,
  };

  if (!process.env.OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY not set');
    return emptyResult;
  }

  const systemPrompt = buildSequenceSystemPrompt(variety);
  const baseUserPrompt = buildUserPrompt(contact, signals, variety);
  // Override the "Write the message now." ending to request all 4 steps as JSON
  const userPrompt = baseUserPrompt.replace(
    /Write the message now\.$/,
    'Write all 4 sequence steps as JSON now: {"step_1": "...", "step_2": "...", "step_3": "...", "step_4": "..."}'
  );

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1200,
      temperature: 0.8,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || '';

    // Parse JSON response
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // JSON parse failed — fall back to treating entire response as step 1
      logger.warn('Sequence JSON parse failed, falling back to single message', {
        contact: contact.companyName,
        rawLength: raw.length,
      });
      const { cleaned, flags } = postProcessMessage(raw, contact);
      flags.push('sequence-parse-error');
      return {
        message: cleaned,
        sequenceStep2: '',
        sequenceStep3: '',
        sequenceStep4: '',
        flags,
        messageStructure: variety.structure.id,
      };
    }

    // Process each step
    const step1Result = postProcessMessage(parsed.step_1 || '', contact);
    const step2Result = postProcessSequenceStep(parsed.step_2 || '', 2, contact);
    const step3Result = postProcessSequenceStep(parsed.step_3 || '', 3, contact);
    const step4Result = postProcessSequenceStep(parsed.step_4 || '', 4, contact);

    // Combine flags: step 1 flags unprefixed, steps 2-4 prefixed
    const allFlags = [
      ...step1Result.flags,
      ...step2Result.flags,
      ...step3Result.flags,
      ...step4Result.flags,
    ];

    logger.info('Sequence generated (GPT-4o-mini)', {
      contact: `${contact.firstName} ${contact.lastName}`,
      company: contact.companyName,
      step1Chars: step1Result.cleaned.length,
      step2Chars: step2Result.cleaned.length,
      step3Chars: step3Result.cleaned.length,
      step4Chars: step4Result.cleaned.length,
      structure: variety.structure.name,
      flags: allFlags.length ? allFlags.join(',') : 'clean',
    });

    return {
      message: step1Result.cleaned,
      sequenceStep2: step2Result.cleaned,
      sequenceStep3: step3Result.cleaned,
      sequenceStep4: step4Result.cleaned,
      flags: allFlags,
      messageStructure: variety.structure.id,
    };
  } catch (err) {
    logger.error('OpenAI sequence generation error', {
      contact: `${contact.firstName} ${contact.lastName}`,
      error: err.message,
    });
    return { ...emptyResult, flags: ['api-error'] };
  }
}
