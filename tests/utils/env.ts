/**
 * Reads a required environment variable.
 *
 * @throws If `name` is not set in `.env`.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Did you copy .env.example to .env?`);
  }
  return value;
}

/**
 * The shared seed account's own email address.
 *
 * `TEST_SEED_EMAIL` wins when set; otherwise this falls back to the original
 * `<TEST_EMAIL_USER>+automation<TEST_EMAIL_DOMAIN>` derivation, so `.env` and
 * CI keep working with no new variable. The fallback hardcodes one specific
 * alias, which silently forced every environment's seed account onto the same
 * address - staging's is `+automationstg`, matching its `pfautomationstg`
 * username (see the Portability section in CLAUDE.md).
 */
export function seedEmail(): string {
  return process.env.TEST_SEED_EMAIL || `${requireEnv('TEST_EMAIL_USER')}+automation${requireEnv('TEST_EMAIL_DOMAIN')}`;
}
