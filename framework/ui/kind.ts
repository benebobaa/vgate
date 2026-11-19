/**
 * Prints `ui` for a UI service without a contract of its own, `contract` otherwise: `task coverage` picks its report
 * by it (framework/ui/coverage.ts or framework/cli/coverage-report.ts).
 */
import { existsSync } from 'node:fs';
import { loadService } from '../config.ts';

const svc = loadService();
process.stdout.write(svc.ui && !existsSync(svc.specPath) ? 'ui\n' : 'contract\n');
