import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { detectInstaller, dockerInstallHint, installCommand, onPath, pnpmInstallHint } from './packages.ts';

describe('detectInstaller', () => {
  const only =
    (...present: string[]) =>
    (command: string) =>
      present.includes(command);

  it('is Homebrew on macOS, whatever else is on PATH', () => {
    assert.equal(detectInstaller('darwin', only('apt-get', 'dnf')), 'brew');
  });

  it('finds the Linux package manager on PATH', () => {
    assert.equal(detectInstaller('linux', only('apt-get')), 'apt-get');
    assert.equal(detectInstaller('linux', only('apk')), 'apk');
    assert.equal(detectInstaller('linux', only('zypper')), 'zypper');
    assert.equal(detectInstaller('linux', only('pacman')), 'pacman');
  });

  it('prefers dnf on Fedora, which keeps a yum alias next to it', () => {
    assert.equal(detectInstaller('linux', only('yum', 'dnf')), 'dnf');
    assert.equal(detectInstaller('linux', only('yum')), 'yum');
  });

  it('is undefined on a Linux without a known package manager', () => {
    assert.equal(detectInstaller('linux', only()), undefined);
  });
});

describe('installCommand', () => {
  it('speaks the dialect of each package manager', () => {
    assert.equal(installCommand('dnf', 'lsof'), 'sudo dnf install -y lsof');
    assert.equal(installCommand('apt-get', 'git'), 'sudo apt-get install -y git');
    assert.equal(installCommand('brew', 'curl'), 'brew install curl');
    assert.equal(installCommand('pacman', 'git'), 'sudo pacman -S --noconfirm git');
    assert.equal(installCommand('apk', 'curl'), 'apk add curl');
  });

  it('names Java by each distribution’s package', () => {
    assert.equal(installCommand('dnf', 'java'), 'sudo dnf install -y java-latest-openjdk-headless');
    assert.equal(installCommand('apt-get', 'java'), 'sudo apt-get install -y default-jre-headless');
    assert.equal(installCommand('brew', 'java'), 'brew install temurin');
  });

  it('installs ps and pgrep from procps-ng on Fedora, procps elsewhere', () => {
    assert.equal(installCommand('dnf', 'procps'), 'sudo dnf install -y procps-ng');
    assert.equal(installCommand('apt-get', 'procps'), 'sudo apt-get install -y procps');
  });

  it('says so instead of guessing when the package manager is unknown', () => {
    assert.equal(installCommand(undefined, 'lsof'), "Install lsof with your system's package manager");
  });
});

describe('dockerInstallHint', () => {
  it('tells a Fedora user that Podman is not enough', () => {
    assert.match(dockerInstallHint('dnf'), /Fedora ships Podman.*install\/fedora/);
    assert.equal(dockerInstallHint('apt-get'), 'See https://docs.docker.com/engine/install/');
  });
});

describe('onPath', () => {
  it('finds a file on PATH and ignores a directory of the same name', () => {
    const root = mkdtempSync(join(tmpdir(), 'vgate-path-'));
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a);
    mkdirSync(join(b, 'dnf'), { recursive: true });
    writeFileSync(join(a, 'dnf'), '#!/bin/sh\n');
    chmodSync(join(a, 'dnf'), 0o755);
    assert.ok(onPath('dnf', [b, a].join(delimiter)));
    assert.ok(!onPath('dnf', b));
    assert.ok(!onPath('apt-get', [a, b].join(delimiter)));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('pnpmInstallHint', () => {
  it('enables pnpm through corepack when this Node has it, and installs corepack first when not (Fedora)', () => {
    assert.equal(pnpmInstallHint(true, 'linux'), 'corepack enable pnpm');
    assert.match(pnpmInstallHint(false, 'linux'), /^sudo npm install -g corepack && sudo corepack enable pnpm/);
    assert.equal(pnpmInstallHint(false, 'darwin'), 'npm install -g corepack && corepack enable pnpm');
  });
});
