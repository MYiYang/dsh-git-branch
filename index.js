/**
 * Host half of the Git branch plugin.
 *
 * The Client half renders a branch chip in the session composer but cannot run
 * git itself. This half answers it over one trust-fenced JSON endpoint,
 * `/git-branch/api` (POST `<method>`), and owns every git invocation:
 *
 * - `status`   → `{ isRepo, root?, branch?, detached?, commit?, branches }`
 *   for the directory the requested Session currently works in. `branches`
 *   lists local branches (with upstream and ahead/behind data) and remote
 *   branches (name and last commit only).
 * - `checkout` → performs `git checkout <branch>` there and answers the same
 *   status shape after the switch.
 * - `graph`    → `{ root, rows }`, the commit graph of that repository with
 *   lanes pre-computed for the panel's renderer.
 *
 * The directory is never taken from the request: it is the live Session's
 * working directory (`workingDirectory.get(session)`), falling back to its
 * immutable header `cwd`. The route is fenced by `connection.requestRejection`
 * so only the authenticated Harness page can call it, and it is POST-only so a
 * cross-site form cannot reach it.
 */
import { GitError, checkoutBranch, readGraph, readStatus, requireDirectory, resolveGitBinary } from './git.js'

export const inject = ['webServer', 'sessions', 'connection']

/** Route family; the method name is the path segment after it. */
const API_PREFIX = '/git-branch/api'
const MAX_BODY_BYTES = 64 * 1024

/** Response headers for every JSON answer (the payload is small and live). */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** Write one JSON response. */
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** One failure encoded for the Client half. */
function writeFailure(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/** Read and validate the small JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new GitError('request body too large', 'bad-request')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new GitError('request body is not valid JSON', 'bad-request')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GitError('request body must be a JSON object', 'bad-request')
  }
  return parsed
}

/**
 * The directory the requested Session works in. The Session header stores the
 * directory it was created in; `workingDirectory` carries later committed
 * changes (e.g. the agent moving into a linked worktree) and wins when present.
 */
function sessionDirectory(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new GitError('sessionId is required', 'bad-request')
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new GitError(`unknown session: ${sessionId}`, 'bad-request')
  const cwd = ctx.get('workingDirectory')?.get(session) ?? session.header.cwd
  if (cwd === undefined || cwd === '') throw new GitError('this session has no working directory', 'bad-request')
  return requireDirectory(cwd)
}

/**
 * Mount the route and the three git operations it exposes.
 * @param ctx - host plugin context (webServer, sessions, and the optional
 * connection/workingDirectory/subprocess services read through `ctx.get`).
 */
export function apply(ctx) {
  const gitBinary = () => resolveGitBinary(ctx.get('subprocess'))

  const operations = {
    async status(payload) {
      const cwd = sessionDirectory(ctx, payload.sessionId)
      return readStatus(cwd, { binary: await gitBinary() })
    },
    async checkout(payload) {
      const cwd = sessionDirectory(ctx, payload.sessionId)
      const branch = payload.branch
      if (typeof branch !== 'string' || branch === '') throw new GitError('branch is required', 'bad-request')
      return checkoutBranch(cwd, branch, { binary: await gitBinary() })
    },
    async graph(payload) {
      const cwd = sessionDirectory(ctx, payload.sessionId)
      return readGraph(cwd, { binary: await gitBinary() })
    },
  }

  /** Connection owns deployment trust and authentication for browser routes. */
  const admits = (req) => {
    try {
      return ctx.connection.requestRejection(req) === undefined
    } catch {
      return false
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (!admits(req)) {
            writeFailure(res, 403, 'forbidden', 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            writeFailure(res, 405, 'method-not-allowed', 'POST required')
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          if (!pathname.startsWith(`${API_PREFIX}/`)) {
            writeFailure(res, 404, 'not-found', 'unknown endpoint')
            return
          }
          const method = pathname.slice(API_PREFIX.length + 1)
          if (method.includes('/') || !Object.hasOwn(operations, method)) {
            writeFailure(res, 404, 'not-found', `unknown method "${method}"`)
            return
          }
          try {
            const payload = await readJsonBody(req)
            const value = await operations[method](payload)
            writeJson(res, 200, { ok: true, value })
          } catch (error) {
            if (error instanceof GitError) {
              // Caller-correctable failures are 400; repository state failures
              // (conflicts, unreadable repositories) are 500 and carry git's
              // own reason so the menu can show it.
              const clientError = ['bad-request', 'bad-directory', 'bad-branch', 'unknown-branch']
              const status = clientError.includes(error.code) ? 400 : 500
              writeFailure(res, status, error.code, error.message)
              return
            }
            ctx.logger?.warn?.(`dsh-git-branch: ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
            writeFailure(res, 500, 'internal', 'the git operation failed')
          }
        },
      }),
    'dsh-git-branch: /git-branch/api routes',
  )
}
