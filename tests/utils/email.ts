import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { requireEnv } from './env';

const VERIFY_LINK_PATTERN = /<a[^>]+href="([^"]+)"[^>]*>\s*Verify your email\s*<\/a>/i;
// The password-recovery email carries a typed 6-digit code (not a link).
// Matched as a standalone token (word boundaries) against the plain-text
// body to avoid picking up part of a longer number (e.g. a phone number or
// date) elsewhere in the template.
const RESET_CODE_PATTERN = /\b(\d{6})\b/;

// The verification link in the email is wrapped in a Mandrill click-tracking
// redirect (mandrillapp.com/track/click/...?p=<base64 JSON>). Decoding it
// locally and returning the real destination avoids depending on a
// third-party domain being reachable during test runs. Falls back to the
// original href if the link isn't Mandrill-wrapped (e.g. the template changes).
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

// Mandrill/SES delivery into the real Gmail inbox has been observed to take
// well over 60s (sometimes over 2 minutes under concurrent test load), so
// the default budget is generous rather than tight.
export async function getVerificationLink(toAddress: string, sentAfter: Date, timeoutMs = 150000): Promise<string> {
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
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const uids = await client.search({ to: toAddress, since: sentAfter }, { uid: true });
        if (uids && uids.length > 0) {
          const latestUid = uids[uids.length - 1];
          const message = await client.fetchOne(latestUid, { source: true }, { uid: true });
          const parsed = await simpleParser(message.source);
          const html = parsed.html || parsed.textAsHtml || '';
          const match = html.match(VERIFY_LINK_PATTERN);
          if (!match) {
            throw new Error(`Verification email to ${toAddress} found but no "Verify your email" link matched inside it.`);
          }
          return resolveRealDestination(match[1].replace(/&amp;/g, '&'));
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      throw new Error(`Timed out waiting for verification email to ${toAddress} after ${timeoutMs}ms.`);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

// Same delivery-timing rationale as getVerificationLink above, but for the
// "Password Recovery" email, which carries a typed 6-digit code instead of a
// clickable link.
export async function getPasswordResetCode(toAddress: string, sentAfter: Date, timeoutMs = 150000): Promise<string> {
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
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const uids = await client.search({ to: toAddress, since: sentAfter }, { uid: true });
        if (uids && uids.length > 0) {
          const latestUid = uids[uids.length - 1];
          const message = await client.fetchOne(latestUid, { source: true }, { uid: true });
          const parsed = await simpleParser(message.source);
          const text = parsed.text || parsed.html || '';
          const match = text.match(RESET_CODE_PATTERN);
          if (!match) {
            throw new Error(`Password recovery email to ${toAddress} found but no 6-digit code matched inside it.`);
          }
          return match[1];
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      throw new Error(`Timed out waiting for password recovery email to ${toAddress} after ${timeoutMs}ms.`);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
