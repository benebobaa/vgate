# Frontend pull requests

A pull request that changes a web frontend gets the same verdict as one that changes a backend: real browser flows,
judged by plain tooling, no model in the gate. A UI service is a service whose `service.yaml` declares `ui:`; its
tests drive a real Chromium through Playwright, and every test is held to a few rules automatically, without a line
in the test. `services/example-web` is the reference.

## What every test is held to

| Rule                    | What fails the test                                                                                                   | Setting                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Sealed browser          | A request or websocket to an origin outside `ui.allowedOrigins` (it is blocked, recorded, and fails)                  | `allowedOrigins` (default self)  |
| Console and page errors | `console.error`, an uncaught exception, a failed request (4xx/5xx or network) to the app's own origin                 | `ui.expect…` in the test         |
| Accessibility           | An axe-core violation at or above `ui.a11y.minImpact` on any page the test visits (after every `goto` and at the end) | `a11y.minImpact`, `a11y.disable` |
| Web vitals              | Largest contentful paint or cumulative layout shift above `ui.budgets`                                                | `budgets` (optional)             |
| Visual                  | `expect(page).toHaveScreenshot(...)` differing from the committed baseline by one pixel                               | baselines next to the tests      |

A test that causes an error on purpose says so, and only that error passes:

```ts
ui.expectFailedRequest({ method: 'POST', path: /^\/api\/notes$/, status: 403 });
ui.expectConsoleError(/rejected/);
```

Every test's findings go to `<reports>/ui/*.jsonl`, and the gate's verdict summarises them (`ui`: pages visited,
outbound hosts, console errors, accessibility rules, budget breaches): `browser: 2 pages, accessible, no outbound
call`.

## service.yaml

```yaml
name: web
ui:
  baseUrl: http://localhost:3000 # optional: the environment's baseUrl otherwise
  allowedOrigins: [self] # 'self' is the app's own origin; add exact origins (https://cdn.example.com) only
  viewports:
    desktop: { width: 1280, height: 800 }
    mobile: { width: 390, height: 844 }
  clock: '2026-01-15T09:00:00Z' # the page's fixed time: dates and timers are the same on every run
  a11y: { minImpact: serious, disable: [] }
  budgets: { lcpMs: 2500, cls: 0.1 }
environments:
  local:
    disposable: true
    baseUrl: http://localhost:3000
    healthPath: /
```

How the app starts is the same as for any service: a `stack.sh` (a static server, `vite preview`, `next start`) or a
declared `environment:` app. Its backend is either another service of the project started alongside it (as
example-web starts the example notes API) or stubs through the `http-stub` dependency kind (docs/dependencies.md).
A UI service needs no contract of its own: without `spec:` the Schemathesis step does not apply, and the coverage
step checks the plan instead: every scenario of `inventory.yaml` has a test the run collected.

Tests use `createUiTest()` instead of `createTest()`:

```ts
import { createUiTest, expect } from '@vgate/framework/ui/fixtures.ts';
export const test = createUiTest();

test('[UI-CREATE-201] adding a note shows it in the list (rule 4)', async ({ page, ui }) => {
  await page.goto(ui.url('/'));
  // ...
});
```

## Deterministic screenshots

A baseline is an expectation only if the same page draws the same pixels every time. The fixtures fix everything
that would vary between runs of one machine: the clock (`ui.clock`), locale `en-US`, time zone UTC, light colour
scheme, reduced motion, device scale 1, and the screenshot itself has animations disabled and the caret hidden.
Content that changes by nature (counters, other users' data) is masked with `toHaveScreenshot`'s `mask` option, or
the screenshot is taken of a page that has none (example-web screenshots its sign-in page).

Fonts render differently across operating systems, so baselines are kept per platform:
`tests/__screenshots__/<platform>/<spec>/<name>.png`. A missing baseline fails the run like a different one; new
baselines are written only by an explicit run with `VGATE_UPDATE_SNAPSHOTS=1`. CI runs on Linux, so its baselines
are made on Linux: run the gate once with `VGATE_UPDATE_SNAPSHOTS=1` in the CI image (or the CI job) and commit
`__screenshots__/linux/`.

## The guard

Visual baselines and the browser rules are expectations, so weakening them needs a human (`vgate guard`):

- a changed or deleted baseline image (`visual-changed`; the image diff is in the run's evidence);
- `ui.a11y.minImpact` lowered, an axe rule added to `a11y.disable`, an origin added to `allowedOrigins`, a viewport
  removed, a budget removed or raised, or `ui:` removed (`config-loosened`).

A new baseline is additive and needs no one.

## The browser

`vgate doctor` checks that Chromium is installed for the runtime's Playwright when a project has a UI service;
`vgate doctor --fix` installs it (Chromium only). On Linux CI the system libraries Chromium needs come from
`playwright install-deps chromium`, which the GitHub workflow runs when the project has a UI service; it also caches
the browser and uploads the screenshot diffs of a failed run.

## Not covered (yet)

- Browsers other than Chromium; mobile devices beyond viewport sizes.
- A Linux baseline made on macOS: baselines are per platform by design.
- Requests a page makes from a service worker or a WebAssembly socket outside Playwright's routing.
