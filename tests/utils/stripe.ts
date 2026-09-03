import { requireEnv } from './env';

const STRIPE_KEY = requireEnv('STRIPE_TEST_RESTRICTED_KEY');
const STRIPE_API = 'https://api.stripe.com/v1';

/**
 * Signs and sends a request to the Stripe REST API using the restricted test key.
 *
 * @throws If Stripe returns a non-2xx response.
 */
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

/**
 * Finds a Stripe customer by email.
 *
 * @throws If no customer is found.
 */
export async function stripeFindCustomerByEmail(email: string): Promise<string> {
  const result = await stripeRequest('GET', `/customers?email=${encodeURIComponent(email)}&limit=1`);
  if (!result.data?.length) {
    throw new Error(`No Stripe customer found for email ${email}`);
  }
  return result.data[0].id;
}

/** Lists a customer's saved card payment methods. */
export async function stripeListCardPaymentMethods(customerId: string): Promise<Array<{ id: string; card: { last4: string } }>> {
  const result = await stripeRequest('GET', `/payment_methods?customer=${customerId}&type=card&limit=100`);
  return result.data ?? [];
}

/**
 * Finds a customer's most recent subscription, in any status.
 *
 * @throws If no subscription is found.
 */
export async function stripeFindSubscription(customerId: string): Promise<{ id: string; cancelAtPeriodEnd: boolean }> {
  const result = await stripeRequest('GET', `/subscriptions?customer=${customerId}&status=all&limit=1`);
  if (!result.data?.length) {
    throw new Error(`No subscription found for Stripe customer ${customerId}`);
  }
  const sub = result.data[0];
  return { id: sub.id, cancelAtPeriodEnd: sub.cancel_at_period_end };
}
