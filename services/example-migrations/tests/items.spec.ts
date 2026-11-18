// Sources: services/example-migrations/README.md (rules 1-2) and openapi.yaml. These GET checks are also what
// `vgate migrations` runs against the version deployed today on a change's migrated schema (`migrate.smoke`).
import { expect, test } from '../support/fixtures.ts';

test.describe('GET /health', () => {
  test('[HLT-200] answers UP', async ({ api }) => {
    expect((await api.anonymous().get('/health')).expectSuccess()).toEqual({ status: 'UP' });
  });
});

test.describe('GET /items', () => {
  test('[ITM-200] lists the seeded items by id, each with its name (rule 1)', async ({ api }) => {
    const { items } = (await api.anonymous().get('/items')).expectSuccess();
    expect(items.map((item) => item.name)).toEqual(expect.arrayContaining(['apple', 'pear']));
    for (const item of items) expect(typeof item.name).toBe('string');
  });
});
