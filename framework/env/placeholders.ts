/**
 * `{name.key}` placeholders: values an environment knows only once a run is planned (a host port, a broker address).
 * They are written in service.yaml (the app's `env`, and the environments block the tests read) and resolved from a
 * map of name -> key -> value. A dot is required, so single-word templates such as a header's `{origin}` stay as they
 * are.
 */
export const PLACEHOLDER = /\{([a-z][a-z0-9-]*)\.([A-Za-z][A-Za-z0-9]*)\}/g;

export type Values = Record<string, Record<string, string>>;

/** Replaces every placeholder; an unknown one throws, naming where it was and what exists. */
export function resolvePlaceholders(text: string, values: Values, where: string): string {
  return text.replace(PLACEHOLDER, (_match, name: string, key: string) => {
    const value = values[name]?.[key];
    if (value === undefined) {
      const known = Object.entries(values).flatMap(([n, keys]) => Object.keys(keys).map((k) => `{${n}.${k}}`));
      throw new Error(`${where}: unknown placeholder {${name}.${key}} (known: ${known.join(', ') || 'none'})`);
    }
    return value;
  });
}

/** The same, through every string of a YAML value. */
export function resolveDeep(value: unknown, values: Values, where: string): unknown {
  if (typeof value === 'string') return resolvePlaceholders(value, values, where);
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, values, where));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveDeep(item, values, where)]));
  return value;
}

export function hasPlaceholders(value: unknown): boolean {
  if (typeof value === 'string') return new RegExp(PLACEHOLDER.source).test(value);
  if (Array.isArray(value)) return value.some(hasPlaceholders);
  if (value && typeof value === 'object') return Object.values(value).some(hasPlaceholders);
  return false;
}
