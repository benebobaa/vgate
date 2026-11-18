/**
 * Prints the credential of a seeded user (a Keycloak access token, or its static token or API key), for exploring the API by hand (curl, Postman, Swagger UI).
 *
 *   tsx framework/cli/token.ts --service example reader
 */
import { Auth } from '../auth/auth.ts';
import { loadService } from '../config.ts';
import { fail, parseArgs, str } from './args.ts';

const args = parseArgs(process.argv.slice(2));
const svc = loadService(str(args.service));
const user =
  args._[0] ?? fail(`Usage: token.ts --service <name> <user>  (users: ${Object.keys(svc.env.users).join(', ')})`);
if (!svc.env.users[user])
  fail(`No user "${user}" in ${svc.name} ${svc.env.name} (have: ${Object.keys(svc.env.users).join(', ')})`);
const credential = (await new Auth(svc.env).credential(user)) ?? fail(`User "${user}" has no credential (anonymous)`);
process.stdout.write(`${credential}\n`);
