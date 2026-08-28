import { requireEnv } from './env';

const STRIPE_KEY = requireEnv('STRIPE_TEST_RESTRICTED_KEY');
const STRIPE_API = 'https://api.stripe.com/v1';

// Same pattern already proven in teams-plan-gating.spec.ts and
// account-deletion-billing.spec.ts, extracted here so a third/fourth
// consumer (payments.spec.ts, subscription.spec.ts) doesn't need its own
// copy. Read-only or test-mode-only calls throughout this project - see
// CLAUDE.md's "Stripe restricted key" section for this key's exact scope.
export async function stripeRequest(method: 'GET' | 'POST', path: string, body?: Record<string, string>) {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${STRIPE_KEY}:`).toString('base64')}`,
  };
  let requestBody: string | undefined;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    requestBody = new URLSearchParams(body).toString();
  }
  const response = await fetch(`${STRIPE_API}${path}`, { method, headers, body: requestBody });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Stripe API ${method} ${path} failed (${response.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

export async function stripeFindCustomerByEmail(email: string): Promise<string> {
  const result = await stripeRequest('GET', `/customers?email=${encodeURIComponent(email)}&limit=1`);
  if (!result.data?.length) {
    throw new Error(`No Stripe customer found for email ${email}`);
  }
  return result.data[0].id;
}

export async function stripeListCardPaymentMethods(customerId: string): Promise<Array<{ id: string; card: { last4: string } }>> {
  const result = await stripeRequest('GET', `/payment_methods?customer=${customerId}&type=card&limit=100`);
  return result.data ?? [];
}

export async function stripeFindSubscription(customerId: string): Promise<{ id: string; cancelAtPeriodEnd: boolean }> {
  const result = await stripeRequest('GET', `/subscriptions?customer=${customerId}&status=all&limit=1`);
  if (!result.data?.length) {
    throw new Error(`No subscription found for Stripe customer ${customerId}`);
  }
  const sub = result.data[0];
  return { id: sub.id, cancelAtPeriodEnd: sub.cancel_at_period_end };
}
