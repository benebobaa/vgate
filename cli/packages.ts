import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * How doctor tells a person to install a missing system tool: with the package manager of the machine it runs on. A
 * fix line in the wrong dialect (apt-get on Fedora) is a dead end for whoever reads it.
 */
export type Installer = 'brew' | 'apt-get' | 'dnf' | 'yum' | 'zypper' | 'pacman' | 'apk';

/** Linux package managers, most specific first: Fedora keeps a yum alias next to dnf, so dnf is asked before yum. */
const LINUX: Installer[] = ['apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'apk'];

/** Whether an executable of that name is on PATH. */
export function onPath(command: string, path = process.env.PATH ?? ''): boolean {
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      const file = join(dir, command);
      return existsSync(file) && statSync(file).isFile();
    });
}

/** The package manager of this machine: Homebrew on macOS, the first Linux one on PATH, else undefined. */
export function detectInstaller(platform: string = process.platform, has: (command: string) => boolean = onPath) {
  if (platform === 'darwin') return 'brew' as const;
  return LINUX.find((installer) => has(installer));
}

/** Tools whose package name differs between package managers; any other tool's package is named like the tool. */
const NAMES: Record<string, Partial<Record<Installer, string>>> = {
  // ps and pgrep; minimal images (fedora, debian-slim) leave them out.
  procps: { dnf: 'procps-ng', yum: 'procps-ng', pacman: 'procps-ng' },
  java: {
    brew: 'temurin',
    'apt-get': 'default-jre-headless',
    dnf: 'java-latest-openjdk-headless',
    yum: 'java-21-openjdk-headless',
    zypper: 'java-21-openjdk-headless',
    pacman: 'jre-openjdk-headless',
    apk: 'openjdk21-jre-headless',
  },
};

/** The command that installs a tool's package with this installer. */
export function installCommand(installer: Installer | undefined, tool: string): string {
  const pkg = NAMES[tool]?.[installer ?? 'apt-get'] ?? tool;
  switch (installer) {
    case 'brew':
      return `brew install ${pkg}`;
    case 'apt-get':
      return `sudo apt-get install -y ${pkg}`;
    case 'dnf':
      return `sudo dnf install -y ${pkg}`;
    case 'yum':
      return `sudo yum install -y ${pkg}`;
    case 'zypper':
      return `sudo zypper install -y ${pkg}`;
    case 'pacman':
      return `sudo pacman -S --noconfirm ${pkg}`;
    case 'apk':
      return `apk add ${pkg}`;
    default:
      return `Install ${tool} with your system's package manager`;
  }
}

/** Where Docker Engine comes from. Fedora and RHEL ship Podman instead; vgate drives `docker compose`, so it needs Docker. */
export function dockerInstallHint(installer: Installer | undefined): string {
  switch (installer) {
    case 'brew':
      return 'brew install --cask docker';
    case 'dnf':
      return 'Fedora ships Podman, not Docker; vgate runs `docker compose`: https://docs.docker.com/engine/install/fedora/';
    case 'yum':
      return 'RHEL ships Podman, not Docker; vgate runs `docker compose`: https://docs.docker.com/engine/install/rhel/';
    default:
      return 'See https://docs.docker.com/engine/install/';
  }
}

/**
 * How to get pnpm. Corepack ships with Node from nodejs.org, fnm and nvm, but distribution packages may leave it out
 * (Fedora's nodejs has no corepack), and then `corepack enable` is a command that does not exist.
 */
export function pnpmInstallHint(hasCorepack: boolean, platform: string = process.platform): string {
  if (hasCorepack) return 'corepack enable pnpm';
  return platform === 'darwin'
    ? 'npm install -g corepack && corepack enable pnpm'
    : 'sudo npm install -g corepack && sudo corepack enable pnpm   # this Node has no corepack';
}
