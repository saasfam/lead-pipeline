/**
 * Deterministic message variety system.
 *
 * The LLM gravitates to patterns ("I noticed…" openers, identical CTAs).
 * This module assigns each lead a structure, opener type, CTA, and brand-mention
 * toggle BEFORE the API call, then passes them as explicit instructions.
 */

export const OPENER_TYPES = [
  'news-reference',      // Lead with specific news/funding as a statement
  'growth-observation',  // Reference growth/hiring pattern
  'hook-lead',           // Use personalizedHook as opener
  'pain-point-direct',   // Direct vertical pain point, no preamble
  'role-empathy',        // "Running [function] at a [size] company means..."
  'milestone',           // Company age/founding year observation
  'industry-trend',      // Broader industry trend relevant to their vertical
  'question-lead',       // Open with a question about their challenge
];

export const CTA_POOL = [
  'Open to a 10-min call this week?',
  'Happy to share how a similar [vertical] company handled this — want the details?',
  'Want me to send over a quick case study?',
  'If this is on your radar, I\'d love to walk you through it.',
  'Would a short demo make sense?',
  'Should I send over the ROI breakdown?',
  'Interested in seeing how this works in practice?',
  'Worth a quick conversation?',
];

export const MESSAGE_STRUCTURES = [
  { id: 1, name: 'hook-pain-solution', weight: 0.4, desc: 'Hook → Pain → Solution → CTA' },
  { id: 2, name: 'pain-proof-offer',   weight: 0.3, desc: 'Pain → Proof point → Offer → CTA' },
  { id: 3, name: 'observation-question', weight: 0.3, desc: 'Short 2-3 sentences, ends with question, no pitch' },
];

/**
 * Deterministically assign variety parameters to a lead.
 *
 * @param {object} lead   - Lead row (with signals, vertical, etc.)
 * @param {number} index  - Position in the batch (0-based)
 * @param {number} total  - Total non-skipped leads in this batch
 * @returns {{ structure: object, openerType: string, cta: string, mentionBrand: boolean, targetChars: { min: number, max: number } }}
 */
export function assignVariety(lead, index, total) {
  // --- Structure: weighted round-robin (40/30/30) ---
  const structureBucket = index % 10;
  let structure;
  if (structureBucket < 4) {
    structure = MESSAGE_STRUCTURES[0]; // hook-pain-solution  (0-3 → 40%)
  } else if (structureBucket < 7) {
    structure = MESSAGE_STRUCTURES[1]; // pain-proof-offer    (4-6 → 30%)
  } else {
    structure = MESSAGE_STRUCTURES[2]; // observation-question (7-9 → 30%)
  }

  // --- Opener type: data-driven selection ---
  const openerType = pickOpenerType(lead, index);

  // --- CTA: round-robin across pool (max ~12.5% each with 8 CTAs) ---
  const cta = CTA_POOL[index % CTA_POOL.length];

  // --- Brand mention: alternating (~50%) ---
  const mentionBrand = index % 2 === 0;

  // --- Target character range ---
  const targetChars = structure.id === 3
    ? { min: 200, max: 350 }
    : { min: 350, max: 500 };

  return { structure, openerType, cta, mentionBrand, targetChars };
}

/**
 * Pick opener type using index-based rotation across AVAILABLE data.
 * Builds a pool of eligible openers for this lead, then rotates by index.
 * This prevents any single opener from dominating even when most leads have news.
 */
function pickOpenerType(lead, index) {
  const hasNews = lead.recentNews && lead.recentNews !== 'None found' && lead.recentNews.length > 10;
  const hasFunding = lead.recentFunding && lead.recentFunding !== 'None found' && lead.recentFunding.length > 10;
  const hasGrowth = lead.growthSignal && lead.growthSignal !== 'None found' && lead.growthSignal.length > 10;
  const hasHiring = lead.hiringSignal && lead.hiringSignal !== 'None found' && lead.hiringSignal.length > 10;
  const hasHook = lead.personalizedHook && lead.personalizedHook !== 'None found' && lead.personalizedHook.length > 10;
  const hasFounded = lead.companyFounded && /^\d{4}$/.test(String(lead.companyFounded).trim());
  const hasEmployees = lead.companyEmployees && parseInt(lead.companyEmployees, 10) > 0;

  // Build pool of eligible openers for this lead (data-driven + always-available)
  const eligible = [];
  if (hasNews || hasFunding) eligible.push('news-reference');
  if (hasGrowth || hasHiring) eligible.push('growth-observation');
  if (hasHook) eligible.push('hook-lead');
  if (hasFounded) eligible.push('milestone');
  if (hasEmployees) eligible.push('role-empathy');

  // Always-available openers (no data required)
  eligible.push('pain-point-direct', 'question-lead', 'industry-trend');

  // Rotate across the eligible pool by index — ensures distribution even when
  // most leads have the same signals
  return eligible[index % eligible.length];
}
