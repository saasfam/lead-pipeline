import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCampaignBody } from '../export/instantly-campaign.js';

test('buildCampaignBody produces a 4-step draft sequence with placeholders', () => {
  const body = buildCampaignBody({
    name: 'Anyreach - Dental - 2026-05',
    verticalKey: 'dental',
    verticalLabel: 'Dental',
    dailyLimit: 50,
  });

  assert.equal(body.name, 'Anyreach - Dental - 2026-05');
  assert.equal(body.status, 0, 'must be draft, not active');
  assert.equal(body.daily_limit, 50);
  assert.equal(body.tracking_domain, 'anyreach.ai');
  assert.equal(body.open_tracking, true);
  assert.equal(body.link_tracking, true);

  assert.equal(body.sequences.length, 1);
  assert.equal(body.sequences[0].steps.length, 4, 'must be 4-step sequence');

  // Step 1 should reference {{personalized_message}} so each lead's unique
  // body is rendered at send time.
  assert.equal(body.sequences[0].steps[0].step, 1);
  assert.equal(body.sequences[0].steps[0].delay, 0);
  assert.match(body.sequences[0].steps[0].variants[0].body, /personalized_message/);

  // Steps 2-4 should reference their respective custom variables.
  assert.match(body.sequences[0].steps[1].variants[0].body, /sequence_step_2/);
  assert.match(body.sequences[0].steps[2].variants[0].body, /sequence_step_3/);
  assert.match(body.sequences[0].steps[3].variants[0].body, /sequence_step_4/);

  // Delays should mirror the prompt cadence: 0, 3, 5, 7 days.
  assert.deepEqual(
    body.sequences[0].steps.map((s) => s.delay),
    [0, 3, 5, 7]
  );

  // Landing page in the metadata so the campaign is self-documenting.
  assert.equal(body.custom_metadata.vertical, 'dental');
  assert.equal(body.custom_metadata.landing_page, 'https://anyreach.ai/dental');
});

test('buildCampaignBody sets the correct landing page per vertical', () => {
  const dental = buildCampaignBody({
    name: 'x',
    verticalKey: 'dental',
    verticalLabel: 'Dental',
  });
  assert.equal(dental.custom_metadata.landing_page, 'https://anyreach.ai/dental');

  const realestate = buildCampaignBody({
    name: 'x',
    verticalKey: 'realestate',
    verticalLabel: 'Real Estate',
  });
  assert.equal(realestate.custom_metadata.landing_page, 'https://anyreach.ai/real-estate');
});

test('buildCampaignBody subject lines mention the vertical label', () => {
  const body = buildCampaignBody({
    name: 'x',
    verticalKey: 'msp',
    verticalLabel: 'MSP',
  });
  const step1Subjects = body.sequences[0].steps[0].variants.map((v) => v.subject);
  assert.ok(
    step1Subjects.some((s) => s.includes('MSP')),
    `expected MSP in subject variants: ${JSON.stringify(step1Subjects)}`
  );
});
