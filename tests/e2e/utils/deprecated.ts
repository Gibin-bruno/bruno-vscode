import type { TestDetails } from '@playwright/test';

/**
 * Test details for an e2e test whose behaviour is now covered by an integration test
 * (tests/integration, run with `npm run test:integration`).
 *
 * The test still runs. It's tagged `@deprecated` — skip it with `--grep-invert @deprecated` — and
 * annotated with its replacement, plus anything the replacement doesn't cover (usually UI checks),
 * so it can be cut down or removed later without losing coverage.
 *
 *   test('title', deprecatedBy('tests/integration/x.test.ts', { notCovered: 'the toast' }), async () => …)
 */
export function deprecatedBy(
  integrationTest: string,
  { tags = [], notCovered }: { tags?: string[]; notCovered?: string } = {}
): TestDetails {
  return {
    tag: [...tags, '@deprecated'],
    annotation: {
      type: 'deprecated',
      description: `Covered by ${integrationTest}${notCovered ? `. Not covered there: ${notCovered}` : ''}`
    }
  };
}
