import { Page, Locator } from '@playwright/test';

/**
 * A team card, by its accessible name ('<team name> 1 member <owner>').
 *
 * Matches `button` or `link` because the same card has been seen rendering as
 * either - even across two loads of the same page. Never narrow this to one role.
 */
export function teamCard(page: Page, teamName: string): Locator {
  const name = `${teamName} 1 member QA`;
  return page.getByRole('button', { name }).or(page.getByRole('link', { name }));
}
