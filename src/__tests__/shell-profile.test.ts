import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import {
  detectShellProfile,
  envBlockSourcesPath,
  envBlockReferencesDataHome,
  resolveActiveShellProfile,
  sameFile,
  shellQuoteValue,
} from '../utils/shell-profile.js';

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

// Regression (#693 review round 7): Git for Windows' own
// /etc/profile.d/bash_profile.sh auto-generates ~/.bash_profile the first
// time a login shell starts with ~/.bashrc present but none of
// ~/.bash_profile, ~/.bash_login or ~/.profile — a plain file containing
// `test -f ~/.bashrc && . ~/.bashrc`, not a symlink. detectShellProfile's
// order then prefers that newly-existing file on the next pull, so the
// resolver must stick to wherever this scope's block already lives instead
// of re-running the order-based fallback every time.
describe('resolveActiveShellProfile', () => {
  let tmpDir: string;
  let homeDir: string;
  let envShPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-active-shell-profile-test-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(homeDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '');
    envShPath = path.join(homeDir, '.teamai', 'env.sh');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  function teamaiBlock(): string {
    const posix = envShPath.split(path.sep).join('/');
    return `# [teamai:env:start]\n# DO NOT EDIT\n[ -f ${shellQuoteValue(posix)} ] && source ${shellQuoteValue(posix)}\n# [teamai:env:end]\n`;
  }

  it('sticks to .bashrc even after Git for Windows auto-generates a forwarding .bash_profile', async () => {
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    // The exact content Git for Windows' bash_profile.sh generates — a plain
    // forwarding file, never a symlink, and carries no teamai markers.
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      '# generated by Git for Windows\ntest -f ~/.profile && . ~/.profile\ntest -f ~/.bashrc && . ~/.bashrc\n',
    );
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  // Regression (#693 review round 8): the original version of this resolver
  // scanned every candidate for a matching block regardless of whether the
  // order-based pick could ever reach it, so a stale pre-#682 block sitting
  // in `.bashrc` outranked a genuinely unwritten, currently-read `.profile`
  // — silently reintroducing #682 for exactly the installs this PR fixes,
  // with `doctor` unable to catch it since the stale block is well-formed
  // where it sits. The order-based pick's own content must name a candidate
  // before that candidate's block is ever preferred over it.
  it('does not stick to a stale block in a candidate the order-based pick never reads (#682 upgrade case)', async () => {
    // The exact #682 repro: .bashrc present, .bash_profile/.bash_login absent,
    // .profile present — order-based detection reads .profile, never .bashrc,
    // and .profile does not itself source .bashrc.
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    await fse.writeFile(path.join(homeDir, '.profile'), '# just a profile, unrelated to .bashrc\n');
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.profile'));
  });

  it('prefers the order-based pick over an unrelated candidate that merely carries a block', async () => {
    // .bash_profile exists (order-based winner) but has content unrelated to
    // any other candidate; a block sitting in .profile must not be preferred
    // just because it exists somewhere in the candidate list.
    await fse.writeFile(path.join(homeDir, '.bash_profile'), 'unrelated content\n');
    await fse.writeFile(path.join(homeDir, '.profile'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('falls back to order-based detection when no candidate owns a block yet (first pull)', async () => {
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  it('does not stick to a different scope\'s block; falls back to order-based detection', async () => {
    const otherEnvSh = path.join(homeDir, 'other-project', '.teamai', 'env.sh');
    const otherPosix = otherEnvSh.split(path.sep).join('/');
    await fse.writeFile(
      path.join(homeDir, '.bashrc'),
      `# [teamai:env:start]\n# DO NOT EDIT\n[ -f ${shellQuoteValue(otherPosix)} ] && source ${shellQuoteValue(otherPosix)}\n# [teamai:env:end]\n`,
    );
    await fse.writeFile(path.join(homeDir, '.profile'), '');
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.profile'));
  });

  // Regression (#693 review round 9): a bare substring search matched a
  // comment mentioning the filename (never executed) and a different,
  // longer-named file sharing the same prefix.
  it('does not stick to a candidate merely mentioned in a comment', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      '# source ~/.bashrc\nunrelated content\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not stick to a different, longer-named file sharing the same prefix', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'source ~/.bashrc.local\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  // Regression (#693 review round 9): the resolver only followed one hop of
  // sourcing, so a chain like .bash_profile -> .profile -> .bashrc (the
  // common Debian .profile pattern, sourcing .bashrc for interactive
  // shells) missed a block two hops away and would have injected a
  // duplicate into .bash_profile instead of reusing .bashrc.
  it('follows a two-hop sourcing chain to reach a block (.bash_profile -> .profile -> .bashrc)', async () => {
    await fse.writeFile(path.join(homeDir, '.bash_profile'), '. ~/.profile\n');
    await fse.writeFile(path.join(homeDir, '.profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n');
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  it('does not hang on a reference cycle and falls back to the order-based pick', async () => {
    await fse.writeFile(path.join(homeDir, '.bash_profile'), 'source ~/.profile\n');
    await fse.writeFile(path.join(homeDir, '.profile'), 'source ~/.bash_profile\n');
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  // Regression (#693 review round 10): the resolver committed to the first
  // referenced candidate in SHELL_PROFILE_CANDIDATE_NAMES's fixed order and
  // gave up if that branch was a dead end, instead of trying every candidate
  // the active pick actually references. .bash_profile sourcing both
  // .bashrc and .profile is exactly Git for Windows' own generated content
  // — .bashrc sorts earlier in the candidate list, so a dead .bashrc branch
  // would previously stop the search before it ever reached .profile.
  it('tries every referenced candidate, not just the first in priority order', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'test -f ~/.bashrc && . ~/.bashrc\ntest -f ~/.profile && . ~/.profile\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), '# no block here\n');
    await fse.writeFile(path.join(homeDir, '.profile'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.profile'));
  });

  // Regression (#693 review round 10): splitting on `||` treated its
  // right-hand side as unconditionally reached, but it only runs if the left
  // side fails — undetermined here. A stale block behind `||` must not win
  // over a working one the left side already reaches.
  it('does not treat the right side of || as reachable', async () => {
    // Both .profile and .bashrc carry a valid block for this scope; the
    // point is which one the resolver *reaches* through the || line, not
    // which one has a well-formed block. .bashrc sorts earlier than
    // .profile in SHELL_PROFILE_CANDIDATE_NAMES, so a naive "any referenced
    // candidate in priority order" search would wrongly land on .bashrc even
    // though it only runs if the left side (.profile) fails.
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'source ~/.profile || source ~/.bashrc\n',
    );
    await fse.writeFile(path.join(homeDir, '.profile'), teamaiBlock());
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.profile'));
  });

  // Regression (#693 review round 11): the right side of `||` genuinely is
  // guaranteed to run when the left side's own target file does not exist —
  // the one case this scanner can verify without a real shell. Failing to
  // recognize it falls back to injecting a duplicate, which round 10's fix
  // was meant to avoid for exactly this shape of line.
  it('does treat the right side of || as reachable when the left side\'s target is missing', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'source ~/.profile || source ~/.bashrc\n',
    );
    // .profile is deliberately absent.
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  // Regression (#693 review round 11): `&&` only establishes reachability
  // when this scanner can independently verify the guarding condition — the
  // self-referential existence test. A condition testing anything else
  // (here, an environment variable) is not verifiable, so a stale block
  // behind it must not outrank a genuinely unwritten, currently-read file.
  it('does not treat a non-existence && condition as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      '[ "$TERM_PROGRAM" = vscode ] && source ~/.bashrc\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  // Regression (#693 review round 11): a source line's own text looks
  // identical whether it sits at top level or three lines inside an `if`
  // block this scanner cannot evaluate. Nothing inside an `if` is trusted,
  // conditional or not, so a block only reachable through one is not
  // preferred over the order-based pick.
  it('does not treat a source nested inside an if block as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'if [ -n "$BASH_VERSION" ]; then\n  . ~/.bashrc\nfi\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  // Regression (#693 review round 12): a shell never tilde-expands inside
  // any quotes and never variable-expands inside single quotes, so
  // `source "~/.bashrc"` and `source '$HOME/.bashrc'` both source a
  // literal, near-certainly nonexistent path — a reference that "looks
  // right" but would never actually run must not be trusted.
  it('does not treat an invalidly-quoted reference as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'source "~/.bashrc"\nsource \'$HOME/.bashrc\'\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does treat a double-quoted $HOME reference as reachable', async () => {
    await fse.writeFile(path.join(homeDir, '.bash_profile'), 'source "$HOME/.bashrc"\n');
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  // Regression (#693 review round 12): `&&`'s left side is always attempted,
  // the same as `||`'s — a trailing unrelated command after it (`&& echo
  // ready`) does not make the source itself conditional.
  it('treats the left side of && as reachable even when the right side is unrelated', async () => {
    await fse.writeFile(path.join(homeDir, '.bash_profile'), 'source ~/.bashrc && echo ready\n');
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  // Regression (#693 review round 12): only `if` nesting was tracked, so a
  // source inside an uncalled function, a non-selected `case` arm, or a
  // loop body — none of them guaranteed to run any more than an `if` body
  // is — was wrongly treated as unconditional.
  it('does not treat a source inside a function body as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'my_func() {\n  . ~/.bashrc\n}\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not treat a source inside a case arm as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'case "$-" in\n  *i*) . ~/.bashrc ;;\nesac\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not treat a source inside a loop body as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'for f in ~/.bashrc; do\n  . ~/.bashrc\ndone\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not treat a source after a backslash-continued unrelated condition as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      '[ "$TERM_PROGRAM" = vscode ] && \\\nsource ~/.bashrc\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not stop recognizing later unconditional sources after a one-line if/then/fi', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'if [ -f ~/.zshrc ]; then . ~/.zshrc; fi\nsource ~/.bashrc\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  it('does not stop recognizing later unconditional sources after a two-line function definition', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'my_func()\n{\n  echo hi\n}\nsource ~/.bashrc\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  it('treats an existence-gated source as reachable even with further &&-chained commands', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      '[ -f ~/.bashrc ] && . ~/.bashrc && export READY=1\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  it('does not treat a source inside a comment after a semicolon as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      ': # old setup; source ~/.bashrc\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not treat a source inside a heredoc body as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      "cat <<'EOF'\nsource ~/.bashrc\nEOF\n",
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not treat a quoted separator as a real statement boundary', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      "printf '%s\\n' 'x; source ~/.bashrc; y'\n",
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not treat a source inside a subshell as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      '(\n  source ~/.bashrc\n)\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not treat a source after an unconditional return as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'return\nsource ~/.bashrc\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not treat a source after an unconditional exit as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'exit 0\nsource ~/.bashrc\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('treats a source with a trailing redirection as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'source ~/.bashrc 2>/dev/null\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  it('treats the last operand of a three-way || fallback as reachable when the earlier ones are missing', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'source ~/.profile || source ~/.bash_login || source ~/.bashrc\n',
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  it('does not treat the last operand of a three-way || fallback as reachable when an earlier one exists', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      'source ~/.profile || source ~/.bash_login || source ~/.bashrc\n',
    );
    await fse.writeFile(path.join(homeDir, '.profile'), '# unrelated\n');
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
  });

  it('does not treat a source inside the second of two heredocs on one command as reachable', async () => {
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      "cat <<A <<B\nfirst\nA\nsource ~/.bashrc\nB\n",
    );
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bash_profile'));
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

// Regression (#693 hardware review by @CarlosWonMore): envBlockSourcesPath
// only recognizes the current writing format. A block from a pre-#661 or
// pre-#682 CLI names the same env.sh under a different, broken spelling —
// still owned by this scope, and uninstall/doctor's "is there a stray
// leftover" check must still find it to clean it up or flag it.
describe('envBlockReferencesDataHome', () => {
  it('matches the current (quoted, forward-slash) form', () => {
    const envShPath = 'D:\\Users\\me\\.teamai\\env.sh';
    const posix = envShPath.split('\\').join('/');
    const block = `[ -f ${shellQuoteValue(posix)} ] && source ${shellQuoteValue(posix)}`;
    expect(envBlockReferencesDataHome(block, envShPath)).toBe(true);
  });

  it('matches a pre-#661 raw, unquoted, unconverted Windows path', () => {
    const envShPath = 'D:\\Users\\me\\.teamai\\env.sh';
    const block = `[ -f ${envShPath} ] && source ${envShPath}`;
    expect(envBlockReferencesDataHome(block, envShPath)).toBe(true);
  });

  it('matches the MSYS/Cygwin drive form (/d/Users/...) a locally-patched build wrote', () => {
    const envShPath = 'D:\\Users\\me\\.teamai\\env.sh';
    const msysForm = '/d/Users/me/.teamai/env.sh';
    const block = `[ -f ${msysForm} ] && source ${msysForm}`;
    expect(envBlockReferencesDataHome(block, envShPath)).toBe(true);
  });

  it('does not match a different scope\'s env.sh', () => {
    const envShPath = 'D:\\Users\\me\\.teamai\\env.sh';
    const otherPosix = 'D:/some-other-project/.teamai/env.sh';
    const block = `[ -f ${shellQuoteValue(otherPosix)} ] && source ${shellQuoteValue(otherPosix)}`;
    expect(envBlockReferencesDataHome(block, envShPath)).toBe(false);
  });
});

// Regression (#693 review round 6): the stray-block scan compares a
// user-supplied `shellProfilePath` override against a `path.join`-built
// candidate. A raw `===` made a valid override a false positive "stray copy
// of itself" whenever the two spellings of the same path did not match
// byte-for-byte — an override with forward slashes, or (Windows only) a
// different case.
describe('sameFile', () => {
  it('matches a forward-slash override against a backslash candidate on win32', () => {
    expect(sameFile('C:/Users/me/.profile', 'C:\\Users\\me\\.profile', 'win32')).toBe(true);
  });

  it('matches regardless of case on win32', () => {
    expect(sameFile('C:\\Users\\Me\\.profile', 'c:\\users\\me\\.profile', 'win32')).toBe(true);
  });

  it('does not match a genuinely different file on win32', () => {
    expect(sameFile('C:\\Users\\me\\.profile', 'C:\\Users\\me\\.bashrc', 'win32')).toBe(false);
  });

  it('is case-sensitive on posix, where a case difference is a different file', () => {
    expect(sameFile('/home/me/.profile', '/home/me/.PROFILE', 'linux')).toBe(false);
  });

  it('matches identical posix paths', () => {
    expect(sameFile('/home/me/.profile', '/home/me/.profile', 'linux')).toBe(true);
  });
});
