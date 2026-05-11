/**
 * Append a landing URL to the message body if it's not already present.
 *
 * Defense-in-depth: the CTA template already includes the URL, but the LLM
 * sometimes paraphrases it away. We re-attach it cleanly so click tracking
 * always has a target.
 *
 * Lives in its own module (rather than enrichment/openai-messages.js) so
 * tests can pull it in without needing OPENAI_API_KEY at import time.
 */
export function ensureLanderUrl(text, landingUrl) {
  if (!text || !landingUrl) return text;
  const host = landingUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (text.toLowerCase().includes(host.toLowerCase())) return text;
  return `${text.trimEnd()} ${landingUrl}`;
}
