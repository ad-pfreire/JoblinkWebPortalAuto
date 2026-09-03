import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { requireEnv } from './env';

const VERIFY_LINK_PATTERN = /<a[^>]+href="([^"]+)"[^>]*>\s*Verify your email\s*<\/a>/i;
// Matched with word boundaries to avoid matching part of a longer number elsewhere in the email.
const RESET_CODE_PATTERN = /\b(\d{6})\b/;

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
 * @returns The real (Mandrill-unwrapped) verification link.
 */
export async function getVerificationLink(toAddress: string, sentAfter: Date, timeoutMs = 150000): Promise<string> {
  void sentAfter;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: requireEnv('GMAIL_IMAP_USER'),
        pass: requireEnv('GMAIL_IMAP_APP_PASSWORD'),
      },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ to: toAddress }, { uid: true });
        if (uids && uids.length > 0) {
          const latestUid = uids[uids.length - 1];
          const message = await client.fetchOne(latestUid, { source: true }, { uid: true });
          // Narrows message.source to Buffer; unreachable in practice since search() already confirmed the uid.
          if (!message || !message.source) {
            throw new Error(`Fetched message ${latestUid} for ${toAddress} has no source body.`);
          }
          const parsed = await simpleParser(message.source);
          const html = parsed.html || parsed.textAsHtml || '';
          const match = html.match(VERIFY_LINK_PATTERN);
          if (!match) {
            throw new Error(`Verification email to ${toAddress} found but no "Verify your email" link matched inside it.`);
          }
          return resolveRealDestination(match[1].replace(/&amp;/g, '&'));
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
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
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: requireEnv('GMAIL_IMAP_USER'),
        pass: requireEnv('GMAIL_IMAP_APP_PASSWORD'),
      },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ to: toAddress, subject: 'New Invitation!' }, { uid: true });
        if (uids && uids.length > 0) {
          const latestUid = uids[uids.length - 1];
          const message = await client.fetchOne(latestUid, { source: true }, { uid: true });
          // Narrows message.source to Buffer; unreachable in practice since search() already confirmed the uid.
          if (!message || !message.source) {
            throw new Error(`Fetched message ${latestUid} for ${toAddress} has no source body.`);
          }
          const parsed = await simpleParser(message.source);
          const html = parsed.html || parsed.textAsHtml || parsed.text || '';
          const match = html.match(INVITATION_LINK_PATTERN);
          if (!match) {
            throw new Error(`Invitation email to ${toAddress} found but no invitation link matched inside it.`);
          }
          return match[1].replace(/\.$/, '').replace(/&amp;/g, '&');
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
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
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: requireEnv('GMAIL_IMAP_USER'),
        pass: requireEnv('GMAIL_IMAP_APP_PASSWORD'),
      },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ to: toAddress }, { uid: true });
        if (uids && uids.length > 0) {
          const latestUid = uids[uids.length - 1];
          const message = await client.fetchOne(latestUid, { source: true }, { uid: true });
          // Narrows message.source to Buffer; unreachable in practice since search() already confirmed the uid.
          if (!message || !message.source) {
            throw new Error(`Fetched message ${latestUid} for ${toAddress} has no source body.`);
          }
          const parsed = await simpleParser(message.source);
          const text = parsed.text || parsed.html || '';
          const match = text.match(RESET_CODE_PATTERN);
          if (!match) {
            throw new Error(`Password recovery email to ${toAddress} found but no 6-digit code matched inside it.`);
          }
          return match[1];
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for password recovery email to ${toAddress} after ${timeoutMs}ms.`);
}
