import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { detectShellProfile } from '../utils/shell-profile.js';

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
    it('falls back to .bashrc when none of the login-shell files exist', async () => {
      // SHELL is never set on Windows; this also proves the branch ignores
      // it even when something has set it.
      vi.stubEnv('SHELL', '/bin/zsh');
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
