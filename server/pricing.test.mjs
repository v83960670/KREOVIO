import test from 'node:test';
import assert from 'node:assert/strict';
import { getPricing } from './pricing.mjs';

test('India plan prices match the brief and disclose unset billing terms', () => {
  const pricing = getPricing('INR');
  assert.equal(pricing.configured, true);
  assert.equal(pricing.billingTermsConfigured, false);
  assert.deepEqual(pricing.plans.map((plan) => [plan.id, plan.price, plan.searches]), [
    ['free', 0, 1],
    ['basic', 9, 20],
    ['pro', 30, 50],
    ['pro-plus', 100, null],
  ]);
});

test('international prices are never silently converted from INR', () => {
  for (const currency of ['USD', 'EUR', 'GBP', 'CAD', 'AUD']) {
    const pricing = getPricing(currency);
    assert.equal(pricing.currency, currency);
    assert.equal(pricing.configured, false);
    assert.deepEqual(pricing.plans, []);
    assert.match(pricing.note, /No exchange-rate conversion/);
  }
});
