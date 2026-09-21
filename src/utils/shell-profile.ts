import path from 'node:path';
import { pathExists } from './fs.js';
import { getUserHome } from './home.js';

/**
 * Detect the shell profile file `teamai`'s env block should be injected into.
 *
 * Shared by `EnvHandler.detectShellProfile` (resources/env.ts) and
 * `teamai uninstall` so both resolve the same file — a second, independent
 * copy previously drifted (#682) and left `uninstall` unable to find the
 * block `pull` had written.
 *
 * `platform` is injectable because CI only runs ubuntu/macos: hardcoding
 * `process.platform` would leave the Windows branch permanently uncovered,
 * which is how #682 went unnoticed. Same pattern as `resolveCliPath` in
 * `utils/cli-path.ts`.
 *
 * `SHELL` is checked before the platform branch, on every platform: a zsh
 * installed via MSYS2/Cygwin on Windows sets `SHELL` just like it does on
 * POSIX, and native Windows Node still reports `platform === 'win32'` in
 * that case. Deferring to the Windows branch unconditionally would silently
 * stop loading `.zshrc` for that setup, even though `SHELL`-based detection
 * already got it right.
 *
 * On Windows, when `SHELL` does not indicate zsh, `SHELL` is otherwise never
 * set, so the POSIX logic below always fell back to `~/.bashrc` — but Git
 * Bash starts as a *login* shell, which reads `~/.bash_profile`,
 * `~/.bash_login` or `~/.profile`, never `~/.bashrc`. The block was written
 * correctly and looked correct on inspection, yet no shell ever sourced it.
 * This mirrors Git for Windows' own fallback in
 * `/etc/profile.d/bash_profile.sh`: it only generates a `.bash_profile` that
 * sources `.bashrc` when none of the three files exist, so preferring an
 * existing one of them — and falling back to `.bashrc` only when none exist —
 * agrees with what Git for Windows itself will end up sourcing.
 */
export async function detectShellProfile(
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const home = getUserHome();
  const shell = process.env.SHELL ?? '';

  if (shell.includes('zsh')) {
    return path.join(home, '.zshrc');
  }

  if (platform === 'win32') {
    for (const name of ['.bash_profile', '.bash_login', '.profile']) {
      const candidate = path.join(home, name);
      if (await pathExists(candidate)) return candidate;
    }
  }

  return path.join(home, '.bashrc');
}
