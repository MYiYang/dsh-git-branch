/**
 * Tests for the git layer of dsh-git-branch. Run with:
 *
 *   node --test test/
 *
 * The tests build throwaway repositories under the OS temp directory (unique
 * per run) and remove them afterwards; nothing here touches a real project.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkoutBranch, parseBranchRows, readStatus, requireDirectory, resolveGitBinary } from '../git.js'

/** Run one git command in `cwd`, returning trimmed stdout. */
function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=dsh-git-branch', '-c', 'user.email=test@example.invalid', '-C', cwd, ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim()
}

/** Create a repository with two commits on `main` and a second local branch. */
function makeRepository() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-branch-'))
  // `git init -b <name>` needs Git 2.28; create the branch explicitly instead
  // so the suite also runs on the 2.18-era Git that ships on this host.
  git(root, 'init', '-q')
  git(root, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'one\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'one')
  git(root, 'branch', 'feature/two')
  writeFileSync(join(root, 'README.md'), 'two\n')
  git(root, 'commit', '-q', '-am', 'two')
  return root
}

/**
 * A repository with a real remote: `main` is one commit ahead and one behind
 * `origin/main`, `feature/two` is a local branch without an upstream, and the
 * remote has both `origin/main` and `origin/feature/two` plus the symbolic
 * `origin/HEAD` alias.
 */
function makeRepositoryWithRemote() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-git-branch-remote-'))
  const root = join(base, 'repo')
  const bare = join(base, 'remote.git')
  const other = join(base, 'other')
  git(base, 'init', '-q', root)
  git(root, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'one\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'one')
  git(root, 'init', '-q', '--bare', bare)
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(root, 'remote', 'add', 'origin', bare)
  git(root, 'push', '-q', '-u', 'origin', 'main')
  git(root, 'branch', 'feature/two')
  git(root, 'push', '-q', 'origin', 'feature/two')
  // Local ahead by one commit.
  writeFileSync(join(root, 'README.md'), 'two\n')
  git(root, 'commit', '-q', '-am', 'two')
  // Remote ahead by one commit, pushed from a second clone.
  git(base, 'clone', '-q', '-b', 'main', bare, other)
  writeFileSync(join(other, 'remote.txt'), 'remote\n')
  git(other, 'add', 'remote.txt')
  git(other, 'commit', '-q', '-m', 'remote three')
  git(other, 'push', '-q', 'origin', 'main')
  git(root, 'fetch', '-q', 'origin')
  git(root, 'remote', 'set-head', 'origin', '-a')
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('readStatus reports the branch, repository root and local branches', async () => {
  const root = makeRepository()
  try {
    const status = await readStatus(root, { binary: 'git' })
    assert.equal(status.isRepo, true)
    assert.equal(status.branch, 'main')
    assert.equal(status.detached, false)
    assert.equal(typeof status.commit, 'string')
    assert.deepEqual(status.branches.map(branch => `${branch.kind}:${branch.name}`), ['local:feature/two', 'local:main'])
    const current = status.branches.find(branch => branch.name === 'main')
    assert.equal(current.current, true)
    assert.equal(current.lastCommit.subject, 'two')
    assert.equal(typeof current.lastCommit.short, 'string')
    assert.equal(status.branches.find(branch => branch.name === 'feature/two').current, false)
    // The root git reports is the repository, not the directory we passed.
    assert.equal(status.root.replaceAll('\\', '/').toLowerCase(), root.replaceAll('\\', '/').toLowerCase())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readStatus lists remote branches and leaves local-only columns absent', async () => {
  const { root, cleanup } = makeRepositoryWithRemote()
  try {
    const status = await readStatus(root, { binary: 'git' })
    const local = status.branches.filter(branch => branch.kind === 'local')
    const remote = status.branches.filter(branch => branch.kind === 'remote')
    // Local rows still lead, remote rows follow.
    assert.deepEqual(status.branches.slice(0, local.length).map(branch => branch.kind), local.map(branch => branch.kind))
    assert.deepEqual(local.map(branch => branch.name), ['feature/two', 'main'])
    assert.deepEqual(remote.map(branch => branch.name), ['origin/feature/two', 'origin/main'])

    const main = local.find(branch => branch.name === 'main')
    assert.equal(main.upstream, 'origin/main')
    assert.equal(main.ahead, 1)
    assert.equal(main.behind, 1)
    assert.equal(main.lastCommit.subject, 'two')

    const feature = local.find(branch => branch.name === 'feature/two')
    assert.equal('upstream' in feature, false)
    assert.equal('ahead' in feature, false)
    assert.equal('behind' in feature, false)

    for (const branch of remote) {
      // The remote-tracking ref has a last commit, but no upstream/ahead/behind.
      assert.equal('upstream' in branch, false)
      assert.equal('ahead' in branch, false)
      assert.equal('behind' in branch, false)
      assert.equal('current' in branch, false)
      assert.equal(typeof branch.lastCommit.short, 'string')
      assert.equal(typeof branch.lastCommit.subject, 'string')
    }
    assert.equal(remote.find(branch => branch.name === 'origin/main').lastCommit.subject, 'remote three')
    // The symbolic origin/HEAD alias is not a branch of its own.
    assert.equal(remote.some(branch => branch.name === 'origin/HEAD'), false)
  } finally {
    cleanup()
  }
})

test('parseBranchRows ignores symbolic refs and malformed records', () => {
  const rows = parseBranchRows([
    ['refs/heads/main', 'main', '', 'origin/main', '[ahead 2, behind 3]', 'abc1234', '100', 'subject', '*'].join('\0'),
    ['refs/remotes/origin/HEAD', 'origin/HEAD', 'refs/remotes/origin/main', '', '', 'abc1234', '100', 'subject', ' '].join('\0'),
    ['refs/remotes/origin/main', 'origin/main', '', '', '', 'abc1234', '100', 'subject', ' '].join('\0'),
    'short',
    '',
  ].join('\n'))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    name: 'main',
    kind: 'local',
    current: true,
    upstream: 'origin/main',
    ahead: 2,
    behind: 3,
    lastCommit: { short: 'abc1234', time: 100, subject: 'subject' },
  })
  assert.deepEqual(rows[1], {
    name: 'origin/main',
    kind: 'remote',
    lastCommit: { short: 'abc1234', time: 100, subject: 'subject' },
  })
})

test('readStatus treats a directory outside any repository as not a repo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-branch-plain-'))
  try {
    const status = await readStatus(root, { binary: 'git' })
    assert.deepEqual(status, { isRepo: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkoutBranch switches between local branches and reports the new status', async () => {
  const root = makeRepository()
  try {
    const switched = await checkoutBranch(root, 'feature/two', { binary: 'git' })
    assert.equal(switched.branch, 'feature/two')
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'feature/two')
    const back = await checkoutBranch(root, 'main', { binary: 'git' })
    assert.equal(back.branch, 'main')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkoutBranch rejects a branch the repository does not have', async () => {
  const root = makeRepository()
  try {
    await assert.rejects(
      checkoutBranch(root, '--orphan', { binary: 'git' }),
      error => error.code === 'unknown-branch',
    )
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'main')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkoutBranch refuses a remote-tracking branch instead of detaching HEAD', async () => {
  const { root, cleanup } = makeRepositoryWithRemote()
  try {
    await assert.rejects(
      checkoutBranch(root, 'origin/main', { binary: 'git' }),
      error => error.code === 'unknown-branch',
    )
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'main')
  } finally {
    cleanup()
  }
})

test('readStatus reports a detached HEAD with its short commit', async () => {
  const root = makeRepository()
  try {
    const head = git(root, 'rev-parse', '--short', 'HEAD')
    git(root, 'checkout', '-q', '--detach')
    const status = await readStatus(root, { binary: 'git' })
    assert.equal(status.isRepo, true)
    assert.equal(status.detached, true)
    assert.equal(status.commit, head)
    assert.equal(status.branch, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('requireDirectory rejects a directory that does not exist', () => {
  assert.throws(
    () => requireDirectory(join(tmpdir(), 'dsh-git-branch-does-not-exist')),
    error => error.code === 'bad-directory',
  )
})

test('resolveGitBinary returns a git this process can actually execute', async () => {
  // The result must not be an unrunnable PATH shim such as a Windows git.bat:
  // this probe is exactly what keeps every repository from looking absent.
  const binary = await resolveGitBinary(undefined)
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
  assert.match(version, /^git version /)
})
