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
//
// `sentAfter` is intentionally NOT passed to the IMAP search below anymore -
// see the KNOWN GOTCHA comment above getInvitationLink() for the full,
// live-verified reasoning (combining `to` with a same-calendar-day `since`
// can make ImapFlow's Gmail search spuriously return zero results for a
// message that is genuinely already sitting in the mailbox). Kept as a
// parameter rather than removed outright, to avoid a signature change
// rippling across every existing call site in account-registration.spec.ts/
// forgot-password.spec.ts/profile-settings.spec.ts/payments.spec.ts/
// teams.spec.ts - safe to ignore here specifically because every call site
// already passes a freshly `generateUniqueEmailAlias()`d address that has
// never received mail before, so a `to`-only search can't collide with a
// stale message from an earlier run either.
// KNOWN GOTCHA, live-verified 2026-08-25 while writing tests/subscription.spec.ts:
// holding ONE IMAP connection/mailbox lock open for the entire poll loop
// (the pattern this function, getInvitationLink(), and getPasswordResetCode()
// all previously used) can silently never see mail that arrives DURING that
// same long-lived session, even after 900_000ms (15 minutes) of continuous
// polling on 3s intervals - reproduced identically across 10+ consecutive
// real runs, including a from-scratch run started by the maintainer
// directly in a fresh terminal (so not an artifact of this session's own
// prior activity). In every single case, a completely SEPARATE, freshly
// connected IMAP script (connect -> select -> search, once) found the exact
// same email instantly, often within seconds of when it was actually sent
// (confirmed via the message's own envelope Date header) - proving the
// message was sitting in the mailbox the whole time and the long-lived
// polling connection simply never picked it up. Gmail's IMAP server appears
// not to reliably push new-mail state to an already-SELECTed session across
// repeated SEARCH commands the way a plain re-connect-and-search always
// does. Fix: reconnect from scratch on every poll iteration (matching the
// approach that never once failed in ad-hoc verification scripts) rather
// than holding one connection/lock open for the whole timeout budget. This
// is heavier per-iteration (a fresh TLS handshake every 3s) but the
// reliability difference is not a marginal improvement - it is the
// difference between "always eventually finds a message that is
// demonstrably already there" and "can time out indefinitely regardless of
// budget size."
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
          // ImapFlow types fetchOne() as `FetchMessageObject | false` and
          // `source` itself as optional - in practice neither can happen
          // here (we only reach this branch after search() already
          // confirmed the uid exists, and `{ source: true }` guarantees the
          // buffer is populated), but the guard keeps this genuinely
          // type-safe (message.source narrows to `Buffer`, not `Buffer |
          // undefined`) instead of just silencing the compiler.
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

// The team-invitation email ("New Invitation!" subject) embeds the
// invitation link as a PLAIN URL inside a <p><span> paragraph, not as a
// real <a href> button like the verification email - live-verified via
// direct inspection of a real invitation email while writing
// tests/teams.spec.ts's test 6.7. It is also NOT Mandrill-click-wrapped
// (unlike the verification link), so no resolveRealDestination() unwrap is
// needed here. The URL can be immediately followed by a sentence-ending
// period in the source text, so the pattern stops at the first character
// that isn't part of a JWT (base64url charset plus '.' separators) followed
// by whitespace/end-of-tag, then any trailing '.' is trimmed defensively.
const INVITATION_LINK_PATTERN = /(https:\/\/[^\s<]+\/invitation\?token=[A-Za-z0-9\-_.]+)/;

// Same delivery-timing rationale as getVerificationLink above, but for the
// team-invitation email. Deliberately does NOT filter by `since` in the
// IMAP search - see the `since`-boundary gotcha documented on
// getVerificationLink() below for why, and why omitting it here is safe:
// every caller of this function passes a freshly `generateUniqueEmailAlias()`d
// address that has never received mail before, so matching by `to` alone
// can never collide with a stale message from an earlier run.
// See the KNOWN GOTCHA on getVerificationLink() above for why this
// reconnects fresh on every poll iteration instead of holding one
// connection/lock open for the whole timeout budget.
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
        const uids = await client.search({ to: toAddress }, { uid: true });
        if (uids && uids.length > 0) {
          const latestUid = uids[uids.length - 1];
          const message = await client.fetchOne(latestUid, { source: true }, { uid: true });
          // ImapFlow types fetchOne() as `FetchMessageObject | false` and
          // `source` itself as optional - in practice neither can happen
          // here (we only reach this branch after search() already
          // confirmed the uid exists, and `{ source: true }` guarantees the
          // buffer is populated), but the guard keeps this genuinely
          // type-safe (message.source narrows to `Buffer`, not `Buffer |
          // undefined`) instead of just silencing the compiler.
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

// KNOWN GOTCHA, live-verified while writing tests/teams.spec.ts's test 6.7:
// combining `to` with `since` in an ImapFlow `.search()` call against this
// Gmail account can spuriously return ZERO results for a message that
// genuinely matches both criteria, specifically when `since`'s calendar date
// equals "today" - a `since` from any STRICTLY EARLIER calendar day works
// correctly (and still correctly includes today's messages, since SINCE
// means "on or after"). Reproduced 3 times isolating the exact same `to`
// value and only changing `since`: `since: <yesterday's date>` found the
// message instantly; `since: <today's date, any time value>` returned `[]`
// even though the message's real internalDate was hours after that `since`
// value. This was NOT a delivery-speed issue - the message was sitting in
// the mailbox the whole time (confirmed by re-querying with `to` alone).
// Every `getVerificationLink()`/`getPasswordResetCode()` call in this
// project passes `since = registeredAt`/`since = <moment just before
// requesting the email>`, i.e. almost always "today" - so this bug is a
// strong candidate for having caused at least some of the "email pipeline
// is slow" timeouts observed throughout this project's history that were
// previously attributed purely to real infra flakiness. FIXED below on both
// functions (each now searches by `to` alone, ignoring `since` entirely,
// exactly like `getInvitationLink()` above) - safe because every call site
// across every spec file in this project always passes a freshly
// `generateUniqueEmailAlias()`d address that has never received mail
// before, so a `to`-only search can't collide with a stale message from an
// earlier run either.

// Same delivery-timing rationale as getVerificationLink above, but for the
// "Password Recovery" email, which carries a typed 6-digit code instead of a
// clickable link. `sentAfter` is deliberately unused in the search for the
// same reason documented on getVerificationLink() above - forgot-password.spec.ts's
// only call site also always targets a freshly-registered, never-reused
// disposable alias for its one-shot real-reset test, so a `to`-only search
// is equally safe here.
// See the KNOWN GOTCHA on getVerificationLink() above for why this
// reconnects fresh on every poll iteration instead of holding one
// connection/lock open for the whole timeout budget.
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
          // ImapFlow types fetchOne() as `FetchMessageObject | false` and
          // `source` itself as optional - in practice neither can happen
          // here (we only reach this branch after search() already
          // confirmed the uid exists, and `{ source: true }` guarantees the
          // buffer is populated), but the guard keeps this genuinely
          // type-safe (message.source narrows to `Buffer`, not `Buffer |
          // undefined`) instead of just silencing the compiler.
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
