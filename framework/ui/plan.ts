import { incidentCoverage, type Incident, type IncidentState } from '../incidents.ts';

/**
 * Plan coverage of a UI service: every scenario of its inventory.yaml has a test the run collected (by its id in the
 * title). A UI service with no contract has no documented responses to cover; its plan is the whole expectation.
 */

/** Every `scenarios: [{ id }]` id anywhere in the plan (pages, flows, conventions). */
export function scenarioIds(node: unknown): string[] {
  const walk = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(walk);
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) =>
      key === 'scenarios' && Array.isArray(child)
        ? child.flatMap((s: unknown) =>
            s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string'
              ? [(s as { id: string }).id, ...walk(s)]
              : [],
          )
        : walk(child),
    );
  };
  return [...new Set(walk(node))];
}

/** The planned ids no collected test title names (a whole id: `UI-A` is not tested by a `[UI-A-B]` test). */
export function untestedScenarios(ids: readonly string[], titles: readonly string[]): string[] {
  const text = titles.join('\n');
  const escape = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ids.filter((id) => !new RegExp(`(?<![A-Za-z0-9-])${escape(id)}(?![A-Za-z0-9-])`).test(text));
}

export interface UiCoverage {
  /** Planned scenario ids no collected test names. */
  untested: string[];
  /** Every incident with its state, as the contract coverage report keeps them. */
  incidents: IncidentState[];
  /** The incidents not guarded by a scenario and a collected test: each one fails the coverage step. */
  unguarded: IncidentState[];
}

/**
 * The whole coverage judgement of a UI service: the plan's scenarios, and every incident that escaped to production
 * guarded exactly as for an API service (framework/incidents.ts), so a UI service cannot drop the learning loop.
 */
export function uiCoverage(ids: readonly string[], titles: readonly string[], incidents: Incident[]): UiCoverage {
  const states = incidentCoverage(incidents, new Set(ids), titles.join('\n'));
  return {
    untested: untestedScenarios(ids, titles),
    incidents: states,
    unguarded: states.filter((i) => i.state === 'no-scenario' || i.state === 'no-test'),
  };
}
