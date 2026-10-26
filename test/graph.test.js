/**
 * Tests for the commit-graph layer of dsh-git-branch: the pure parser and lane
 * layout, plus one real-repository smoke test. Run with:
 *
 *   node --test test/graph.test.js
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FIELD_SEP, layoutCommits, parseCommitLog, parseDecoration } from '../graph.js'
import { readGraph } from '../git.js'

/** Build one `git log` record line the way the Host formats it. */
function record({ hash, short, parents = '', author = 'someone', time = 0, subject = '', decoration = '' }) {
  return [hash, short, parents, author, String(time), subject, decoration].join(FIELD_SEP)
}

test('parseCommitLog splits records and decorations', () => {
  const stdout = [
    record({
      hash: 'f0e202f1a430a1cbfa8039d88b88064ce999ba1f',
      short: 'f0e202f',
      parents: '2874e2cc0352cb2613619c74cb4851721c756b55',
      author: 'Ada',
      time: 1792979279,
      subject: 'second commit',
      decoration: 'HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD',
    }),
    record({ hash: '2874e2cc0352cb2613619c74cb4851721c756b55', short: '2874e2c', subject: 'first commit', decoration: 'refs/remotes/origin/feature/two, refs/heads/feature/two' }),
    '',
  ].join('\n')

  const commits = parseCommitLog(stdout)
  assert.equal(commits.length, 2)
  assert.deepEqual(commits[0].parents, ['2874e2cc0352cb2613619c74cb4851721c756b55'])
  assert.equal(commits[0].author, 'Ada')
  assert.equal(commits[0].time, 1792979279)
  assert.equal(commits[0].subject, 'second commit')
  assert.equal(commits[0].head, true)
  assert.deepEqual(
    commits[0].refs.map(ref => `${ref.kind}:${ref.name}:${ref.head}`),
    ['local:main:true', 'tag:v1:false', 'remote:origin/main:false'],
  )
  assert.deepEqual(commits[1].refs.map(ref => `${ref.kind}:${ref.name}`), ['remote:origin/feature/two', 'local:feature/two'])
  assert.equal(commits[1].head, false)
})

test('parseDecoration keeps a detached HEAD and drops the remote HEAD alias', () => {
  const detached = parseDecoration('HEAD, refs/remotes/origin/HEAD, refs/remotes/origin/main')
  assert.equal(detached.head, true)
  assert.deepEqual(detached.refs.map(ref => ref.name), ['origin/main'])
  assert.deepEqual(parseDecoration('').refs, [])
  // Non-branch refs keep a readable name instead of the full ref path.
  assert.deepEqual(parseDecoration('refs/stash').refs, [{ name: 'stash', kind: 'other', head: false }])
})

test('layoutCommits draws a straight lane for a linear history', () => {
  const commits = [
    { hash: 'ccc', parents: ['bbb'] },
    { hash: 'bbb', parents: ['aaa'] },
    { hash: 'aaa', parents: [] },
  ]
  const rows = layoutCommits(commits)
  assert.deepEqual(rows.map(row => row.lane), [0, 0, 0])
  assert.deepEqual(rows.map(row => row.nodeFromTop), [false, true, true])
  assert.deepEqual(rows[0].links, [{ from: null, to: 0, color: 0 }])
  assert.deepEqual(rows[2].links, [])
  assert.equal(rows[0].laneCount, 1)
})

test('layoutCommits opens a second lane for a merge and folds it back', () => {
  const commits = [
    { hash: 'm', parents: ['p1', 'p2'] },
    { hash: 'p1', parents: ['base'] },
    { hash: 'p2', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]
  const rows = layoutCommits(commits)
  // The merge dot stays in lane 0; its second parent opens lane 1.
  assert.equal(rows[0].lane, 0)
  assert.deepEqual(rows[0].links.map(link => [link.from, link.to]), [[null, 0], [null, 1]])
  assert.equal(rows[0].laneCount, 2)
  // p1 keeps lane 0 while p2's lane runs through the row untouched.
  assert.deepEqual(rows[1].links.map(link => [link.from, link.to]), [[1, 1], [null, 0]])
  // p2 merges back into base's lane 0 when it is reached.
  assert.equal(rows[2].lane, 1)
  assert.deepEqual(rows[2].links.map(link => [link.from, link.to]), [[0, 0], [null, 0]])
  assert.equal(rows[2].nodeFromTop, true)
  // base closes the last lane.
  assert.equal(rows[3].lane, 0)
  assert.deepEqual(rows[3].links, [])
})

test('layoutCommits keeps the first parent in the dot lane when a lower lane is free', () => {
  const commits = [
    { hash: 'a', parents: ['b'] },
    { hash: 'b', parents: ['c', 'd'] },
    { hash: 'c', parents: [] },
    { hash: 'd', parents: ['e'] },
    { hash: 'e', parents: [] },
  ]
  const rows = layoutCommits(commits)
  // d sits on lane 1 and its first parent e must continue there, not jump back
  // to the lane c freed above.
  const d = rows.find(row => row.hash === 'd')
  assert.equal(d.lane, 1)
  assert.deepEqual(d.links, [{ from: null, to: 1, color: d.nodeColor }])
})

test('layoutCommits ignores parents outside the fetched window', () => {
  const rows = layoutCommits([{ hash: 'ccc', parents: ['missing'] }])
  assert.deepEqual(rows[0].links, [])
  assert.equal(rows[0].laneCount, 1)
})

test('layoutCommits keeps the graph width under the lane cap', () => {
  const commits = [
    { hash: 'm', parents: ['a', 'b', 'c', 'd'] },
    { hash: 'a', parents: [] },
    { hash: 'b', parents: [] },
    { hash: 'c', parents: [] },
    { hash: 'd', parents: [] },
  ]
  const rows = layoutCommits(commits, { maxLanes: 2 })
  for (const row of rows) {
    assert.ok(row.lane < 2)
    assert.ok(row.laneCount <= 2)
    for (const link of row.links) {
      assert.ok((link.from ?? 0) < 2)
      assert.ok((link.to ?? 0) < 2)
    }
  }
})

/** One git command in `cwd`, returning trimmed stdout. */
function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=dsh-git-branch', '-c', 'user.email=test@example.invalid', '-C', cwd, ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim()
}

/** A repository with a merge commit and a remote-tracking branch. */
function makeMergedRepository() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-branch-graph-'))
  git(root, 'init', '-q')
  git(root, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'one\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'base')
  git(root, 'checkout', '-q', '-b', 'topic')
  writeFileSync(join(root, 'topic.txt'), 'topic\n')
  git(root, 'add', 'topic.txt')
  git(root, 'commit', '-q', '-m', 'topic work')
  git(root, 'checkout', '-q', 'main')
  writeFileSync(join(root, 'README.md'), 'two\n')
  git(root, 'commit', '-q', '-am', 'main work')
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge topic', 'topic')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  return root
}

test('readGraph lays out a real merge and exposes its refs', async () => {
  const root = makeMergedRepository()
  try {
    const graph = await readGraph(root, { binary: 'git' })
    assert.equal(graph.root.replaceAll('\\', '/').toLowerCase(), root.replaceAll('\\', '/').toLowerCase())
    assert.equal(graph.rows.length, 4)
    const merge = graph.rows[0]
    assert.equal(merge.subject, 'merge topic')
    assert.equal(merge.parents.length, 2)
    assert.equal(merge.head, true)
    assert.deepEqual(merge.refs.map(ref => `${ref.kind}:${ref.name}`), ['local:main', 'remote:origin/main'])
    assert.deepEqual(merge.links.filter(link => link.from === null).length, 2)
    assert.ok(graph.rows.some(row => row.laneCount >= 2))
    // Every row keeps its dot inside the lanes it reports.
    for (const row of graph.rows) {
      assert.ok(row.lane >= 0 && row.lane < Math.max(1, row.laneCount))
      for (const link of row.links) {
        if (link.from !== null) assert.ok(link.from < row.laneCount)
        if (link.to !== null) assert.ok(link.to < row.laneCount)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readGraph answers an empty graph for a repository without commits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-branch-graph-empty-'))
  try {
    git(root, 'init', '-q')
    const graph = await readGraph(root, { binary: 'git' })
    assert.deepEqual(graph.rows, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
