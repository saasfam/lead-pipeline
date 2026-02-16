import Browserbase from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import robotsParser from 'robots-parser';
import { logger } from '../services/logger.js';

const API_KEY = process.env.BROWSERBASE_API_KEY;
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

let bbClient = null;

function getClient() {
  if (!bbClient) {
    bbClient = new Browserbase({ apiKey: API_KEY });
  }
  return bbClient;
}

/**
 * Create a Browserbase session and connect Playwright.
 * Returns { browser, page, sessionId, close }.
 */
export async function createSession() {
  const bb = getClient();

  const session = await bb.sessions.create({
    projectId: PROJECT_ID,
    browserSettings: {
      viewport: { width: 1280, height: 800 },
    },
  });

  logger.info('Browserbase session created', { sessionId: session.id });

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  return {
    browser,
    page,
    sessionId: session.id,
    close: async () => {
      try {
        await browser.close();
        logger.info('Browserbase session closed', { sessionId: session.id });
      } catch (err) {
        logger.warn('Error closing browser session', { error: err.message });
      }
    },
  };
}

/**
 * Check if robots.txt allows scraping a URL.
 */
export async function isAllowedByRobots(url) {
  try {
    const origin = new URL(url).origin;
    const robotsUrl = `${origin}/robots.txt`;
    const res = await fetch(robotsUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return true; // No robots.txt = allowed
    const text = await res.text();
    const robots = robotsParser(robotsUrl, text);
    return robots.isAllowed(url, 'Anyreach-Bot') !== false;
  } catch {
    return true; // On error, assume allowed
  }
}

/**
 * Random delay between min and max milliseconds.
 */
export function randomDelay(minMs = 2000, maxMs = 5000) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Auto-scroll a page to load lazy content.
 * Scrolls down in increments until no new content loads or maxScrolls reached.
 */
export async function autoScroll(page, maxScrolls = 20) {
  let previousHeight = 0;
  let scrollCount = 0;

  while (scrollCount < maxScrolls) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) break;
    previousHeight = currentHeight;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    scrollCount++;
  }

  return scrollCount;
}
