/**
 * Runs a k6 script of a service with its environment and a seeded user's token. Outside the gate: a smoke-level
 * check that latency and error-rate thresholds hold, not a load test.
 *
 *   tsx framework/cli/perf.ts --service example [--script smoke] [--user reader]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Auth } from '../auth/auth.ts';
import { loadService, reportsDir } from '../config.ts';
import { fail, parseArgs, str } from './args.ts';

const args = parseArgs(process.argv.slice(2));
const svc = loadService(str(args.service));
// Load against a shared environment (staging, production) is a decision, never a default: the environment says so.
if (!svc.env.disposable && svc.env.allowLoad !== true)
  fail(
    `k6 refused: environment ${svc.env.name} is not disposable. Load against it needs ` +
      `environments.${svc.env.name}.allowLoad: true in ${svc.name}'s service.yaml (docs/after-deploy.md).`,
  );
const script = resolve(svc.dir, 'perf', `${str(args.script, 'smoke')}.ts`);
if (!existsSync(script)) fail(`No k6 script at ${script}`);
const user = str(args.user) ?? Object.keys(svc.env.users)[0] ?? fail('No seeded users');
if (!svc.env.users[user]) fail(`No user "${user}" in ${svc.name} ${svc.env.name}`);
const auth = new Auth(svc.env);
// The script gets the credential and, for services that do not use `Authorization: Bearer`, where it goes.
const token = (await auth.credential(user)) ?? '';
const [authHeader, authValue] = Object.entries(token ? auth.header(token) : {})[0] ?? ['', ''];

const outDir = resolve(reportsDir, 'perf');
mkdirSync(outDir, { recursive: true });
const result = spawnSync(
  'k6',
  [
    'run',
    '--quiet',
    '--summary-export',
    resolve(outDir, `${svc.name}-${str(args.script, 'smoke')}.json`),
    '-e',
    `BASE_URL=${svc.env.baseUrl}`,
    '-e',
    `TOKEN=${token}`,
    '-e',
    `AUTH_HEADER=${authHeader}`,
    '-e',
    `AUTH_VALUE=${authValue}`,
    script,
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
