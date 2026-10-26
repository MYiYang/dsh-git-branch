/**
 * Tests for the Host route of dsh-git-branch: a stubbed Cordis context captures
 * the registered route, then real POST bodies run through the real handler
 * against a throwaway repository.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=dsh-git-branch', '-c', 'user.email=test@example.invalid', '-C', cwd, ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim()
}

function makeRepository() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-branch-route-'))
  git(root, 'init', '-q')
  git(root, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'one\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'one')
  git(root, 'branch', 'feature/two')
  return root
}

/**
 * Build a Context stub around the real `apply`, capture the route, and answer
 * one request through it. `directories` maps session id → working directory.
 */
function createHarness(directories, options = {}) {
  let apiRoute
  const workingDirectory = {
    get: (session) => directories[session.header.id] ?? directories.default,
  }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    sessions: {
      get: (id) => (Object.hasOwn(directories, id) ? { header: { id, cwd: directories[id] } } : undefined),
    },
    get: (name) => {
      if (name === 'workingDirectory') return workingDirectory
      if (name === 'subprocess') return { resolveExecutable: async () => 'git' }
      return undefined
    },
    connection: {
      requestRejection: () => (options.forbidden === true ? 403 : undefined),
    },
    webServer: {
      register: (candidate) => {
        if (candidate.kind === 'prefix' && candidate.path === '/git-branch/api') apiRoute = candidate
        return () => {}
      },
    },
    logger: { warn: () => {} },
  }
  apply(ctx)
  assert.notEqual(apiRoute, undefined, 'apply must register the /git-branch/api route')

  return async function request(method, pathname, body) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = {
      method,
      url: pathname,
      async *[Symbol.asyncIterator]() {
        yield* chunks
      },
    }
    let settle
    const answered = new Promise(resolve => {
      settle = resolve
    })
    const res = {
      statusCode: 0,
      body: '',
      writeHead(status) {
        this.statusCode = status
      },
      end(body) {
        this.body = body ?? ''
        settle(this)
      },
    }
    apiRoute.handler(req, res)
    const response = await answered
    return { status: response.statusCode, json: JSON.parse(response.body) }
  }
}

test('status answers the repository state of the requested session', async () => {
  const root = makeRepository()
  try {
    const request = createHarness({ s1: root })
    const response = await request('POST', '/git-branch/api/status', { sessionId: 's1' })
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.value.isRepo, true)
    assert.equal(response.json.value.branch, 'main')
    assert.deepEqual(response.json.value.branches.map(branch => branch.name), ['feature/two', 'main'])
    assert.equal(response.json.value.branches.every(branch => branch.kind === 'local'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('graph answers the commit graph of the requested session', async () => {
  const root = makeRepository()
  try {
    const request = createHarness({ s1: root })
    const response = await request('POST', '/git-branch/api/graph', { sessionId: 's1' })
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    const rows = response.json.value.rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].subject, 'one')
    assert.equal(rows[0].head, true)
    assert.deepEqual(rows[0].refs.map(ref => `${ref.kind}:${ref.name}`), ['local:main', 'local:feature/two'])
    assert.equal(rows[0].lane, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('graph reports a non-repository directory as a git failure', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'dsh-git-branch-route-graph-plain-'))
  try {
    const request = createHarness({ s1: plain })
    const response = await request('POST', '/git-branch/api/graph', { sessionId: 's1' })
    assert.equal(response.status, 500)
    assert.equal(response.json.error.code, 'git-error')
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test('status hides a session whose directory is not a repository', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'dsh-git-branch-route-plain-'))
  try {
    const request = createHarness({ s1: plain })
    const response = await request('POST', '/git-branch/api/status', { sessionId: 's1' })
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    assert.deepEqual(response.json.value, { isRepo: false })
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test('checkout switches the branch and answers the new status', async () => {
  const root = makeRepository()
  try {
    const request = createHarness({ s1: root })
    const response = await request('POST', '/git-branch/api/checkout', { sessionId: 's1', branch: 'feature/two' })
    assert.equal(response.status, 200)
    assert.equal(response.json.value.branch, 'feature/two')
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'feature/two')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkout rejects a branch name that is not a local branch', async () => {
  const root = makeRepository()
  try {
    const request = createHarness({ s1: root })
    const response = await request('POST', '/git-branch/api/checkout', { sessionId: 's1', branch: '--orphan' })
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'unknown-branch')
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'main')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the route rejects an untrusted request with 403', async () => {
  const request = createHarness({ s1: tmpdir() }, { forbidden: true })
  const response = await request('POST', '/git-branch/api/status', { sessionId: 's1' })
  assert.equal(response.status, 403)
  assert.equal(response.json.error.code, 'forbidden')
})

test('the route is POST-only', async () => {
  const request = createHarness({ s1: tmpdir() })
  const response = await request('GET', '/git-branch/api/status')
  assert.equal(response.status, 405)
})

test('the route answers unknown methods and unknown sessions as errors', async () => {
  const request = createHarness({ s1: tmpdir() })
  const unknownMethod = await request('POST', '/git-branch/api/remove', { sessionId: 's1' })
  assert.equal(unknownMethod.status, 404)
  const unknownSession = await request('POST', '/git-branch/api/status', { sessionId: 'missing' })
  assert.equal(unknownSession.status, 400)
  assert.equal(unknownSession.json.error.code, 'bad-request')
  const noBranch = await request('POST', '/git-branch/api/checkout', { sessionId: 's1' })
  assert.equal(noBranch.status, 400)
})
