function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function requiredString(value, label, maxLength = 180) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw fail('INVALID_PAYMENT_REQUEST', `${label} is required.`);
  }
  return value.trim();
}

/**
 * Provider-agnostic, fail-closed payment boundary. Provider adapters must use an
 * official SDK/API, verify signatures, and retrieve payment state server-side.
 * This repository intentionally registers no provider adapter or checkout route.
 */
export class PaymentService {
  #adapters;
  #allowedReturnHosts;

  constructor(adapters = [], { allowedReturnHosts = ['localhost', '127.0.0.1'] } = {}) {
    this.#adapters = new Map();
    this.#allowedReturnHosts = new Set(allowedReturnHosts.map((host) => String(host).toLowerCase()));
    for (const adapter of adapters) {
      if (!adapter || typeof adapter.provider !== 'string' || !adapter.provider || this.#adapters.has(adapter.provider)) {
        throw fail('INVALID_PAYMENT_ADAPTER', 'Payment adapters must have unique provider IDs.');
      }
      this.#adapters.set(adapter.provider, adapter);
    }
  }

  #adapter(provider) {
    const adapter = this.#adapters.get(provider);
    if (!adapter) throw fail('PAYMENT_PROVIDER_UNAVAILABLE', 'This payment provider is not configured.');
    return adapter;
  }

  async createCheckout({ provider, userId, planId, amountMinor, currency, regionCode, successUrl, cancelUrl, idempotencyKey }) {
    const adapter = this.#adapter(requiredString(provider, 'provider', 40));
    const safeUserId = requiredString(userId, 'userId');
    const safePlanId = requiredString(planId, 'planId', 80);
    const safeSuccessUrl = requiredString(successUrl, 'successUrl', 500);
    const safeCancelUrl = requiredString(cancelUrl, 'cancelUrl', 500);
    const safeKey = requiredString(idempotencyKey, 'idempotencyKey', 160);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw fail('INVALID_AMOUNT', 'Checkout requires a positive server-configured amount.');
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw fail('INVALID_CURRENCY', 'Use a configured ISO 4217 currency.');
    if (regionCode != null && (typeof regionCode !== 'string' || !/^[A-Z]{2}$/.test(regionCode))) throw fail('INVALID_REGION', 'Use a supported billing region.');
    for (const candidate of [safeSuccessUrl, safeCancelUrl]) {
      let url;
      try { url = new URL(candidate); } catch { throw fail('INVALID_RETURN_URL', 'A valid payment return URL is required.'); }
      const localDevelopment = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      const allowedHost = this.#allowedReturnHosts.has(url.host.toLowerCase()) || this.#allowedReturnHosts.has(url.hostname.toLowerCase());
      if (url.username || url.password || (!localDevelopment && (url.protocol !== 'https:' || !allowedHost))) {
        throw fail('INVALID_RETURN_URL', 'Payment return URLs must use a configured HTTPS application host.');
      }
    }
    if (typeof adapter.createCheckout !== 'function') throw fail('PAYMENT_PROVIDER_UNAVAILABLE', 'This provider cannot create checkout sessions.');

    // No PAN, CVV, UPI PIN or provider password enters Kreovio's request contract.
    return adapter.createCheckout({
      userReference: safeUserId,
      planId: safePlanId,
      amountMinor,
      currency,
      regionCode: regionCode ?? null,
      successUrl: safeSuccessUrl,
      cancelUrl: safeCancelUrl,
    }, { idempotencyKey: safeKey });
  }

  async verifyWebhook({ provider, rawBody, signature, headers = {} }) {
    const adapter = this.#adapter(requiredString(provider, 'provider', 40));
    if (!(Buffer.isBuffer(rawBody) || typeof rawBody === 'string')) throw fail('INVALID_WEBHOOK', 'The raw webhook body is required.');
    if (typeof signature !== 'string' || signature.length < 8) throw fail('INVALID_WEBHOOK_SIGNATURE', 'A provider webhook signature is required.');
    if (typeof adapter.verifyWebhookSignature !== 'function') throw fail('PAYMENT_PROVIDER_UNAVAILABLE', 'This provider cannot verify webhook signatures.');
    const event = await adapter.verifyWebhookSignature({ rawBody, signature, headers });
    if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') throw fail('INVALID_WEBHOOK', 'The provider returned an invalid verified event.');
    // Return a minimal event envelope; never pass cardholder or payment-method data through.
    return {
      id: event.id,
      type: event.type,
      paymentId: typeof event.paymentId === 'string' ? event.paymentId : null,
      amountMinor: Number.isSafeInteger(event.amountMinor) ? event.amountMinor : null,
      currency: typeof event.currency === 'string' && /^[A-Z]{3}$/.test(event.currency) ? event.currency : null,
    };
  }

  async verifyPaymentServerSide({ provider, providerPaymentId, expectedAmountMinor, expectedCurrency }) {
    const adapter = this.#adapter(requiredString(provider, 'provider', 40));
    const safePaymentId = requiredString(providerPaymentId, 'providerPaymentId', 240);
    if (!Number.isSafeInteger(expectedAmountMinor) || expectedAmountMinor <= 0) throw fail('INVALID_AMOUNT', 'A server-side expected amount is required.');
    if (typeof expectedCurrency !== 'string' || !/^[A-Z]{3}$/.test(expectedCurrency)) throw fail('INVALID_CURRENCY', 'A server-side expected currency is required.');
    if (typeof adapter.retrievePayment !== 'function') throw fail('PAYMENT_PROVIDER_UNAVAILABLE', 'This provider cannot verify payment status.');

    const payment = await adapter.retrievePayment(safePaymentId);
    if (!payment || payment.id !== safePaymentId || payment.status !== 'succeeded') throw fail('PAYMENT_NOT_SUCCEEDED', 'The provider has not confirmed a successful payment.');
    if (payment.amountMinor !== expectedAmountMinor || payment.currency !== expectedCurrency) throw fail('PAYMENT_AMOUNT_MISMATCH', 'Provider amount or currency does not match the server price.');
    return { id: payment.id, status: 'succeeded', amountMinor: payment.amountMinor, currency: payment.currency, providerReference: payment.reference ?? null };
  }
}
