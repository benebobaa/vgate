/** The version of this build, and how a project pinned to another version gets that one. */
import type { ProjectConfig } from '../framework/project.ts';
import { BASE_URL } from './release-config.ts';

/** Set by `cli/build.ts` when the binary is compiled. Absent when run from source. */
declare const VGATE_VERSION: string | undefined;

/** `dev` when run from source. */
export const VERSION: string = typeof VGATE_VERSION !== 'undefined' ? VGATE_VERSION : 'dev';

/** Where releases are published (cli/release-config.ts): `<base>/install.sh` installs any version. */
export const INSTALL_BASE_URL = BASE_URL;

export function installCommand(version?: string): string {
  return `curl -fsSL ${INSTALL_BASE_URL}/install.sh | ${version ? `VGATE_VERSION=${version} ` : ''}sh`;
}

export interface PinCheck {
  /** `ok`: versions agree. `dev`: this build is from source and skips the check. `unpinned`: no version in
   * vgate.yaml (or no vgate.yaml). `mismatch`: the project needs another vgate. */
  state: 'ok' | 'dev' | 'unpinned' | 'mismatch';
  pinned?: string;
  running: string;
  message: string;
  /** The command that installs the pinned version (mismatch only). */
  fix?: string;
}

export function checkPin(project: ProjectConfig, running: string = VERSION): PinCheck {
  const pinned = project.version;
  if (running === 'dev')
    return {
      state: 'dev',
      pinned,
      running,
      message: `a development build (from source) runs any project${pinned ? `; the project pins ${pinned}` : ''}`,
    };
  if (!pinned)
    return {
      state: 'unpinned',
      pinned,
      running,
      message: `vgate.yaml pins no version: pin it to ${running} so every machine and CI runs the same judge`,
    };
  if (pinned === running) return { state: 'ok', pinned, running, message: `pinned to ${pinned}` };
  return {
    state: 'mismatch',
    pinned,
    running,
    message: `the project is pinned to vgate ${pinned}, this is ${running}: a different judge could give a different verdict`,
    fix: installCommand(pinned),
  };
}
