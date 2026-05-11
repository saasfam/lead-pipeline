import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInboxOrder } from '../services/inbox-orderer.js';

const NO_DEFICIT = {
  totalAccounts: 50,
  warmedAccounts: 50,
  dailyCapacity: 1500,
  deficit: 0,
  isCapacitySufficient: true,
};

const DEFICIT_300 = {
  totalAccounts: 10,
  warmedAccounts: 10,
  dailyCapacity: 300,
  deficit: 300, // 300/day deficit = 10 mailboxes @ 30/day each
  isCapacitySufficient: false,
};

const PREWARMED = [
  { domain: 'leads-anyreach.com', available: true },
  { domain: 'go-anyreach.com', available: true },
  { domain: 'mail-anyreach.com', available: true },
];

test('plan returns empty when capacity is sufficient', () => {
  const plan = planInboxOrder(NO_DEFICIT, PREWARMED, { maxMailboxes: 100 });
  assert.equal(plan.mailboxesNeeded, 0);
  assert.equal(plan.mailboxesPlanned, 0);
  assert.equal(plan.items.length, 0);
});

test('plan stays in plan-only mode when maxMailboxes is 0 (default)', () => {
  const plan = planInboxOrder(DEFICIT_300, PREWARMED);
  assert.equal(plan.mailboxesNeeded, 10);
  assert.equal(plan.mailboxesPlanned, 0); // No order — env not set
  assert.equal(plan.items.length, 0);
  assert.match(plan.reason, /plan-only/);
});

test('plan caps mailboxes to maxMailboxes', () => {
  const plan = planInboxOrder(DEFICIT_300, PREWARMED, { maxMailboxes: 4 });
  assert.equal(plan.mailboxesNeeded, 10);
  assert.equal(plan.mailboxesPlanned, 4); // Capped
  const total = plan.items.reduce((s, it) => s + it.num_accounts, 0);
  assert.equal(total, 4);
});

test('plan distributes mailboxes across multiple domains', () => {
  const plan = planInboxOrder(DEFICIT_300, PREWARMED, {
    maxMailboxes: 9,
    mailboxesPerDomain: 3,
  });
  assert.equal(plan.mailboxesPlanned, 9);
  // 3 domains, 3 each = 9 total
  assert.equal(plan.items.length, 3);
  for (const item of plan.items) {
    assert.equal(item.num_accounts, 3);
  }
});

test('plan handles flat-string prewarmed domain list', () => {
  const flat = ['leads.com', 'go.com'];
  const plan = planInboxOrder(DEFICIT_300, flat, { maxMailboxes: 6 });
  assert.equal(plan.mailboxesPlanned, 6);
  assert.equal(plan.items.length, 2);
});

test('plan reports no-inventory when prewarmed list is empty', () => {
  const plan = planInboxOrder(DEFICIT_300, [], { maxMailboxes: 100 });
  assert.equal(plan.mailboxesPlanned, 0);
  assert.match(plan.reason, /No prewarmed domains/);
});

test('plan respects ABSOLUTE_HARD_CAP (500)', () => {
  const hugeDeficit = { ...DEFICIT_300, deficit: 1000000 };
  const plan = planInboxOrder(hugeDeficit, PREWARMED, { maxMailboxes: 99999 });
  assert.ok(plan.mailboxesPlanned <= 500, `planned=${plan.mailboxesPlanned}`);
});
