import { createTest, expect } from '@vgate/framework/fixtures.ts';
import type { paths } from '../generated/openapi.ts';

/** The framework's test, typed by the contract. */
export const test = createTest<paths>();
export { expect };
