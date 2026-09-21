import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { detectShellProfile, envBlockSourcesPath, shellQuoteValue } from '../utils/shell-profile.js';

/**
 * `platform` is passed explicitly to every call below rather than relying on
 * `process.platform` (same convention as `resolveCliPath` in cli-path.ts):
 * CI only runs ubuntu/macos, so a test that trusted the host platform would
 * never exercise the win32 branch — which is exactly how #682 went unnoticed.
 */
describe('detectShellProfile', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-shell-profile-test-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(homeDir);
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  describe('POSIX (darwin/linux)', () => {
    it('returns .zshrc when SHELL is zsh', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      expect(await detectShellProfile('linux')).toBe(path.join(homeDir, '.zshrc'));
    });

    it('returns .bashrc when SHELL is bash', async () => {
      vi.stubEnv('SHELL', '/bin/bash');
      expect(await detectShellProfile('darwin')).toBe(path.join(homeDir, '.bashrc'));
    });

    it('returns .bashrc when SHELL is unset', async () => {
      vi.stubEnv('SHELL', '');
      expect(await detectShellProfile('linux')).toBe(path.join(homeDir, '.bashrc'));
    });
  });

  describe('Windows (win32)', () => {
    it('returns .zshrc when SHELL is zsh, even on win32 (MSYS2/Cygwin zsh)', async () => {
      // A zsh installed via MSYS2/Cygwin sets SHELL just like it does on
      // POSIX, while native Windows Node still reports platform === win32.
      // SHELL-based detection must win here, or this setup regresses.
      vi.stubEnv('SHELL', '/usr/bin/zsh');
      expect(await detectShellProfile('win32')).toBe(path.join(homeDir, '.zshrc'));
    });

    it('falls back to .bashrc when SHELL is unset and none of the login-shell files exist', async () => {
      vi.stubEnv('SHELL', '');
      expect(await detectShellProfile('win32')).toBe(path.join(homeDir, '.bashrc'));
    });

    it('prefers an existing .bash_profile over .bash_login, .profile and .bashrc', async () => {
      await fse.writeFile(path.join(homeDir, '.bash_profile'), '');
      await fse.writeFile(path.join(homeDir, '.bash_login'), '');
      await fse.writeFile(path.join(homeDir, '.profile'), '');
      await fse.writeFile(path.join(homeDir, '.bashrc'), '');
      expect(await detectShellProfile('win32')).toBe(path.join(homeDir, '.bash_profile'));
    });

    it('prefers .bash_login over .profile and .bashrc when .bash_profile is absent', async () => {
      await fse.writeFile(path.join(homeDir, '.bash_login'), '');
      await fse.writeFile(path.join(homeDir, '.profile'), '');
      await fse.writeFile(path.join(homeDir, '.bashrc'), '');
      expect(await detectShellProfile('win32')).toBe(path.join(homeDir, '.bash_login'));
    });

    it('falls back to .profile when only it exists — the case from #682', async () => {
      // Reported setup: ~/.bashrc present, ~/.bash_profile absent, ~/.profile
      // present. Git Bash starts as a login shell and never reads .bashrc.
      await fse.writeFile(path.join(homeDir, '.bashrc'), '');
      await fse.writeFile(path.join(homeDir, '.profile'), '');
      expect(await detectShellProfile('win32')).toBe(path.join(homeDir, '.profile'));
    });
  });
});

describe('envBlockSourcesPath', () => {
  it('matches a plain path in the generator\'s single-quoted form', () => {
    const envShPath = '/home/user/.teamai/env.sh';
    const block = `[ -f ${shellQuoteValue(envShPath)} ] && source ${shellQuoteValue(envShPath)}`;
    expect(envBlockSourcesPath(block, envShPath)).toBe(true);
  });

  // Regression (#693 review): shellQuoteValue escapes an embedded apostrophe
  // as `'\''`, so a raw substring check for `/home/O'Brien/...` never matches
  // — the block only ever contains the escaped form.
  it('matches a home path containing an apostrophe (generator escapes it as \'\\\'\')', () => {
    const envShPath = "/home/O'Brien/.teamai/env.sh";
    const block = `[ -f ${shellQuoteValue(envShPath)} ] && source ${shellQuoteValue(envShPath)}`;
    expect(block).toContain(String.raw`O'\''Brien`);
    expect(envBlockSourcesPath(block, envShPath)).toBe(true);
  });

  it('does not match a different path', () => {
    const block = `[ -f ${shellQuoteValue('/home/user/.teamai/env.sh')} ] && source ${shellQuoteValue('/home/user/.teamai/env.sh')}`;
    expect(envBlockSourcesPath(block, '/home/other/.teamai/env.sh')).toBe(false);
  });

  it('does not match an unquoted, unconverted Windows path (#661)', () => {
    const envShPath = 'C:/Users/me/.teamai/env.sh';
    const windowsForm = envShPath.replace(/\//g, '\\');
    const block = `[ -f ${windowsForm} ] && source ${windowsForm}`;
    expect(envBlockSourcesPath(block, envShPath)).toBe(false);
  });
});
