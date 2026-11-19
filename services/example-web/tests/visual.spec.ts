// Source: services/example-web/README.md rule 6. The committed screenshots under __screenshots__/ are the
// expectation; changing one is an expectation change the guard sends to a human (docs/frontend.md).
import { expect, test } from '../support/fixtures.ts';

test.describe('visual', () => {
  test('[UI-VISUAL-SIGNIN] the sign-in page matches its screenshots on desktop and mobile (rule 6)', async ({
    page,
    ui,
  }) => {
    for (const viewport of ['desktop', 'mobile']) {
      await ui.viewport(viewport);
      await page.goto(ui.url('/'));
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await expect(page).toHaveScreenshot(`signin-${viewport}.png`, { fullPage: true });
    }
  });
});
