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
 * REAL FINDING, live-verified 2026-09-08: the plain List endpoint
 * (`GET /v1/customers?email=...`) silently excludes a customer once a Test
 * Clock has ever been attached to it - confirmed by fetching the exact same
 * customer directly by id right after a List-by-email came back empty for
 * it. This broke any re-lookup by email for an account this project's own
 * Test Clock mechanism (see the Stripe Test Clock section in CLAUDE.md) had
 * already touched. Falls back to the Search endpoint (which DOES include
 * time-shifted resources) only when the List lookup finds nothing - zero
 * behavior change for the overwhelming majority of calls, which resolve on
 * the first, cheaper List request exactly as before.
 *
 * @throws If no customer is found via either endpoint.
 */
export async function stripeFindCustomerByEmail(email: string): Promise<string> {
  const result = await stripeRequest('GET', `/customers?email=${encodeURIComponent(email)}&limit=1`);
  if (result.data?.length) {
    return result.data[0].id;
  }

  // Search requires a newer API version than this account's default - pinned via a header, not the account-wide setting.
  const query = encodeURIComponent(`email:'${email.replace(/'/g, "\\'")}'`);
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${STRIPE_KEY}:`).toString('base64')}`,
    'Stripe-Version': '2024-06-20',
  };
  const searchResponse = await fetch(`${STRIPE_API}/customers/search?query=${query}`, { method: 'GET', headers });
  const searchJson = await searchResponse.json();
  if (searchResponse.ok && searchJson.data?.length) {
    return searchJson.data[0].id;
  }

  throw new Error(`No Stripe customer found for email ${email} (checked both List and Search).`);
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

/** Finds a customer's active subscription and its first item's current_period_end - the moment a real Test Clock advance needs to target. */
export async function stripeFindActiveSubscription(customerId: string): Promise<{ id: string; currentPeriodEnd: number }> {
  const result = await stripeRequest('GET', `/subscriptions?customer=${customerId}&status=all&limit=1`);
  if (!result.data?.length) {
    throw new Error(`No subscription found for Stripe customer ${customerId}`);
  }
  const sub = result.data[0];
  const currentPeriodEnd = sub.items?.data?.[0]?.current_period_end;
  if (!currentPeriodEnd) {
    throw new Error(`Subscription ${sub.id} has no current_period_end on its first item: ${JSON.stringify(sub.items)}`);
  }
  return { id: sub.id, currentPeriodEnd };
}

/** Polls a test clock until 'ready', or throws on failure - a full-period advance can take up to roughly a minute. */
export async function pollTestClockUntilReady(clockId: string, maxWaitMs = 120_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const clock = await stripeRequest('GET', `/test_helpers/test_clocks/${clockId}`);
    if (clock.status === 'ready') return clock;
    if (clock.status === 'internal_failure') {
      throw new Error(`Test clock ${clockId} failed: ${JSON.stringify(clock)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`Test clock ${clockId} did not reach 'ready' within ${maxWaitMs}ms`);
}

/**
 * Attaches a real Test Clock to an existing customer and advances it just
 * past a given target timestamp (e.g. a subscription's own
 * current_period_end) - lets a real subscription cross a real billing
 * boundary within a test run's timeframe (see CLAUDE.md). Unlike the
 * cancellation-flow-specific helper duplicated in a few spec files, this
 * one is a plain time-advance with no assumption about what's scheduled to
 * happen at that boundary - a subscription with no pending cancellation
 * genuinely renews when advanced past its period end, exactly like it
 * would in production.
 */
export async function stripeAttachClockAndAdvanceTo(customerId: string, targetUnixSeconds: number, bufferSeconds = 3_600): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const clock = await stripeRequest('POST', '/test_helpers/test_clocks', {
    frozen_time: String(nowSeconds),
    name: 'shared-test-clock',
    customer: customerId,
  });
  await pollTestClockUntilReady(clock.id);

  await stripeRequest('POST', `/test_helpers/test_clocks/${clock.id}/advance`, {
    frozen_time: String(targetUnixSeconds + bufferSeconds),
  });
  await pollTestClockUntilReady(clock.id, 180_000);
}
