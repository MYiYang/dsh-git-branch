/**
 * Git operations behind the branch chip: read one directory's repository state
 * (local and remote branches, plus the commit graph) and switch between its
 * local branches.
 *
 * The Host half owns these operations; the Client half never runs git itself.
 * Every invocation is argv-only (no shell), branch names are validated against
 * the repository's own `refs/heads` listing before `git checkout` runs, and
 * `GIT_TERMINAL_PROMPT=0` guarantees a credential prompt can never block the
 * Host. Read-only calls carry `GIT_OPTIONAL_LOCKS=0`, so polling the chip does
 * not touch the index lock.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { layoutCommits, parseCommitLog } from './graph.js'

/** Hard ceiling for one git invocation. */
export const GIT_TIMEOUT_MS = 15_000
/** Hard ceiling for one switching invocation (`checkout`). */
const CHECKOUT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 4 * 1024 * 1024

/** Environment every git child inherits: never prompt, never take optional locks. */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
}

/** One expected failure, classified for the route layer. */
export class GitError extends Error {
  /**
   * @param message - operator-facing reason.
   * @param code - stable wire code (`bad-request`, `bad-directory`,
   * `bad-branch`, `unknown-branch`, `git-unavailable`, `git-error`).
   * @param stderr - the child's stderr, kept for diagnosis.
   */
  constructor(message, code = 'git-error', stderr = '') {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.stderr = stderr
  }
}

/** Git's "dubious ownership" refusal names the repository it refused. */
const DUBIOUS_OWNERSHIP = /dubious ownership[^']*'([^']+)'/i

/**
 * The repository path from git's dubious-ownership refusal, or undefined when
 * this failure is something else. Git versions before 2.35 never print it.
 */
function dubiousOwnershipPath(stderr) {
  const match = DUBIOUS_OWNERSHIP.exec(stderr)
  return match === null ? undefined : match[1]
}

/**
 * Validate a directory before spawning anything against it. Every path the
 * plugin touches comes from a live Session header / working-directory record,
 * so a non-directory is a programming or lifecycle error, not user input.
 */
export function requireDirectory(cwd) {
  if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) {
    throw new GitError(`invalid working directory: ${String(cwd)}`, 'bad-directory')
  }
  let info
  try {
    info = statSync(cwd)
  } catch {
    throw new GitError(`working directory does not exist: ${cwd}`, 'bad-directory')
  }
  if (!info.isDirectory()) throw new GitError(`working directory is not a directory: ${cwd}`, 'bad-directory')
  return cwd
}

/** One git child; resolves stdout, rejects with a classified {@link GitError}. */
function runGit(binary, cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['-C', cwd, '--no-pager', ...args],
      { cwd, timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: GIT_ENV },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout)
          return
        }
        const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : error.message
        reject(new GitError(detail, error.code === 'ENOENT' ? 'git-unavailable' : 'git-error', typeof stderr === 'string' ? stderr : ''))
      },
    )
  })
}

let cachedBinary

/**
 * Resolve the git executable once. The subprocess service knows the Host's
 * execution world (its scrubbed PATH), which is more reliable than guessing
 * from `process.env`. Every candidate is PROBED with `git --version` before it
 * is used: a PATH can contain non-executable shims (a Windows `git.bat` from
 * depot_tools was the real-world failure) that `execFile` cannot spawn, and a
 * git that cannot start would otherwise make every repository look like "not a
 * repository".
 */
export async function resolveGitBinary(subprocess) {
  if (cachedBinary !== undefined) return cachedBinary
  const candidates = []
  const add = candidate => {
    if (typeof candidate === 'string' && candidate !== '' && !candidates.includes(candidate)) candidates.push(candidate)
  }
  if (subprocess !== undefined && typeof subprocess.resolveExecutable === 'function') {
    for (const command of process.platform === 'win32' ? ['git.exe', 'git'] : ['git']) {
      try {
        add(await subprocess.resolveExecutable(command))
      } catch {
        // Try the next spelling.
      }
    }
  }
  for (const candidate of localGitCandidates()) add(candidate)
  for (const candidate of candidates) {
    if (await probesAsGit(candidate)) {
      cachedBinary = candidate
      return candidate
    }
  }
  // Nothing started: keep the first guess so callers fail fast with the
  // provider's own error instead of spawning the same probe on every request.
  cachedBinary = candidates[0] ?? 'git'
  return cachedBinary
}

/** Local candidates that need no subprocess service: PATH scan, then install dirs. */
function localGitCandidates() {
  const candidates = []
  if (process.platform === 'win32') {
    const path = process.env.PATH ?? process.env.Path ?? ''
    for (const directory of path.split(';')) {
      if (directory === '') continue
      for (const name of ['git.exe']) {
        const candidate = join(directory, name)
        try {
          accessSync(candidate, fsConstants.X_OK)
          candidates.push(candidate)
        } catch {
          // Not here.
        }
      }
    }
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs'),
    ]
    for (const root of roots) {
      if (root === undefined || root === '') continue
      const candidate = join(root, 'Git', 'cmd', 'git.exe')
      try {
        accessSync(candidate, fsConstants.X_OK)
        candidates.push(candidate)
      } catch {
        // Try the next candidate.
      }
    }
    return candidates
  }
  candidates.push('git')
  return candidates
}

/** Whether `candidate` is a git that this process can actually execute. */
function probesAsGit(candidate) {
  return new Promise(resolve => {
    execFile(candidate, ['--version'], { timeout: 5_000, windowsHide: true, env: GIT_ENV }, (error, stdout) => {
      resolve(error === null && typeof stdout === 'string' && stdout.startsWith('git version'))
    })
  })
}


/**
 * Resolve the repository root for `cwd`.
 *
 * Git refuses repositories owned by another user; when that refusal names the
 * repository, retry ONCE with that exact path trusted for this invocation only
 * (the better-sidebar treatment). The trust is never widened to a wildcard.
 */
async function repositoryRoot(binary, cwd) {
  try {
    const root = (await runGit(binary, cwd, ['rev-parse', '--show-toplevel'])).trim()
    if (root !== '') return { root, safe: [] }
    throw new GitError('git returned an empty repository root', 'git-error')
  } catch (error) {
    const refused = error instanceof GitError ? dubiousOwnershipPath(error.stderr) : undefined
    if (refused === undefined) throw error
    const safe = ['-c', `safe.directory=${refused}`]
    const root = (await runGit(binary, cwd, [...safe, 'rev-parse', '--show-toplevel'])).trim()
    if (root === '') throw new GitError('git returned an empty repository root', 'git-error')
    return { root, safe }
  }
}

/** Work out the git binary once per call, honouring an explicit override. */
async function binaryFor(options) {
  if (typeof options.binary === 'string' && options.binary !== '') return options.binary
  return resolveGitBinary(options.subprocess)
}

/** Fields of one `for-each-ref` record, NUL-separated; see {@link parseBranchRows}. */
const BRANCH_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(symref)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(objectname:short)',
  '%(committerdate:unix)',
  '%(contents:subject)',
  '%(HEAD)',
].join('%00')

/** Run the branch listing and parse it. */
async function readBranchRows(binary, cwd, safe) {
  const stdout = await runGit(binary, cwd, [
    ...safe,
    'for-each-ref',
    `--format=${BRANCH_FORMAT}`,
    'refs/heads',
    'refs/remotes',
  ])
  return parseBranchRows(stdout)
}

/**
 * Branch rows from one `for-each-ref` stdout: local branches first, then remote
 * ones, each alphabetical.
 *
 * Local rows carry everything the table shows. Remote rows only carry what a
 * remote-tracking ref really has (its name and last commit): upstream tracking
 * and ahead/behind counts are local-only concepts, so those fields are absent
 * and the Client leaves their cells empty.
 *
 * @param stdout - stdout of the `for-each-ref` invocation above.
 * @returns {Array<object>} branch rows; never undefined fields on remote rows.
 */
export function parseBranchRows(stdout) {
  const local = []
  const remote = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const fields = line.split('\0')
    if (fields.length < 9) continue
    const [refname, name, symref, upstream, track, commit, time, subject, head] = fields
    // `refs/remotes/origin/HEAD` is a symbolic alias for a real branch.
    if (symref !== '' || name === '') continue
    const lastCommit = commit === ''
      ? undefined
      : { short: commit, time: Number.parseInt(time, 10) || 0, subject }
    if (refname.startsWith('refs/heads/')) {
      const tracked = upstream !== ''
      local.push({
        name,
        kind: 'local',
        current: head.trim() === '*',
        ...(tracked ? { upstream, ...parseTrack(track) } : {}),
        ...(lastCommit === undefined ? {} : { lastCommit }),
      })
    } else if (refname.startsWith('refs/remotes/')) {
      remote.push({
        name,
        kind: 'remote',
        ...(lastCommit === undefined ? {} : { lastCommit }),
      })
    }
  }
  const byName = (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  return [...local.sort(byName), ...remote.sort(byName)]
}

/** Ahead/behind counts out of `%(upstream:track)` (`[ahead 2, behind 1]`). */
function parseTrack(track) {
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  return {
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1]),
  }
}

/** One snapshot of a directory's git state; the shape the chip renders. */
export async function readStatus(cwd, options = {}) {
  requireDirectory(cwd)
  const binary = await binaryFor(options)
  let repository
  try {
    repository = await repositoryRoot(binary, cwd)
  } catch (error) {
    if (error instanceof GitError && error.code === 'git-unavailable') return { isRepo: false, unavailable: true }
    // Not a repository (or not readable as one): the chip stays hidden.
    return { isRepo: false }
  }
  const safe = repository.safe

  let branch
  let detached = false
  try {
    const name = (await runGit(binary, cwd, [...safe, 'symbolic-ref', '--short', '-q', 'HEAD'])).trim()
    if (name === '') detached = true
    else branch = name
  } catch {
    detached = true
  }

  let commit
  try {
    commit = (await runGit(binary, cwd, [...safe, 'rev-parse', '--short', 'HEAD'])).trim() || undefined
  } catch {
    commit = undefined
  }

  let branches = []
  try {
    branches = await readBranchRows(binary, cwd, safe)
  } catch {
    branches = []
  }

  return { isRepo: true, root: repository.root, branch, detached, commit, branches }
}

/** How many commits the graph panel shows; it is a map of recent history. */
export const GRAPH_COMMIT_LIMIT = 200

/** One `git log` record for the graph: hash, short hash, parents, author, time, subject, refs. */
const GRAPH_FORMAT = ['%H', '%h', '%P', '%an', '%at', '%s', '%D'].join('%x1f')

/**
 * The commit graph of `cwd`'s repository: the history reachable from every ref,
 * topologically ordered, with `git`-style lanes already laid out by graph.js.
 *
 * A repository with no commits (unborn branch) answers an empty graph instead
 * of an error, so opening the panel on a fresh `git init` just shows "no
 * commits yet".
 */
export async function readGraph(cwd, options = {}) {
  requireDirectory(cwd)
  const binary = await binaryFor(options)
  const repository = await repositoryRoot(binary, cwd)
  const requested = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : GRAPH_COMMIT_LIMIT
  const limit = Math.min(requested, 1000)
  let stdout
  try {
    stdout = await runGit(binary, cwd, [
      ...repository.safe,
      'log',
      '--all',
      '--topo-order',
      '--decorate=full',
      '--no-color',
      `--max-count=${limit}`,
      `--format=${GRAPH_FORMAT}`,
    ])
  } catch (error) {
    // `git log --all` refuses an empty repository; an empty graph is the right
    // answer there, every other failure is a real one.
    if (error instanceof GitError && /does not have any commits yet|bad revision|unknown revision/i.test(error.message)) {
      return { root: repository.root, rows: [] }
    }
    throw error
  }
  return { root: repository.root, rows: layoutCommits(parseCommitLog(stdout)) }
}

/**
 * Switch `cwd`'s repository to an existing local branch and answer the new
 * status. `git checkout` (not `git switch`) keeps Git 2.18-era hosts working;
 * the branch argument is only ever a name this repository reported itself, so
 * it can never be read as an option or a path.
 */
export async function checkoutBranch(cwd, branch, options = {}) {
  requireDirectory(cwd)
  if (typeof branch !== 'string' || branch === '' || /[\u0000-\u001f]/.test(branch)) {
    throw new GitError('invalid branch name', 'bad-branch')
  }
  const binary = await binaryFor(options)
  const repository = await repositoryRoot(binary, cwd)
  const safe = repository.safe
  const listed = (await readBranchRows(binary, cwd, safe))
    .filter(row => row.kind === 'local')
    .map(row => row.name)
  if (!listed.includes(branch)) throw new GitError(`no local branch named "${branch}"`, 'unknown-branch')
  await runGit(binary, cwd, [...safe, 'checkout', branch], CHECKOUT_TIMEOUT_MS)
  return readStatus(cwd, { binary })
}
