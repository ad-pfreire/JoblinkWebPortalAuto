import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { requireEnv } from './env';

const VERIFY_LINK_PATTERN = /<a[^>]+href="([^"]+)"[^>]*>\s*Verify your email\s*<\/a>/i;
// Matched with word boundaries to avoid matching part of a longer number elsewhere in the email.
const RESET_CODE_PATTERN = /\b(\d{6})\b/;

/**
 * A problem with the email itself (found, but unusable) rather than with the
 * connection - reported immediately instead of being retried until the budget
 * runs out, which would hide it behind a generic timeout.
 */
class EmailContentError extends Error {}

/**
 * Builds a fresh IMAP client for one poll.
 *
 * The three timeouts are load-bearing, not decoration: without them a hung
 * connect/greeting never settles, so the polling loops below - which only
 * check their own deadline BETWEEN iterations - wait forever instead of
 * failing. Live-verified 2026-09-14 against staging: a provisioning run sat
 * 25+ minutes on a `getInvitationLink()` whose email had actually been in the
 * mailbox the whole time, with no browser activity and no error.
 */
function createImapClient(): ImapFlow {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: requireEnv('GMAIL_IMAP_USER'),
      pass: requireEnv('GMAIL_IMAP_APP_PASSWORD'),
    },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
  });
}

/**
 * Runs one poll against a fresh connection, swallowing connection-level
 * failures so the caller's loop simply tries again on the next iteration.
 *
 * @returns The poll's result, or `null` if the email isn't there yet (or this
 * attempt failed to reach the mailbox at all).
 */
async function pollMailbox<T>(read: (client: ImapFlow) => Promise<T | null>): Promise<T | null> {
  const client = createImapClient();
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      return await read(client);
    } finally {
      lock.release();
    }
  } catch (error) {
    if (error instanceof EmailContentError) throw error;
    return null;
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Unwraps a Mandrill click-tracking redirect to the real destination URL.
 *
 * @returns The decoded URL, or the original `href` if it isn't Mandrill-wrapped.
 */
function resolveRealDestination(href: string): string {
  try {
    const url = new URL(href);
    const p = url.searchParams.get('p');
    if (!p) return href;
    const outer = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    const inner = JSON.parse(outer.p);
    return inner.url || href;
  } catch {
    return href;
  }
}

/**
 * Polls the real inbox for the registration verification email and returns its link.
 *
 * Reconnects fresh on every poll — holding one IMAP connection open can
 * silently miss mail that arrives mid-poll (see CLAUDE.md). `sentAfter` is
 * unused: combining `to` with a same-day `since` can spuriously return zero
 * results (see CLAUDE.md); safe here since every caller passes a never-used alias.
 *
 * Filters by subject, not just `to` — an invitee address that already has a
 * "New Invitation!" email waiting (see `getInvitationLink()`, e.g. `teams.spec.ts`
 * test 6.7, which invites the same address before it registers) can otherwise
 * match that older email first and throw on the regex instead of waiting for
 * the real verification email to arrive. Same root cause `getInvitationLink()`
 * was already fixed for; this one just hadn't hit it yet.
 *
 * @returns The real (Mandrill-unwrapped) verification link.
 */
export async function getVerificationLink(toAddress: string, sentAfter: Date, timeoutMs = 150000): Promise<string> {
  void sentAfter;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const link = await pollMailbox(async (client) => {
      const uids = await client.search({ to: toAddress, subject: 'Job Link Registration Confirmation' }, { uid: true });
      if (!uids || uids.length === 0) return null;
      const latestUid = uids[uids.length - 1];
      const message = await client.fetchOne(latestUid, { source: true }, { uid: true });
      // Narrows message.source to Buffer; unreachable in practice since search() already confirmed the uid.
      if (!message || !message.source) {
        throw new EmailContentError(`Fetched message ${latestUid} for ${toAddress} has no source body.`);
      }
      const parsed = await simpleParser(message.source);
      const html = parsed.html || parsed.textAsHtml || '';
      const match = html.match(VERIFY_LINK_PATTERN);
      if (!match) {
        throw new EmailContentError(`Verification email to ${toAddress} found but no "Verify your email" link matched inside it.`);
      }
      return resolveRealDestination(match[1].replace(/&amp;/g, '&'));
    });
    if (link) return link;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for verification email to ${toAddress} after ${timeoutMs}ms.`);
}

// Matches the JWT-charset URL, trimming a trailing sentence-ending period defensively.
const INVITATION_LINK_PATTERN = /(https:\/\/[^\s<]+\/invitation\?token=[A-Za-z0-9\-_.]+)/;

/**
 * Polls the real inbox for a team-invitation email ("New Invitation!") and
 * returns its link.
 *
 * Filters by subject, not just `to` — an invitee with prior mail (e.g. their
 * own registration email) can otherwise match a stale message first (see CLAUDE.md).
 * The link isn't Mandrill-wrapped, so no unwrap is needed.
 *
 * @returns The invitation link (`/invitation?token=...`).
 */
export async function getInvitationLink(toAddress: string, timeoutMs = 150000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const link = await pollMailbox(async (client) => {
      const uids = await client.search({ to: toAddress, subject: 'New Invitation!' }, { uid: true });
      if (!uids || uids.length === 0) return null;
      const latestUid = uids[uids.length - 1];
      const message = await client.fetchOne(latestUid, { source: true }, { uid: true });
      // Narrows message.source to Buffer; unreachable in practice since search() already confirmed the uid.
      if (!message || !message.source) {
        throw new EmailContentError(`Fetched message ${latestUid} for ${toAddress} has no source body.`);
      }
      const parsed = await simpleParser(message.source);
      const html = parsed.html || parsed.textAsHtml || parsed.text || '';
      const match = html.match(INVITATION_LINK_PATTERN);
      if (!match) {
        throw new EmailContentError(`Invitation email to ${toAddress} found but no invitation link matched inside it.`);
      }
      return match[1].replace(/\.$/, '').replace(/&amp;/g, '&');
    });
    if (link) return link;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for invitation email to ${toAddress} after ${timeoutMs}ms.`);
}

/**
 * Polls the real inbox for the password-recovery email and returns its 6-digit code.
 *
 * Reconnects fresh on every poll and ignores `sentAfter`, for the same
 * reasons as {@link getVerificationLink} (see CLAUDE.md).
 *
 * @returns The 6-digit reset code.
 */
export async function getPasswordResetCode(toAddress: string, sentAfter: Date, timeoutMs = 150000): Promise<string> {
  void sentAfter;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await pollMailbox(async (client) => {
      const uids = await client.search({ to: toAddress }, { uid: true });
      if (!uids || uids.length === 0) return null;
      const latestUid = uids[uids.length - 1];
      const message = await client.fetchOne(latestUid, { source: true }, { uid: true });
      // Narrows message.source to Buffer; unreachable in practice since search() already confirmed the uid.
      if (!message || !message.source) {
        throw new EmailContentError(`Fetched message ${latestUid} for ${toAddress} has no source body.`);
      }
      const parsed = await simpleParser(message.source);
      const text = parsed.text || parsed.html || '';
      const match = text.match(RESET_CODE_PATTERN);
      if (!match) {
        throw new EmailContentError(`Password recovery email to ${toAddress} found but no 6-digit code matched inside it.`);
      }
      return match[1];
    });
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for password recovery email to ${toAddress} after ${timeoutMs}ms.`);
}

/**
 * Polls for a NEW email to arrive at `toAddress` after `sentAfter`, without
 * assuming a specific subject/content - used to check whether some
 * not-yet-confirmed notification (e.g. a team-removal notice) exists at
 * all. Unlike this file's other functions, this one DOES filter by date -
 * deliberately, because the whole point here is telling a genuinely new
 * message apart from an OLDER one already sitting in the same mailbox from
 * an earlier step of the same test (e.g. that address's own invitation
 * email, read but never removed from the inbox). Filters by each
 * candidate's own parsed date client-side (not IMAP's `since` SEARCH
 * criterion, which has its own documented same-day false-negative bug -
 * see CLAUDE.md), and reconnects fresh on every poll like the other functions here.
 *
 * @returns The subject of the first genuinely-new email found, or `null`
 * if none arrived within `timeoutMs` (a real "no email sent" result, not a
 * thrown error - the caller decides whether that's expected).
 */
export async function checkForAnyEmail(toAddress: string, sentAfter: Date, timeoutMs = 60000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const subject = await pollMailbox(async (client) => {
      const uids = await client.search({ to: toAddress }, { uid: true });
      for (const uid of uids ? [...uids].reverse() : []) {
        const message = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!message || !message.source) continue;
        const envelopeDate = message.envelope?.date;
        if (envelopeDate && new Date(envelopeDate) > sentAfter) {
          const parsed = await simpleParser(message.source);
          return parsed.subject || '(no subject)';
        }
      }
      return null;
    });
    if (subject) return subject;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}
