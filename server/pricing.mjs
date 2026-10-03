const inrPlans = [
  { id: 'free', name: 'Free', price: 0, searches: 1, unit: 'one-time search', description: 'A complete first look at trend intelligence.' },
  { id: 'basic', name: 'Basic', price: 9, searches: 20, unit: 'searches', description: 'A little more room to explore.' },
  { id: 'pro', name: 'Pro', price: 30, searches: 50, unit: 'searches', description: 'For a steady rhythm of discovery.', featured: true },
  { id: 'pro-plus', name: 'Pro Plus', price: 100, searches: null, unit: 'fair-use unlimited', description: 'For teams who keep a close watch.' },
];

const supported = new Set(['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD']);

/**
 * Preview configuration only. Production deployments should source plan amounts,
 * regional price overrides, and billing terms from protected admin_settings records.
 * Never use these values as a payment quote without server-side provider validation.
 */
export function getPricing(currency = 'INR') {
  const requested = String(currency).toUpperCase();
  if (!supported.has(requested)) {
    return { currency: requested, configured: false, plans: [], note: 'This currency is not currently supported.' };
  }
  if (requested !== 'INR') {
    return {
      currency: requested,
      configured: false,
      plans: [],
      note: 'Regional prices have not been configured for this currency. No exchange-rate conversion is shown.',
    };
  }
  return {
    currency: 'INR',
    configured: true,
    billingTermsConfigured: false,
    plans: inrPlans,
    note: 'Preview pricing from the product brief. Billing cadence, taxes, checkout, and renewals are not configured.',
  };
}
