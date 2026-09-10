import { Page, Locator } from '@playwright/test';

/**
 * Matches a team card's accessible name ('<team name> 1 member <owner>') -
 * every team this suite creates has exactly 1 member, so that part is
 * hardcoded.
 *
 * Matches either role on purpose: the SAME card has been live-verified
 * rendering as a real `button` on /teams/list but as a real `link` on /teams
 * (For You), and even as a different role across two separate loads of the
 * same page - so never assume one role based on which page called this (see
 * CLAUDE.md's role-varies-per-load gotcha).
 */
export function teamCard(page: Page, teamName: string): Locator {
  const name = `${teamName} 1 member QA`;
  return page.getByRole('button', { name }).or(page.getByRole('link', { name }));
}
