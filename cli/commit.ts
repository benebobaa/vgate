/**
 * What a verdict or a guard report was computed against: the commit and the uncommitted state of the working tree.
 * `vgate decide` accepts evidence only for the tree it is deciding on, so a verdict from an earlier push, another
 * branch or a tree edited after the gate ran cannot stand in for this change.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ProjectConfig } from '../framework/project.ts';
import { git } from './guard.ts';

export interface TreeState {
  /** The full HEAD commit; null outside git or in a repository without commits. */
  sha: string | null;
  /** Tracked changes against HEAD, or untracked files (outside vgate's own output). */
  dirty: boolean;
  /** sha256 over the uncommitted state: equal fingerprints on equal commits mean the same files. */
  fingerprint: string | null;
}

/**
 * The paths vgate itself writes while it verifies (reports, the runtime links, generated contract types): never part
 * of the code under judgement, whether or not the project's .gitignore lists them.
 */
function vgateOutput(project: ProjectConfig, top: string, extra: string[]): (path: string) => boolean {
  // Through the real root: the project path may run through a symlink (macOS /var -> /private/var), git's never does.
  const root = realpathSync(project.root);
  const reports = relative(top, join(root, relative(project.root, project.reportsDir)));
  const services = relative(top, join(root, relative(project.root, project.servicesDir)));
  const others = extra.map((dir) => relative(top, dir)).filter((dir) => !dir.startsWith('..'));
  const under = (dir: string, path: string) => dir !== '' && (path === dir || path.startsWith(`${dir}/`));
  return (path) =>
    under(reports, path) ||
    others.some((dir) => under(dir, path)) ||
    ['node_modules', 'tsconfig.json', 'package.json'].some((name) => under(`${services}/${name}`, path)) ||
    (path.startsWith(`${services}/`) && path.slice(services.length + 1).split('/')[1] === 'generated');
}

function contentHash(file: string): string {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return `link:${readlinkSync(file)}`;
    if (!stat.isFile()) return 'other';
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

/** `exclude`: more directories (absolute) that hold vgate's own files, e.g. the evidence `vgate decide` reads. */
export function treeState(project: ProjectConfig, exclude: string[] = []): TreeState {
  const unknown: TreeState = { sha: null, dirty: false, fingerprint: null };
  const top = git(project.root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return unknown;
  const topDir = realpathSync(top.out.trim());
  const head = git(topDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.code !== 0) return unknown;
  const ours = vgateOutput(
    project,
    topDir,
    exclude.map((dir) => (existsSync(dir) ? realpathSync(dir) : dir)),
  );
  const diff = git(topDir, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.']);
  const others = git(topDir, ['ls-files', '-z', '--others', '--exclude-standard']);
  // A state that cannot be read must not compare equal to anything: no fingerprint, so decide treats it as unknown.
  if (diff.code !== 0 || others.code !== 0) return { sha: head.out.trim(), dirty: true, fingerprint: null };
  const tracked = diff.out
    .split(/(?=^diff --git )/m)
    .filter((part) => {
      const path = /^diff --git a\/(.*?) b\//.exec(part)?.[1];
      return part !== '' && !(path !== undefined && ours(path));
    })
    .join('');
  const untracked = others.out
    .split('\0')
    .filter((path) => path !== '' && !ours(path))
    .sort()
    .map((path) => `${path}\0${contentHash(join(topDir, path))}`);
  const fingerprint = createHash('sha256').update(tracked).update('\0\0').update(untracked.join('\n')).digest('hex');
  return { sha: head.out.trim(), dirty: tracked !== '' || untracked.length > 0, fingerprint };
}

/**
 * Why evidence recorded at `then` does not describe the tree `now`, or undefined when it does. Evidence without a
 * recorded commit (a gate run outside git) is not judged here: the expectation hashes are its only binding.
 */
export function staleTree(then: TreeState | undefined, now: TreeState): string | undefined {
  // Outside git nothing can be bound: the expectation hashes are the only check. Inside git, evidence that names no
  // commit cannot be told apart from a file the change itself committed, so it never counts.
  if (!then || then.sha === null)
    return now.sha === null
      ? undefined
      : 'it is not bound to a commit, and this tree is in git (a committed or hand-made file?)';
  if (now.sha === null) return 'it names a commit, but this tree has none to compare with';
  if (then.sha !== now.sha)
    return `it was computed on commit ${then.sha.slice(0, 12)}, this is ${now.sha.slice(0, 12)}`;
  if (then.fingerprint === null || now.fingerprint === null)
    return 'the uncommitted state could not be read, so it cannot be shown to be the same';
  if (then.fingerprint !== now.fingerprint) return 'the working tree changed after it ran (uncommitted changes differ)';
  return undefined;
}
