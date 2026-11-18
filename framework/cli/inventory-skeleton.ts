/**
 * Prints the inventory skeleton of a service from its vendored contract (framework/inventory.ts). In a project, use
 * `vgate inventory --service <svc>` instead.
 *
 *   tsx framework/cli/inventory-skeleton.ts --service example > services/example/inventory.skeleton.yaml
 */
import { loadService } from '../config.ts';
import { inventorySkeleton } from '../inventory.ts';
import { parseArgs, str } from './args.ts';

const args = parseArgs(process.argv.slice(2));
process.stdout.write(inventorySkeleton(loadService(str(args.service))));
