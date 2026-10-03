import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentService } from './payment-service.mjs';

const checkoutInput = {
  provider: 'example', userId: 'user-1', planId: 'pro', amountMinor: 3000,
  currency: 'INR', regionCode: 'IN', successUrl: 'https://app.kreovio.test/success',
  cancelUrl: 'https://app.kreovio.test/cancel', idempotencyKey: 'checkout-idempotency-001',
};

test('payment boundary fails closed if no provider is configured', async () => {
  const payments = new PaymentService();
  await assert.rejects(payments.createCheckout(checkoutInput), { code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
});

test('checkout uses configured price, idempotency, and allowlisted HTTPS return hosts', async () => {
  let received;
  const adapter = {
    provider: 'example',
    createCheckout: async (details, options) => { received = { details, options }; return { checkoutUrl: 'https://checkout.example.test/session' }; },
  };
  const payments = new PaymentService([adapter], { allowedReturnHosts: ['app.kreovio.test'] });
  const checkout = await payments.createCheckout(checkoutInput);
  assert.equal(checkout.checkoutUrl, 'https://checkout.example.test/session');
  assert.equal(received.details.amountMinor, 3000);
  assert.equal(received.details.currency, 'INR');
  assert.equal(received.options.idempotencyKey, checkoutInput.idempotencyKey);
  await assert.rejects(payments.createCheckout({ ...checkoutInput, successUrl: 'https://untrusted.test/return' }), { code: 'INVALID_RETURN_URL' });
});

test('webhook requires signature and exposes only a minimal verified envelope', async () => {
  const payments = new PaymentService([{
    provider: 'example',
    verifyWebhookSignature: async ({ signature }) => {
      assert.equal(signature, 'valid-test-signature');
      return { id: 'evt-1', type: 'payment.succeeded', paymentId: 'pay-1', amountMinor: 3000, currency: 'INR', cardNumber: 'must-not-pass-through' };
    },
  }]);
  await assert.rejects(payments.verifyWebhook({ provider: 'example', rawBody: '{}', signature: '' }), { code: 'INVALID_WEBHOOK_SIGNATURE' });
  const event = await payments.verifyWebhook({ provider: 'example', rawBody: '{}', signature: 'valid-test-signature' });
  assert.deepEqual(event, { id: 'evt-1', type: 'payment.succeeded', paymentId: 'pay-1', amountMinor: 3000, currency: 'INR' });
});

test('payment is checked against provider state, exact server price and currency', async () => {
  const payments = new PaymentService([{
    provider: 'example',
    retrievePayment: async (id) => ({ id, status: 'succeeded', amountMinor: 3000, currency: 'INR', reference: 'ref-1' }),
  }]);
  const verified = await payments.verifyPaymentServerSide({ provider: 'example', providerPaymentId: 'pay-1', expectedAmountMinor: 3000, expectedCurrency: 'INR' });
  assert.deepEqual(verified, { id: 'pay-1', status: 'succeeded', amountMinor: 3000, currency: 'INR', providerReference: 'ref-1' });
  await assert.rejects(payments.verifyPaymentServerSide({ provider: 'example', providerPaymentId: 'pay-1', expectedAmountMinor: 900, expectedCurrency: 'INR' }), { code: 'PAYMENT_AMOUNT_MISMATCH' });
});
