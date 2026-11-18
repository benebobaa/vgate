/**
 * What every command hands back. The CLI's first user is an agent, so the result is data before it is prose: one
 * envelope, a stable exit code, and the commands that move the caller forward.
 */

/** The name commands print when they point at another command. */
export const CLI = 'vgate';

/** Exit codes are part of the interface: a caller branches on them without reading any text. */
export const EXIT = {
  /** Done, and the answer is yes. */
  ok: 0,
  /** The verification ran and its verdict is "fail". */
  failed: 1,
  /** The call itself was wrong: unknown command, flag or service. */
  usage: 2,
  /** Nothing was verified because the machine, the project or the stack is not ready. */
  notReady: 3,
} as const;

export interface Result {
  command: string;
  ok: boolean;
  exitCode: number;
  /** One line that stands on its own. */
  summary: string;
  data?: unknown;
  /** Commands to run next, most useful first. Empty when there is nothing to do. */
  next: string[];
  /** The human rendering of `data`; left out of the JSON. */
  text?: string[];
}

/** A wrong call. `main` turns it into exit code 2 with the usage hint. */
export class UsageError extends Error {}

export function emit(result: Result, json: boolean): void {
  const { text, ...wire } = result;
  if (json) {
    process.stdout.write(`${JSON.stringify(wire, null, 2)}\n`);
    return;
  }
  const lines = [...(text ?? []), result.summary, ...result.next.map((command) => `  next: ${command}`)];
  process.stdout.write(`${lines.join('\n')}\n`);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** The last `count` non-empty lines of a log, without colour codes. */
export function tail(text: string, count: number): string[] {
  return stripAnsi(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-count);
}
