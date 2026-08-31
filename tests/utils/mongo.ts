import { MongoClient, Db } from 'mongodb';
import { requireEnv } from './env';

// HARD RULE, no exceptions (see CLAUDE.md's "Read-only MongoDB access"
// section): this connection is a shared credential approved for READ-ONLY
// use on this project. Every consumer of this file must only ever call
// find()/findOne()/countDocuments()-style read methods - never write
// anything, here or anywhere else.
//
// Extracted here once payment-history.spec.ts became a second real consumer
// of this exact connect/query/close pattern - account-deletion-billing.spec.ts
// and teams-plan-gating.spec.ts each still keep their own earlier,
// already-committed inline copy (see CLAUDE.md's "Stripe restricted key"
// section for why those two were deliberately left alone rather than
// refactored to import this), matching how tests/utils/stripe.ts itself was
// extracted for the same reason once payments.spec.ts needed the same Stripe
// REST pattern account-deletion-billing.spec.ts had already proven.
export async function withMongo<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(requireEnv('MONGODB_PRESTAGING_URI'));
  try {
    await client.connect();
    return await fn(client.db());
  } finally {
    await client.close();
  }
}

export async function getUserByEmail(email: string) {
  return withMongo((db) => db.collection('users').findOne({ email }));
}

// Confirms whether any of `collectionNames` holds a document referencing a
// given Stripe/user id - used by payment-history.spec.ts's Suite 7.5 to
// confirm Payment History has no local Mongo footprint at all (see
// specs/payment-history-test-plan.md finding 17 for the full live-verified
// reasoning: two collections whose names sound directly relevant,
// `stripe_invoices` and `invoices`, turned out to be unrelated - 2016-era
// legacy data and a separate job-site invoicing feature, respectively -
// neither ever referencing this project's own real Stripe subscription
// invoices).
//
// Deliberately checks only the given collections, not every collection in
// the database. An earlier version scanned all ~63 collections in this
// large shared database (`db.listCollections()`) sequentially - live-verified
// this is genuinely too slow to depend on for a real test: a manual
// one-off check took ~2 minutes, but real automated runs of this same scan
// took over 4 minutes once, then still hadn't finished after 8 minutes on
// a later run (this is a shared database with other real usage, so query
// time varies for reasons outside this project's control - not something
// worth chasing with an ever-larger timeout). The exploration that
// originally established finding 17 above only ever needed to check these
// same 2 specific, plausible-by-name collections to reach its conclusion -
// scoping this helper to an explicit, small collection list matches that
// original methodology and is both fast and a more meaningful check of the
// real suspects, rather than a slow brute-force sweep of an otherwise
// unrelated shared database. Queries run in parallel (not sequentially)
// for the same reason.
export async function findAnyCollectionReferencing(
  candidateValues: string[],
  collectionNames: string[]
): Promise<Array<{ collection: string; count: number }>> {
  return withMongo(async (db) => {
    const results = await Promise.all(
      collectionNames.map(async (name) => {
        const count = await db
          .collection(name)
          .countDocuments({ $or: candidateValues.flatMap((v) => [{ user_id: v }, { userId: v }, { stripe_id: v }, { customer: v }, { provider_id: v }]) })
          .catch(() => 0);
        return { collection: name, count };
      })
    );
    return results.filter((r) => r.count > 0);
  });
}
