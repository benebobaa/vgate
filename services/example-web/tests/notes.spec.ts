// Sources: services/example-web/README.md rules 1-5, 7 and 9. Every test also runs under the automatic rules of
// framework/ui (sealed browser, console errors, accessibility, budget): a test only states what it expects.
import { expect, signIn, test } from '../support/fixtures.ts';

test.describe('sign in', () => {
  test('[UI-SIGNIN-200] a writer signs in and sees the notes (rule 1)', async ({ page, ui, svc }) => {
    await signIn(page, ui, svc.env.users.writer.token ?? '');
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add note' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeHidden();
  });

  test('[UI-SIGNIN-401] a key the API refuses keeps the sign-in form, with a message (rule 2)', async ({
    page,
    ui,
  }) => {
    ui.expectFailedRequest({ method: 'GET', path: /^\/api\/notes$/, status: 401 });
    await signIn(page, ui, 'not-a-key');
    await expect(page.getByRole('alert').filter({ hasText: 'That key was not accepted.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});

test.describe('notes', () => {
  test('[UI-LIST-200] the list shows the most recent notes first (rule 3)', async ({ page, ui, svc, unique }) => {
    const first = unique('first');
    const second = unique('second');
    await signIn(page, ui, svc.env.users.writer.token ?? '');
    for (const title of [first, second]) {
      await page.getByLabel('Title').fill(title);
      await page.getByRole('button', { name: 'Add note' }).click();
      await expect(page.getByRole('listitem').filter({ hasText: title })).toBeVisible();
    }
    const titles = await page.getByRole('listitem').allTextContents();
    const at = (title: string) => titles.findIndex((text) => text.includes(title));
    expect(at(second)).toBeGreaterThanOrEqual(0);
    expect(at(second)).toBeLessThan(at(first));
  });

  test('[UI-CREATE-201] adding a note with a title shows it in the list (rule 4)', async ({
    page,
    ui,
    svc,
    unique,
  }) => {
    const title = unique('groceries');
    await signIn(page, ui, svc.env.users.writer.token ?? '');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Body').fill('milk and bread');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: title })).toContainText('milk and bread');
    await expect(page.getByLabel('Title')).toHaveValue('');
  });

  test('[UI-CREATE-REQUIRED] an empty title shows "Title is required." and sends nothing (rule 4)', async ({
    page,
    ui,
    svc,
  }) => {
    await signIn(page, ui, svc.env.users.writer.token ?? '');
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
    let posted = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST') posted++;
    });
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Title is required.' })).toBeVisible();
    await expect(page.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(posted).toBe(0);
  });

  test('[UI-READER-403] a reader adding a note is told the key may only read (rule 5)', async ({
    page,
    ui,
    svc,
    unique,
  }) => {
    const title = unique('not-mine');
    ui.expectFailedRequest({ method: 'POST', path: /^\/api\/notes$/, status: 403 });
    await signIn(page, ui, svc.env.users.reader.token ?? '');
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Your key may only read notes.' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: title })).toHaveCount(0);
  });
});

test.describe('conventions', () => {
  test('[UI-A11Y] both pages pass the accessibility check (rule 7)', async ({ page, ui, svc }) => {
    await page.goto(ui.url('/'));
    await ui.checkA11y();
    await signIn(page, ui, svc.env.users.writer.token ?? '');
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
    await ui.checkA11y();
    expect(ui.findings.a11y).toEqual([]);
  });

  test('[UI-BUDGET] the notes page stays within its web-vitals budget (rule 9)', async ({ page, ui, svc }) => {
    await signIn(page, ui, svc.env.users.writer.token ?? '');
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
    const vitals = await page.evaluate(
      () => (globalThis as unknown as { __vgateVitals?: { lcp?: number; cls: number } }).__vgateVitals,
    );
    expect(vitals, 'the budget is measured on this page').toBeDefined();
    expect(vitals?.lcp ?? 0).toBeLessThan(ui.config.budgets?.lcpMs ?? Infinity);
    expect(vitals?.cls ?? 0).toBeLessThan(ui.config.budgets?.cls ?? Infinity);
  });
});
