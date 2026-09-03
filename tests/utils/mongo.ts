import { MongoClient, Db } from 'mongodb';
import { requireEnv } from './env';

/**
 * Opens a MongoDB connection, runs `fn`, and closes it.
 *
 * Read-only credential — never write through this connection (see CLAUDE.md).
 */
export async function withMongo<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(requireEnv('MONGODB_PRESTAGING_URI'));
  try {
    await client.connect();
    return await fn(client.db());
  } finally {
    await client.close();
  }
}

/** Looks up a user document by email. */
export async function getUserByEmail(email: string) {
  return withMongo((db) => db.collection('users').findOne({ email }));
}

/**
 * Checks specific collections for any document referencing one of
 * `candidateValues` (matched against `user_id`, `userId`, `stripe_id`,
 * `customer`, `provider_id`).
 *
 * Takes an explicit collection list rather than scanning the whole database —
 * a full sweep is too slow and heavy on this shared instance (see CLAUDE.md).
 *
 * @returns Only the collections with at least one match, with their count.
 */
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
