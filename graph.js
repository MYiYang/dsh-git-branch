/**
 * Commit-graph data behind the plugin's "Git graph" panel.
 *
 * The Host half runs one `git log` and hands the raw text to
 * {@link parseCommitLog}; the lane layout is then computed by
 * {@link layoutCommits}. Both steps are pure functions over strings/objects, so
 * the whole graph geometry is unit-tested without a repository or a browser.
 *
 * The layout mirrors what `git log --graph` draws, as a renderable model:
 *
 * - every row is one commit, with the lane its dot sits in;
 * - `links` are the lines of that row, each connecting a lane at the top edge
 *   (`from`), the commit's dot (`null`) or a lane at the bottom edge (`to`);
 * - a lane that merely passes this commit by has `from === to`.
 *
 * The Client half draws those links as straight lines and small cubic curves,
 * so it never has to know anything about parents or ordering.
 */

/** Field separator inside one `git log` record (ASCII unit separator). */
export const FIELD_SEP = '\u001f'

/** Commit hashes are abbreviated to at least this many hex characters. */
const HASH = /^[0-9a-f]{4,64}$/i

/**
 * Parse `git log --format=%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D` stdout.
 *
 * Returns commits in the order git printed them (children before parents when
 * the log was requested with `--topo-order`), each with its decorations split
 * into branch / remote / tag names.
 *
 * @param stdout - raw stdout of the log invocation.
 * @returns {Array<object>} `{ hash, short, parents, author, time, subject, refs, head }`.
 */
export function parseCommitLog(stdout) {
  const commits = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const fields = line.split(FIELD_SEP)
    if (fields.length < 7) continue
    const [hash, short, parents, author, time, subject, decoration] = fields
    if (!HASH.test(hash)) continue
    const decorated = parseDecoration(decoration)
    commits.push({
      hash,
      short,
      parents: parents.split(' ').filter(parent => HASH.test(parent)),
      author,
      time: Number.parseInt(time, 10) || 0,
      subject,
      refs: decorated.refs,
      head: decorated.head,
    })
  }
  return commits
}

/**
 * Split one `%D` decoration list (`--decorate=full` form) into refs.
 *
 * Examples: `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1`.
 * The symbolic `refs/remotes/origin/HEAD` alias is dropped: it names a remote's
 * default branch, not a branch of its own.
 *
 * @param text - the decoration field of one commit.
 * @returns {{ refs: Array<{ name: string, kind: string, head: boolean }>, head: boolean }}.
 */
export function parseDecoration(text) {
  const refs = []
  let head = false
  for (const raw of text.split(',')) {
    let item = raw.trim()
    if (item === '') continue
    if (item === 'HEAD') {
      head = true
      continue
    }
    let atHead = false
    if (item.startsWith('HEAD -> ')) {
      item = item.slice('HEAD -> '.length)
      atHead = true
      head = true
    }
    let name = item
    let kind = 'other'
    if (item.startsWith('tag: ')) {
      kind = 'tag'
      name = item.slice('tag: '.length).replace(/^refs\/tags\//, '')
    } else if (item.startsWith('refs/heads/')) {
      kind = 'local'
      name = item.slice('refs/heads/'.length)
    } else if (item.startsWith('refs/remotes/')) {
      kind = 'remote'
      name = item.slice('refs/remotes/'.length)
      // The symbolic `origin/HEAD` alias names a remote's default branch.
      if (name.endsWith('/HEAD')) continue
    } else if (item.startsWith('refs/tags/')) {
      kind = 'tag'
      name = item.slice('refs/tags/'.length)
    } else {
      // Any other ref (an old `refs/stash`, for example) keeps a readable name.
      name = item.replace(/^refs\//, '')
    }
    if (name === '') continue
    refs.push({ name, kind, head: atHead })
  }
  return { refs, head }
}

/**
 * Assign every commit a lane and the line segments that connect it to its
 * parents, in the style of `git log --graph`.
 *
 * Walk the commits in printed order, keeping one open lane per edge that is
 * still waiting for a commit further down. A commit occupies the leftmost lane
 * waiting for it; each parent then joins a lane already heading for it (a merge
 * or a branch folding back), or — for the first parent — inherits the dot's
 * lane, and the remaining parents open new lanes.
 *
 * @param commits - commits from {@link parseCommitLog}.
 * @param options - `maxLanes` caps the drawing width; extra branches are folded
 *   into the last lane instead of growing the graph horizontally forever.
 * @returns {Array<object>} rows carrying the commit plus `lane`, `nodeColor`,
 *   `nodeFromTop`, `links` and `laneCount`.
 */
export function layoutCommits(commits, options = {}) {
  const maxLanes = Number.isInteger(options.maxLanes) && options.maxLanes > 0 ? options.maxLanes : 20
  const reachable = new Set(commits.map(commit => commit.hash))
  /** Open lanes: `{ target, color }`, or `null` for a free slot. */
  const lanes = []
  const rows = []
  const paletteSize = 8
  let colorCursor = 0

  const takeColor = () => {
    const color = colorCursor % paletteSize
    colorCursor += 1
    return color
  }
  /** First free slot, a new slot while under the cap, else the folded last lane. */
  const allocateLane = () => {
    const free = lanes.findIndex(lane => lane === null || lane === undefined)
    if (free >= 0) return free
    if (lanes.length < maxLanes) {
      lanes.push(null)
      return lanes.length - 1
    }
    return maxLanes - 1
  }

  for (const commit of commits) {
    // Lanes already carrying this commit's row; the leftmost one is the dot.
    const incoming = []
    for (let lane = 0; lane < lanes.length; lane += 1) {
      if (lanes[lane] !== null && lanes[lane] !== undefined && lanes[lane].target === commit.hash) incoming.push(lane)
    }
    const nodeLane = incoming.length > 0 ? incoming[0] : allocateLane()
    const nodeColor = lanes[nodeLane]?.color ?? takeColor()
    lanes[nodeLane] = { target: commit.hash, color: nodeColor }

    const links = []
    // Branches unrelated to this commit continue straight through the row.
    for (let lane = 0; lane < lanes.length; lane += 1) {
      const open = lanes[lane]
      if (open === null || open === undefined) continue
      if (open.target === commit.hash) continue
      links.push({ from: lane, to: lane, color: open.color })
    }
    // Additional lanes that also hold this commit merge into its dot.
    for (const lane of incoming) {
      if (lane === nodeLane) continue
      links.push({ from: lane, to: null, color: lanes[lane].color })
      lanes[lane] = null
    }
    lanes[nodeLane] = null

    for (const [index, parent] of commit.parents.entries()) {
      if (!reachable.has(parent)) continue
      // Join a lane that is already heading for this parent (a branch merging
      // back into another, or two branches sharing a base commit) instead of
      // opening a second lane for the same commit. Otherwise the first parent
      // keeps the dot's lane and the remaining parents open new ones.
      const existing = lanes.findIndex(open => open !== null && open !== undefined && open.target === parent)
      const lane = existing >= 0 ? existing : index === 0 ? nodeLane : allocateLane()
      const color = lane === nodeLane && existing < 0 ? nodeColor : (lanes[lane]?.color ?? takeColor())
      lanes[lane] = { target: parent, color }
      links.push({ from: null, to: lane, color })
    }

    rows.push({
      ...commit,
      lane: nodeLane,
      nodeColor,
      nodeFromTop: incoming.length > 0,
      links,
      laneCount: lanes.length,
    })
  }

  // A parent that never appears (the log was truncated) leaves a lane open at
  // the bottom; the last row simply does not draw below its own edge.
  return rows
}
