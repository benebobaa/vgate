/**
 * Single-source-of-truth generator for the `vgate-verify` skill from `vgate.yaml` + `<servicesDir>/<svc>/features/`.
 * Generating the verification skill directly from project configuration guarantees the markdown instructions never
 * drift out of sync with the actual test runner and Feature Map.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeatureMap } from '../verification/feature-map.ts';

export interface GenerateVerifySkillInput {
  projectRoot: string;
  servicesDir: string;
  services: string[];
  guardrailsPresent: boolean;
}

export function generateVerifySkill(input: GenerateVerifySkillInput): string {
  const lines: string[] = [
    '---',
    'name: vgate-verify',
    'description: Auto-generated verification skill derived from vgate.yaml and service Feature Maps. Always regenerate via `vgate init` or `vgate skills install` instead of editing by hand.',
    'pack: core',
    '---',
    '',
    '# vgate-verify (Generated from vgate.yaml + features/)',
    '',
    'This skill is generated from your repository configuration so instructions cannot drift from the runner.',
    '',
    '## 1. Launch & Doctor',
    '- Run `vgate doctor --fix --json` before your first drive.',
    ...(input.guardrailsPresent
      ? ['- Run `vgate lint --json` to enforce `guardrails.yaml` and brownfield ratchets.']
      : []),
    '',
    '## 2. Services & Feature Maps',
  ];

  if (input.services.length === 0) {
    lines.push('- No services configured yet. Run `vgate init --service <name>` to scaffold one.');
  } else {
    for (const service of input.services) {
      const svcDir = join(input.servicesDir, service);
      lines.push(`### Service: \`${service}\``);
      lines.push(`- Start stack: \`vgate up --service ${service} --json\``);
      lines.push(`- Check health: \`vgate status --service ${service} --json\``);
      lines.push(`- Run gate: \`vgate gate --service ${service} --json\``);
      lines.push(`- Check guard: \`vgate guard --service ${service} --base origin/main --json\``);
      lines.push(`- Teardown: \`vgate down --service ${service}\``);

      if (existsSync(join(svcDir, 'features'))) {
        const map = loadFeatureMap(svcDir);
        if (map.features.length > 0) {
          lines.push('- Mapped features (`vgate maintain --service ' + service + '`):');
          for (const feature of map.features) {
            const target = feature.route ?? feature.endpoints?.join(', ') ?? feature.sourceFiles[0] ?? '';
            lines.push(`  - \`${feature.id}\` (${feature.name})${target ? ` — ${target}` : ''}`);
          }
        }
      }
      lines.push('');
    }
  }

  lines.push(
    '## 3. Evidence & Skip-Logging Discipline',
    '- Copy all steps into your task list before starting.',
    '- Inspect `reports/verdict.json`, `reports/guard.json`, and `reports/review-bundle.json` (never trust self-reports).',
    '- If any step is skipped, log the exact step name, reason, and risk explicitly in your summary.',
    '',
  );

  return lines.join('\n');
}

export function discoverServiceNames(servicesDir: string): string[] {
  if (!existsSync(servicesDir)) return [];
  return readdirSync(servicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(servicesDir, entry.name, 'service.yaml')))
    .map((entry) => entry.name)
    .sort();
}
