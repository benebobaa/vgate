import { createUiTest, expect, type Ui } from '@vgate/framework/ui/fixtures.ts';
import type { Page } from '@playwright/test';

/** The framework's browser test: a watched page (sealed, console, accessibility, budget) and the `ui` helper. */
export const test = createUiTest();

/** Signs in with an API key from the service's seeded users (README rule 1). */
export async function signIn(page: Page, ui: Ui, key: string): Promise<void> {
  await page.goto(ui.url('/'));
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export { expect };
