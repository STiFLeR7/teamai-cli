import path from 'node:path';
import { pathExists, readFileSafe } from './fs.js';
import { getUserHome } from './home.js';
import { TEAMAI_ENV_START, TEAMAI_ENV_END } from '../types.js';

/** Every profile file `detectShellProfile()` could ever have resolved to, across platforms and CLI versions. */
export const SHELL_PROFILE_CANDIDATE_NAMES = ['.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'];

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

/**
 * True for a path a shell must read the Windows way: a drive-letter path
 * (`C:\...` or `C:/...`) or a UNC path (`\\server\share`).
 *
 * A POSIX path is deliberately excluded: there a backslash is an ordinary
 * filename character, not a separator, so collapsing every one of them would
 * silently point the shell at a different directory.
 *
 * Shape-based, not `path.sep`-based: `envShPath` was built by `path.join` on
 * whichever host wrote it, and a check that reads the *current* host's
 * separator is a no-op for a Windows-shaped path inspected from a POSIX host
 * (or vice versa) — the very thing this file's own tests need to exercise,
 * since CI only runs ubuntu/macos (#693 review round 4).
 */
export function isWindowsFormPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/** `envShPath` rewritten to the forward-slash form the generator writes, regardless of which host built it. */
function toGeneratedForm(envShPath: string): string {
  return isWindowsFormPath(envShPath) ? envShPath.replace(/\\/g, '/') : envShPath;
}

/**
 * Whether two paths name the same file on disk, independent of separator
 * style or (on Windows) case.
 *
 * Resolved with `path.win32`/`path.posix` explicitly rather than the ambient
 * `path` — both normalize `/` and `\` to one separator either way, but only
 * an explicit choice lets a test exercise the win32 branch on ubuntu/macos CI
 * (same reason `platform` is injectable elsewhere in this file). An override
 * written as `C:/Users/me/.profile` then compares equal to the generated
 * candidate `path.join(home, '.profile')`, which is backslash-separated on
 * win32. Windows filesystems are case-insensitive, so a case difference alone
 * must not make two paths look distinct there either (#693 review round 6).
 */
export function sameFile(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const resolve = platform === 'win32' ? path.win32.resolve : path.posix.resolve;
  const left = resolve(a);
  const right = resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Quote a string so it is safe to interpolate into a POSIX shell (bash/zsh/sh).
 * Wraps the value in single quotes and encodes any embedded single quote as
 * `'\''`, leaving all other characters (including `"`, `$`, `` ` ``, `\`)
 * literal. Used both when generating env.sh (env.ts) and when checking
 * whether a block on disk matches that same generated form.
 */
export function shellQuoteValue(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The TeamAI-managed block of a shell profile, or null when it is absent. */
export function extractEnvBlock(profileContent: string): string | null {
  const start = profileContent.indexOf(TEAMAI_ENV_START);
  if (start === -1) return null;
  const end = profileContent.indexOf(TEAMAI_ENV_END, start);
  return end === -1 ? profileContent.slice(start) : profileContent.slice(start, end);
}

/**
 * Whether an env block's `source` line actually points at `envShPath`.
 *
 * A profile can carry more than one teamai-managed block over its lifetime —
 * one per data home that ever injected into it (a different project scope,
 * or a stale one #682 left in a file the current platform/version no longer
 * resolves to). Matching on the marker alone would let one scope's uninstall
 * delete another scope's still-active block just because it also happens to
 * be a teamai block; comparing against this scope's own `env.sh` path scopes
 * the match to blocks this run is actually responsible for.
 *
 * The block is generated by joining paths with the platform separator, so on
 * Windows it carries backslashes. An unquoted `\` is an escape character in a
 * POSIX shell, so the generator rewrites it to `/` before writing — compare
 * against that same rewritten form, not the raw OS path.
 */
export function envBlockSourcesPath(block: string, envShPath: string): boolean {
  const posixPath = toGeneratedForm(envShPath);

  // The generator (generateShellBlock) always wraps the path in single
  // quotes via shellQuoteValue, which escapes an embedded apostrophe as
  // `'\''` — a path like `/home/O'Brien/.teamai/env.sh` never appears as a
  // contiguous raw substring in the block, only in this escaped form.
  if (block.includes(shellQuoteValue(posixPath))) return true;

  // Fall back to a raw/loosely-quoted match for anything not in the
  // generator's own format — e.g. #661's legacy unconverted backslash path,
  // which must still fail this check.
  if (!block.includes(posixPath)) return false;
  if (!/\s/.test(posixPath)) return true;
  return block.includes(`"${posixPath}"`) || block.includes(`'${posixPath}'`);
}

/**
 * Every on-disk spelling of `envShPath` a teamai block — current or legacy —
 * might contain.
 *
 * A CLI predating a given fix wrote the source path differently: the raw
 * OS-native form with unconverted backslashes (pre-#661), or the MSYS/Cygwin
 * drive form (`/d/Users/...`, what Git Bash's own `$PWD` shows) from a
 * locally-built or hand-patched install. Those blocks are broken — a POSIX
 * shell cannot read either form — but they still name this scope's own
 * `env.sh`, and a plain string match against only the current format leaves
 * them permanently invisible to both `doctor` and `uninstall` (#693 review).
 */
function candidateSpellings(envShPath: string): string[] {
  const spellings = new Set<string>([envShPath, toGeneratedForm(envShPath)]);

  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(envShPath);
  if (drive) {
    spellings.add(`/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`);
  }

  return [...spellings];
}

/**
 * Whether a block's `source` line names `envShPath` under any spelling
 * teamai has ever written it in — current or legacy, quoted or not,
 * forward- or back-slashed, drive- or MSYS-form — regardless of whether that
 * spelling actually loads in a shell.
 *
 * This answers a different question than `envBlockSourcesPath`: "does this
 * block belong to this scope" (ownership, for `uninstall` cleanup and for
 * `doctor` flagging a stray leftover) rather than "does this block actually
 * work" (correctness, for `doctor`'s #661 does-it-load check). A genuinely
 * broken legacy block still belongs to this scope and still needs to be
 * found and removed — conflating the two would make `doctor` stop reporting
 * a real #661-style break just because the path happens to match.
 */
export function envBlockReferencesDataHome(block: string, envShPath: string): boolean {
  for (const spelling of candidateSpellings(envShPath)) {
    if (
      block.includes(spelling)
      || block.includes(shellQuoteValue(spelling))
      || block.includes(`"${spelling}"`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve which shell profile file this scope's env block belongs in.
 *
 * Sticky by design: a candidate that already carries a block for this
 * scope's `env.sh` is reused, rather than re-running `detectShellProfile`'s
 * order-based fallback on every pull. Without this, Git for Windows' own
 * `/etc/profile.d/bash_profile.sh` changes which candidate *exists* between
 * two pulls out from under it: the first time a login shell starts with
 * `~/.bashrc` present but none of `~/.bash_profile`, `~/.bash_login` or
 * `~/.profile`, it auto-generates a `~/.bash_profile` that sources both —
 * not a symlink, a plain file containing `test -f ~/.bashrc && . ~/.bashrc`.
 * `detectShellProfile`'s order then prefers that newly-existing file on the
 * *next* pull, injecting a second block there and reporting the still-loading
 * `.bashrc` one (loaded transitively through the generated forwarder) as a
 * stray leftover, even though nothing ever stopped working (#693 review
 * round 7). Only when no candidate already owns a block — a genuinely first
 * pull — does the order-based fallback decide.
 */
export async function resolveActiveShellProfile(
  envShPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const home = getUserHome();
  for (const name of SHELL_PROFILE_CANDIDATE_NAMES) {
    const candidate = path.join(home, name);
    const content = await readFileSafe(candidate);
    const block = content ? extractEnvBlock(content) : null;
    if (block && envBlockReferencesDataHome(block, envShPath)) return candidate;
  }
  return detectShellProfile(platform);
}
