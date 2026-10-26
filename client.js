/**
 * Client half of the Git branch plugin.
 *
 * Registers one compact chip in the composer tool row (`conversation.input.left`)
 * for the current Session. The chip only appears when the Session's project is
 * a Git repository: it shows the current branch (or the short commit for a
 * detached HEAD) and opens a table of local and remote branches; picking a
 * local one asks the Host half to check it out. The menu header also opens a
 * read-only commit graph of the repository.
 *
 * All data goes through the Host half's `/git-branch/api` route — this module
 * never sees a credential and never decides on a directory of its own. The chip
 * re-reads the status on a slow cadence, on window focus, and when the document
 * becomes visible, so a branch switched outside the page (agent, terminal) shows
 * up without a reload.
 */
window.__ModuleLoader__.load({
  id: 'dsh-git-branch',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const zh = {
      branch: '分支',
      current: '当前分支',
      detached: '游离 HEAD',
      detachedHint: '当前处于游离 HEAD，选择一个分支即可回到分支上。',
      search: '搜索分支',
      noBranches: '这个仓库还没有分支',
      noMatch: '没有匹配的分支',
      switching: '切换中…',
      switchFailed: '切换失败',
      refresh: '刷新分支信息',
      repo: '仓库',
      requestFailed: '无法读取分支信息',
      localGroup: '本地分支',
      remoteGroup: '远程分支',
      colBranch: '分支',
      colUpstream: '上游',
      colTrack: '领先·落后',
      colCommit: '最近提交',
      inSync: '与上游一致',
      aheadTitle: '领先上游',
      behindTitle: '落后上游',
      remoteHint: '远程分支（仅展示，不可直接切换）',
      graph: '提交图',
      graphOpen: '查看提交图',
      graphClose: '关闭提交图',
      graphLoading: '正在读取提交图…',
      graphEmpty: '这个仓库还没有提交',
      graphFailed: '无法读取提交图',
    }
    const en = {
      branch: 'Branch',
      current: 'Current branch',
      detached: 'Detached HEAD',
      detachedHint: 'You are on a detached HEAD; pick a branch to get back on one.',
      search: 'Search branches',
      noBranches: 'This repository has no branches yet',
      noMatch: 'No matching branch',
      switching: 'Switching…',
      switchFailed: 'Switch failed',
      refresh: 'Refresh branch information',
      repo: 'Repository',
      requestFailed: 'Could not read branch information',
      localGroup: 'Local branches',
      remoteGroup: 'Remote branches',
      colBranch: 'Branch',
      colUpstream: 'Upstream',
      colTrack: 'Ahead·Behind',
      colCommit: 'Last commit',
      inSync: 'Up to date with upstream',
      aheadTitle: 'Commits ahead of upstream',
      behindTitle: 'Commits behind upstream',
      remoteHint: 'Remote branch (read-only, cannot be checked out directly)',
      graph: 'Commit graph',
      graphOpen: 'Show commit graph',
      graphClose: 'Close commit graph',
      graphLoading: 'Reading the commit graph…',
      graphEmpty: 'This repository has no commits yet',
      graphFailed: 'Could not read the commit graph',
    }

    const NS = 'gitBranch'
    const API_PREFIX = 'git-branch/api'
    /** Slow enough to stay invisible in profiles; focus/visibility force a read. */
    const POLL_MS = 15_000
    const REQUEST_TIMEOUT_MS = 8_000
    /** Height of one commit row in the graph panel; the lane SVG matches it. */
    const GRAPH_ROW_HEIGHT = 40
    /** Horizontal distance between two graph lanes. */
    const GRAPH_LANE_WIDTH = 14
    /** Lane palette; the Host only sends the index. */
    const LANE_COLORS = ['#4c8dff', '#f0a53d', '#43c07b', '#e35d6a', '#a06ce0', '#3cb8c8', '#c9a227', '#d97bb5']

    const CSS = `
.dgb-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  max-width: 170px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.dgb-chip:hover,
.dgb-chip[aria-expanded="true"] {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dgb-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dgb-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dgb-caret {
  flex: 0 0 auto;
  opacity: 0.7;
}
.dgb-menu {
  position: fixed;
  z-index: 70;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  padding: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);
}
/* Both surfaces take programmatic focus for keyboard handling; the focus ring
   around a whole popover reads as a bug, so only their inner controls show one. */
.dgb-menu:focus,
.dgb-menu:focus-visible,
.dgb-graph:focus,
.dgb-graph:focus-visible {
  outline: none;
}
.dgb-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px 4px;
}
.dgb-head-title {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-secondary);
}
.dgb-head-branch {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--dsw-alias-brand-primary);
}
.dgb-icon-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dgb-icon-btn:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dgb-icon-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dgb-search {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.dgb-search:focus {
  border-color: var(--dsw-alias-brand-primary);
}
.dgb-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  overflow: auto;
}
.dgb-thead {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 2px 6px 3px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dgb-trow {
  display: grid;
  grid-template-columns: minmax(84px, 1fr) 96px 66px 74px;
  align-items: center;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  padding: 5px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
}
button.dgb-branch {
  cursor: pointer;
}
button.dgb-branch:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.dgb-branch-remote {
  cursor: default;
}
.dgb-branch-current .dgb-cell-name {
  color: var(--dsw-alias-brand-primary);
}
.dgb-branch:disabled {
  cursor: default;
  opacity: 0.6;
}
.dgb-cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dgb-cell-name {
  display: flex;
  align-items: center;
  gap: 4px;
}
.dgb-cell-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dgb-cell-upstream {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dgb-cell-track {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.dgb-ahead {
  color: var(--dsw-alias-brand-primary);
}
.dgb-behind {
  color: var(--dsw-alias-state-warn-primary);
}
.dgb-cell-commit {
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
.dgb-group {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 6px 2px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dgb-group-count {
  font-variant-numeric: tabular-nums;
}
.dgb-empty {
  padding: 6px;
  color: var(--dsw-alias-label-secondary);
}
.dgb-error {
  margin-top: 2px;
  padding: 4px 6px;
  border-radius: 6px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
.dgb-root {
  margin-top: 2px;
  padding: 4px 6px 2px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dgb-hint {
  padding: 0 6px 2px;
  color: var(--dsw-alias-state-warn-primary);
}
.dgb-graph {
  position: fixed;
  z-index: 80;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  box-shadow: 0 16px 48px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);
  overflow: hidden;
}
.dgb-graph-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dgb-graph-title {
  flex: 0 0 auto;
  font-weight: 600;
}
.dgb-graph-repo {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  text-align: right;
}
.dgb-graph-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 4px 6px 8px;
}
.dgb-grow {
  display: flex;
  align-items: stretch;
  gap: 8px;
  min-height: ${GRAPH_ROW_HEIGHT}px;
  padding: 0 4px;
  border-radius: 6px;
}
.dgb-grow:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.dgb-graph-lanes {
  flex: 0 0 auto;
  display: block;
  align-self: flex-start;
}
.dgb-grow-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 4px 0;
}
.dgb-grow-subject {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dgb-grow-refs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 55%;
  overflow: hidden;
}
.dgb-grow-subject-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dgb-grow-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dgb-grow-meta code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
.dgb-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  max-width: 180px;
  height: 16px;
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dgb-badge-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dgb-badge-local {
  color: var(--dsw-alias-brand-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
}
.dgb-badge-head {
  font-weight: 600;
}
.dgb-badge-remote {
  color: var(--dsw-alias-label-secondary);
  border-color: var(--dsw-alias-border-l1);
}
.dgb-badge-tag {
  color: var(--dsw-alias-state-warn-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);
}
.dgb-badge-more {
  color: var(--dsw-alias-label-secondary);
  border-color: var(--dsw-alias-border-l1);
}
.dgb-badge-other {
  color: var(--dsw-alias-label-secondary);
  border-color: var(--dsw-alias-border-l1);
}
.dgb-graph-status {
  padding: 20px 10px;
  color: var(--dsw-alias-label-secondary);
  text-align: center;
  overflow-wrap: anywhere;
}
.dgb-graph-status-error {
  color: var(--dsw-alias-state-error-primary);
}
`

    /**
     * Resolve one Host route against the page's own base. Leading slashes are
     * stripped so a GUI mounted under a reverse-proxy prefix keeps the request
     * under that prefix; the Electron shell forwards the same relative path to
     * the Host for `dsh-app://` pages.
     */
    function resolveUrl(path) {
      const relative = String(path).replace(/^\/+/, '')
      try {
        const base = new URL(document.baseURI)
        base.search = ''
        base.hash = ''
        if (!base.pathname.endsWith('/')) base.pathname += '/'
        return new URL(relative, base.href).toString()
      } catch {
        return `/${relative}`
      }
    }

    /** One JSON call to this package's Host half. */
    async function callHost(method, payload, t) {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          : undefined
      let response
      try {
        response = await fetch(resolveUrl(`${API_PREFIX}/${method}`), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal,
        })
      } catch {
        throw new Error(t('requestFailed'))
      }
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok || body === undefined || body.ok !== true) {
        const message = body?.error?.message
        throw new Error(typeof message === 'string' && message !== '' ? message : t('requestFailed'))
      }
      return body.value
    }

    /** Coerce a Host status answer into the shape the view renders. */
    function normalizeStatus(value) {
      if (value === null || typeof value !== 'object') return { isRepo: false }
      return value
    }

    /**
     * Branch rows from a status answer. Strings are accepted too, so a page
     * with the new Client half talking to an older Host half still lists the
     * local branches instead of blanking the menu.
     */
    function normalizeBranches(value, current) {
      if (!Array.isArray(value)) return []
      const rows = []
      for (const item of value) {
        if (typeof item === 'string' && item !== '') {
          rows.push({ name: item, kind: 'local', current: item === current })
        } else if (item !== null && typeof item === 'object' && typeof item.name === 'string' && item.name !== '') {
          rows.push(item)
        }
      }
      return rows
    }

    /** Coerce a Host graph answer into `{ root, rows }` with usable rows. */
    function normalizeGraph(value) {
      if (value === null || typeof value !== 'object') return { rows: [] }
      const rows = Array.isArray(value.rows)
        ? value.rows.filter(row => row !== null && typeof row === 'object' && typeof row.hash === 'string')
        : []
      return { root: typeof value.root === 'string' ? value.root : undefined, rows }
    }

    /** Local `YYYY-MM-DD HH:mm`, empty for a missing timestamp. */
    function formatDate(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return ''
      const date = new Date(seconds * 1000)
      const pad = value => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** One lane colour; unknown indexes fall back to the first colour. */
    function laneColor(index) {
      if (!Number.isInteger(index)) return LANE_COLORS[0]
      return LANE_COLORS[((index % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]
    }

    // ── tiny icons (inline SVG keeps the package free of image requests) ────

    function BranchIcon() {
      return h(
        'svg',
        {
          width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true, style: { flex: '0 0 auto' },
        },
        h('circle', { cx: 4.5, cy: 3.5, r: 1.5 }),
        h('circle', { cx: 4.5, cy: 12.5, r: 1.5 }),
        h('circle', { cx: 11.5, cy: 3.5, r: 1.5 }),
        h('path', { d: 'M4.5 5v6' }),
        h('path', { d: 'M11.5 5v1.5a3.5 3.5 0 0 1-3.5 3.5H4.5' }),
      )
    }

    function GlobeIcon() {
      return h(
        'svg',
        {
          width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.2, 'aria-hidden': true, style: { flex: '0 0 auto' },
        },
        h('circle', { cx: 8, cy: 8, r: 5.4 }),
        h('path', { d: 'M2.6 8h10.8' }),
        h('ellipse', { cx: 8, cy: 8, rx: 2.6, ry: 5.4 }),
      )
    }

    function TagIcon() {
      return h(
        'svg',
        {
          width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          style: { flex: '0 0 auto' },
        },
        h('path', { d: 'M2.5 2.5h5l6 6-5 5-6-6z' }),
        h('circle', { cx: 5.2, cy: 5.2, r: 0.9 }),
      )
    }

    function CaretIcon() {
      return h(
        'svg',
        {
          width: 8, height: 8, viewBox: '0 0 8 8', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, className: 'dgb-caret',
        },
        h('path', { d: 'M1.5 3l2.5 2.5L6.5 3' }),
      )
    }

    function CheckIcon() {
      return h(
        'svg',
        {
          width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
        h('path', { d: 'M3 8.5l3 3 7-7' }),
      )
    }

    function RefreshIcon() {
      return h(
        'svg',
        {
          width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
        h('path', { d: 'M13 8a5 5 0 1 1-1.5-3.5' }),
        h('path', { d: 'M13 2.5V5h-2.5' }),
      )
    }

    function GraphIcon() {
      return h(
        'svg',
        {
          width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
        h('circle', { cx: 4.5, cy: 3, r: 1.6 }),
        h('circle', { cx: 4.5, cy: 8, r: 1.6 }),
        h('circle', { cx: 11.5, cy: 13, r: 1.6 }),
        h('path', { d: 'M4.5 4.6v1.8' }),
        h('path', { d: 'M4.5 9.6v1.4a2 2 0 0 0 2 2h1.5' }),
        h('path', { d: 'M8 13A4.5 4.5 0 0 0 11.5 8.5V3' }),
        h('circle', { cx: 11.5, cy: 3, r: 1.6 }),
      )
    }

    function CloseIcon() {
      return h(
        'svg',
        {
          width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true,
        },
        h('path', { d: 'M4 4l8 8' }),
        h('path', { d: 'M12 4l-8 8' }),
      )
    }

    /**
     * Re-render on locale changes. The bound translate function reads the
     * active locale at call time, so a render pass is all that is needed.
     */
    function useLocaleRefresh(locale) {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        let disposed = false
        const off = locale.subscribe(() => {
          if (!disposed) bump(version => version + 1)
        })
        return () => {
          disposed = true
          if (typeof off === 'function') off()
        }
      }, [locale])
    }

    /** One commit row's lane geometry, as a single SVG. */
    function GraphLane({ row, laneCount }) {
      const height = GRAPH_ROW_HEIGHT
      const mid = height / 2
      const x = lane => 8 + lane * GRAPH_LANE_WIDTH
      const nodeX = x(row.lane)
      const nodeY = mid
      const links = Array.isArray(row.links) ? row.links : []
      const children = []
      for (let index = 0; index < links.length; index += 1) {
        const link = links[index]
        if (link === null || typeof link !== 'object') continue
        const from = Number.isInteger(link.from) ? link.from : null
        const to = Number.isInteger(link.to) ? link.to : null
        if (from === null && to === null) continue
        const fromX = from === null ? nodeX : x(from)
        const toX = to === null ? nodeX : x(to)
        const fromY = from === null ? mid : 0
        const toY = to === null ? mid : height
        const d = fromX === toX
          ? `M${fromX} ${fromY}L${toX} ${toY}`
          : `M${fromX} ${fromY}C${fromX} ${(fromY + toY) / 2} ${toX} ${(fromY + toY) / 2} ${toX} ${toY}`
        children.push(
          h('path', {
            key: `l${index}`,
            d,
            fill: 'none',
            stroke: laneColor(link.color),
            strokeWidth: 1.6,
            strokeLinecap: 'round',
          }),
        )
      }
      if (row.nodeFromTop === true) {
        children.push(
          h('path', {
            key: 'top',
            d: `M${nodeX} 0L${nodeX} ${mid}`,
            fill: 'none',
            stroke: laneColor(row.nodeColor),
            strokeWidth: 1.6,
            strokeLinecap: 'round',
          }),
        )
      }
      children.push(
        h('circle', {
          key: 'node',
          cx: nodeX,
          cy: nodeY,
          r: 3.4,
          stroke: laneColor(row.nodeColor),
          strokeWidth: 1.8,
          style: { fill: 'var(--dsw-alias-bg-overlay)' },
        }),
      )
      return h(
        'svg',
        {
          className: 'dgb-graph-lanes',
          width: 8 + Math.max(laneCount, 1) * GRAPH_LANE_WIDTH,
          height,
          viewBox: `0 0 ${8 + Math.max(laneCount, 1) * GRAPH_LANE_WIDTH} ${height}`,
          'aria-hidden': true,
        },
        children,
      )
    }

    /** One ref pill in the graph panel. */
    function RefBadge({ badge, t }) {
      const kind = badge.kind === 'local' || badge.kind === 'remote' || badge.kind === 'tag' ? badge.kind : 'other'
      const className = `dgb-badge dgb-badge-${kind}` + (badge.head === true ? ' dgb-badge-head' : '')
      const icon = kind === 'remote' ? GlobeIcon() : kind === 'tag' ? TagIcon() : BranchIcon()
      return h(
        'span',
        {
          className,
          title: kind === 'remote' ? `${badge.name} · ${t('remoteHint')}` : badge.name,
        },
        icon,
        h('span', { className: 'dgb-badge-name' }, badge.name),
      )
    }

    /** Build the chip component for one client context. */
    function createChip(locale, t) {
      return function GitBranchChip(props) {
        useLocaleRefresh(locale)
        const sessionId = props.sessionId
        const [status, setStatus] = React.useState(undefined)
        const [tick, setTick] = React.useState(0)
        const [open, setOpen] = React.useState(false)
        const [query, setQuery] = React.useState('')
        const [busy, setBusy] = React.useState('')
        const [failure, setFailure] = React.useState('')
        const [anchor, setAnchor] = React.useState(undefined)
        const [graphOpen, setGraphOpen] = React.useState(false)
        const [graph, setGraph] = React.useState(undefined)
        const [graphError, setGraphError] = React.useState('')
        const [graphLoading, setGraphLoading] = React.useState(false)
        const [graphAnchor, setGraphAnchor] = React.useState(undefined)
        const buttonRef = React.useRef(null)
        const menuRef = React.useRef(null)
        const graphRef = React.useRef(null)
        const inputRef = React.useRef(null)

        // Poll the Host while the session is on screen. The first read happens
        // immediately; failures keep the last good answer instead of blanking
        // a chip that was already showing a branch.
        React.useEffect(() => {
          if (typeof sessionId !== 'string' || sessionId === '') return undefined
          let disposed = false
          let timer
          const load = () => {
            callHost('status', { sessionId }, t)
              .then(value => {
                if (!disposed) setStatus(normalizeStatus(value))
              })
              .catch(() => {
                // Keep the last answer; a transient route failure hides nothing.
              })
          }
          load()
          timer = window.setInterval(load, POLL_MS)
          const onVisible = () => {
            if (document.visibilityState !== 'hidden') load()
          }
          window.addEventListener('focus', load)
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            disposed = true
            window.clearInterval(timer)
            window.removeEventListener('focus', load)
            document.removeEventListener('visibilitychange', onVisible)
          }
        }, [sessionId, tick])

        const refresh = React.useCallback(() => setTick(value => value + 1), [])

        // A new session must not show the previous session's branch, menu or
        // graph while its own first read is in flight.
        React.useEffect(() => {
          setStatus(undefined)
          setOpen(false)
          setGraphOpen(false)
          setGraph(undefined)
          setGraphError('')
        }, [sessionId])

        /** Read the commit graph from the Host; the panel shows its state. */
        const loadGraph = React.useCallback(() => {
          setGraphLoading(true)
          setGraphError('')
          callHost('graph', { sessionId }, t)
            .then(value => {
              setGraph(normalizeGraph(value))
              setGraphLoading(false)
            })
            .catch(error => {
              setGraphError(error instanceof Error ? error.message : String(error))
              setGraphLoading(false)
            })
        }, [sessionId, t])

        /** Position the menu above the chip, clamped into the viewport. */
        const placeMenu = React.useCallback(() => {
          const element = buttonRef.current
          if (element === null) return
          const rect = element.getBoundingClientRect()
          // Four columns (branch, upstream, ahead/behind, last commit) need
          // more room than the old name-only list.
          const width = Math.max(320, Math.min(540, window.innerWidth - 16))
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
          const maxHeight = Math.max(160, Math.min(460, rect.top - 12))
          setAnchor({
            left,
            bottom: window.innerHeight - rect.top + 8,
            width,
            maxHeight,
          })
        }, [])

        /** Position the graph panel above the chip when there is room, else below. */
        const placeGraph = React.useCallback(() => {
          const element = buttonRef.current
          if (element === null) return
          const rect = element.getBoundingClientRect()
          const width = Math.max(320, Math.min(760, window.innerWidth - 24))
          const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
          const roomAbove = rect.top - 20
          const roomBelow = window.innerHeight - rect.bottom - 20
          const above = roomAbove >= 240 || roomAbove >= roomBelow
          const maxHeight = Math.max(200, Math.min(560, above ? roomAbove : roomBelow))
          setGraphAnchor(
            above
              ? { left, width, maxHeight, bottom: window.innerHeight - rect.top + 8 }
              : { left, width, maxHeight, top: rect.bottom + 8 },
          )
        }, [])

        const closeMenu = React.useCallback((returnFocus) => {
          setOpen(false)
          if (returnFocus === true && buttonRef.current !== null) buttonRef.current.focus()
        }, [])

        const closeGraph = React.useCallback((returnFocus) => {
          setGraphOpen(false)
          if (returnFocus === true && buttonRef.current !== null) {
            window.requestAnimationFrame(() => {
              if (buttonRef.current !== null) buttonRef.current.focus()
            })
          }
        }, [])

        const toggleMenu = React.useCallback(() => {
          if (open) {
            setOpen(false)
            return
          }
          setFailure('')
          setQuery('')
          placeMenu()
          setOpen(true)
        }, [open, placeMenu])

        const openGraph = React.useCallback(() => {
          setOpen(false)
          setFailure('')
          setGraphOpen(true)
          setGraph(undefined)
          placeGraph()
          loadGraph()
        }, [loadGraph, placeGraph])

        // While the menu is open: outside pointer dismisses, Escape closes and
        // returns focus, resize/scroll keep the fixed menu glued to the chip,
        // and the search field (or the menu itself) takes focus.
        React.useEffect(() => {
          if (!open) return undefined
          const onPointerDown = event => {
            const target = event.target
            if (menuRef.current !== null && menuRef.current.contains(target)) return
            if (buttonRef.current !== null && buttonRef.current.contains(target)) return
            setOpen(false)
          }
          const onKeyDown = event => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              closeMenu(true)
            }
          }
          const onLayout = () => placeMenu()
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('resize', onLayout)
          window.addEventListener('scroll', onLayout, true)
          const frame = window.requestAnimationFrame(() => {
            if (inputRef.current !== null) inputRef.current.focus()
            else if (menuRef.current !== null) menuRef.current.focus()
          })
          return () => {
            window.cancelAnimationFrame(frame)
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('resize', onLayout)
            window.removeEventListener('scroll', onLayout, true)
          }
        }, [open, placeMenu, closeMenu])

        // While the graph panel is open: outside pointer dismisses it, Escape
        // closes it (and returns focus to the chip), layout changes re-place it.
        React.useEffect(() => {
          if (!graphOpen) return undefined
          const onPointerDown = event => {
            if (graphRef.current !== null && graphRef.current.contains(event.target)) return
            setGraphOpen(false)
          }
          const onKeyDown = event => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              closeGraph(true)
            }
          }
          const onLayout = () => placeGraph()
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('resize', onLayout)
          window.addEventListener('scroll', onLayout, true)
          const frame = window.requestAnimationFrame(() => {
            if (graphRef.current !== null) graphRef.current.focus()
          })
          return () => {
            window.cancelAnimationFrame(frame)
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('resize', onLayout)
            window.removeEventListener('scroll', onLayout, true)
          }
        }, [graphOpen, placeGraph, closeGraph])

        const switchTo = React.useCallback(
          branch => {
            if (typeof branch !== 'string' || branch === '' || busy !== '') return
            if (status !== undefined && status !== null && status.isRepo === true && status.branch === branch) {
              closeMenu(true)
              return
            }
            setBusy(branch)
            setFailure('')
            callHost('checkout', { sessionId, branch }, t)
              .then(value => {
                setStatus(normalizeStatus(value))
                setBusy('')
                setOpen(false)
                window.requestAnimationFrame(() => {
                  if (buttonRef.current !== null) buttonRef.current.focus()
                })
              })
              .catch(error => {
                setBusy('')
                setFailure(error instanceof Error ? error.message : String(error))
              })
          },
          [busy, closeMenu, sessionId, status, t],
        )

        if (status === undefined || status === null) return null
        if (status.isRepo !== true) return null

        const detached = status.detached === true
        const current = typeof status.branch === 'string' ? status.branch : undefined
        const label = detached
          ? typeof status.commit === 'string' && status.commit !== ''
            ? `HEAD@${status.commit}`
            : t('detached')
          : current ?? t('detached')
        const branches = normalizeBranches(status.branches, current)
        const localBranches = branches.filter(branch => branch.kind === 'local')
        const remoteBranches = branches.filter(branch => branch.kind === 'remote')
        const needle = query.trim().toLowerCase()
        const matches = branch => needle === '' || branch.name.toLowerCase().includes(needle)
        const filteredLocal = localBranches.filter(matches)
        const filteredRemote = remoteBranches.filter(matches)
        const showSearch = branches.length > 8
        const graphRows = graph === undefined ? [] : graph.rows
        const laneCount = graphRows.reduce((widest, row) => Math.max(widest, Number.isInteger(row.laneCount) ? row.laneCount : 1), 1)

        /** One branch row: a button for local branches, a static row for remote. */
        const renderBranchRow = branch => {
          const isLocal = branch.kind === 'local'
          const isCurrent = isLocal && branch.current === true
          const upstream = typeof branch.upstream === 'string' ? branch.upstream : ''
          const ahead = Number.isInteger(branch.ahead) ? branch.ahead : undefined
          const behind = Number.isInteger(branch.behind) ? branch.behind : undefined
          const lastCommit = branch.lastCommit !== null && typeof branch.lastCommit === 'object' ? branch.lastCommit : undefined
          const commitShort = lastCommit !== undefined && typeof lastCommit.short === 'string' ? lastCommit.short : ''
          const commitTitle = lastCommit === undefined
            ? ''
            : [lastCommit.subject, commitShort, formatDate(lastCommit.time)].filter(part => typeof part === 'string' && part !== '').join(' · ')

          const track = []
          if (upstream !== '') {
            if ((ahead ?? 0) === 0 && (behind ?? 0) === 0) {
              track.push(h('span', { key: 'sync', title: t('inSync') }, '='))
            } else {
              if ((ahead ?? 0) > 0) {
                track.push(h('span', { key: 'ahead', className: 'dgb-ahead', title: `${t('aheadTitle')} ${ahead}` }, `↑${ahead}`))
              }
              if ((behind ?? 0) > 0) {
                track.push(h('span', { key: 'behind', className: 'dgb-behind', title: `${t('behindTitle')} ${behind}` }, `↓${behind}`))
              }
            }
          }

          const cells = [
            h(
              'span',
              { key: 'name', className: 'dgb-cell dgb-cell-name' },
              isCurrent ? CheckIcon() : isLocal ? BranchIcon() : GlobeIcon(),
              h('span', { className: 'dgb-cell-name-text', title: branch.name }, branch.name),
              busy === branch.name ? h('span', { className: 'dgb-cell-name-text' }, t('switching')) : null,
            ),
            // The remote rows have no upstream/ahead-behind data: both cells
            // stay empty rather than inventing a value or a placeholder.
            h('span', { key: 'upstream', className: 'dgb-cell dgb-cell-upstream', title: upstream }, upstream),
            h('span', { key: 'track', className: 'dgb-cell dgb-cell-track' }, track),
            h('span', { key: 'commit', className: 'dgb-cell dgb-cell-commit', title: commitTitle }, commitShort),
          ]

          if (!isLocal) {
            return h(
              'div',
              {
                key: `remote:${branch.name}`,
                className: 'dgb-trow dgb-branch dgb-branch-remote',
                role: 'menuitem',
                'aria-disabled': 'true',
                title: `${branch.name} · ${t('remoteHint')}`,
              },
              cells,
            )
          }

          const className = 'dgb-trow dgb-branch' + (isCurrent ? ' dgb-branch-current' : '')
          return h(
            'button',
            {
              key: `local:${branch.name}`,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': isCurrent ? 'true' : 'false',
              className,
              disabled: busy !== '',
              title: branch.name,
              onClick: () => switchTo(branch.name),
            },
            cells,
          )
        }

        const renderGroup = (kind, rows, label) => {
          if (rows.length === 0) return []
          const nodes = [
            h(
              'div',
              { key: `group:${kind}`, className: 'dgb-group', role: 'presentation' },
              h('span', null, label),
              h('span', { className: 'dgb-group-count' }, rows.length),
            ),
          ]
          for (const row of rows) nodes.push(renderBranchRow(row))
          return nodes
        }

        const renderGraphRow = row => {
          const refs = Array.isArray(row.refs) ? row.refs.filter(ref => ref !== null && typeof ref === 'object' && typeof ref.name === 'string') : []
          const badgeItems = refs.map((ref, index) => ({
            name: ref.name,
            node: h(RefBadge, { key: `${ref.kind}:${ref.name}:${index}`, badge: ref, t }),
          }))
          if (row.head === true && !refs.some(ref => ref.head === true)) {
            badgeItems.push({
              name: 'HEAD',
              node: h('span', { key: 'head', className: 'dgb-badge dgb-badge-local dgb-badge-head' }, 'HEAD'),
            })
          }
          // A commit shared by many branches would otherwise push the subject
          // out of the row: keep the first few pills and fold the rest into +N.
          const badges = badgeItems.slice(0, 3).map(item => item.node)
          const folded = badgeItems.slice(3)
          if (folded.length > 0) {
            badges.push(
              h(
                'span',
                {
                  key: 'more',
                  className: 'dgb-badge dgb-badge-more',
                  title: folded.map(item => item.name).join(', '),
                },
                `+${folded.length}`,
              ),
            )
          }
          const date = formatDate(row.time)
          const meta = [row.short, row.author, date].filter(part => typeof part === 'string' && part !== '').join(' · ')
          return h(
            'div',
            { key: row.hash, className: 'dgb-grow' },
            h(GraphLane, { row, laneCount }),
            h(
              'div',
              { className: 'dgb-grow-text' },
              h(
                'div',
                { className: 'dgb-grow-subject' },
                badges.length > 0 ? h('span', { className: 'dgb-grow-refs' }, badges) : null,
                h('span', { className: 'dgb-grow-subject-text', title: row.subject }, row.subject),
              ),
              h('div', { className: 'dgb-grow-meta' }, meta),
            ),
          )
        }

        return h(
          React.Fragment,
          null,
          h('style', { key: 'dgb-style' }, CSS),
          h(
            'button',
            {
              key: 'dgb-chip',
              ref: buttonRef,
              type: 'button',
              className: 'dgb-chip',
              'aria-haspopup': 'menu',
              'aria-expanded': open ? 'true' : 'false',
              'aria-label': `${t('branch')}: ${label}`,
              title: typeof status.root === 'string' ? `${t('repo')}: ${status.root}` : label,
              onClick: toggleMenu,
            },
            BranchIcon(),
            h('span', { className: 'dgb-chip-label' }, label),
            CaretIcon(),
          ),
          open && anchor !== undefined
            ? h(
                'div',
                {
                  key: 'dgb-menu',
                  ref: menuRef,
                  className: 'dgb-menu',
                  role: 'menu',
                  tabIndex: -1,
                  'aria-label': t('branch'),
                  style: {
                    left: `${anchor.left}px`,
                    bottom: `${anchor.bottom}px`,
                    width: `${anchor.width}px`,
                    maxHeight: `${anchor.maxHeight}px`,
                  },
                },
                h(
                  'div',
                  { className: 'dgb-head' },
                  h('span', { className: 'dgb-head-title' }, t('current')),
                  h('span', { className: 'dgb-head-branch', title: label }, label),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dgb-icon-btn',
                      title: t('graphOpen'),
                      'aria-label': t('graphOpen'),
                      'aria-haspopup': 'dialog',
                      onClick: openGraph,
                    },
                    GraphIcon(),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dgb-icon-btn',
                      title: t('refresh'),
                      'aria-label': t('refresh'),
                      onClick: refresh,
                    },
                    RefreshIcon(),
                  ),
                ),
                showSearch
                  ? h('input', {
                      key: 'dgb-search',
                      ref: inputRef,
                      type: 'search',
                      className: 'dgb-search',
                      value: query,
                      placeholder: t('search'),
                      'aria-label': t('search'),
                      onChange: event => setQuery(event.target.value),
                    })
                  : null,
                h(
                  'div',
                  { className: 'dgb-list', role: 'group' },
                  branches.length === 0 ? h('div', { className: 'dgb-empty' }, t('noBranches')) : null,
                  branches.length > 0 && filteredLocal.length === 0 && filteredRemote.length === 0
                    ? h('div', { className: 'dgb-empty' }, t('noMatch'))
                    : null,
                  branches.length > 0
                    ? h(
                        'div',
                        { className: 'dgb-thead dgb-trow', role: 'presentation' },
                        h('span', { className: 'dgb-cell dgb-cell-name' }, t('colBranch')),
                        h('span', { className: 'dgb-cell dgb-cell-upstream' }, t('colUpstream')),
                        h('span', { className: 'dgb-cell dgb-cell-track' }, t('colTrack')),
                        h('span', { className: 'dgb-cell dgb-cell-commit' }, t('colCommit')),
                      )
                    : null,
                  renderGroup('local', filteredLocal, t('localGroup')),
                  renderGroup('remote', filteredRemote, t('remoteGroup')),
                ),
                failure !== ''
                  ? h('div', { className: 'dgb-error', role: 'alert' }, `${t('switchFailed')}: ${failure}`)
                  : null,
                typeof status.root === 'string' ? h('div', { className: 'dgb-root', title: status.root }, status.root) : null,
                detached ? h('div', { className: 'dgb-hint' }, t('detachedHint')) : null,
              )
            : null,
          graphOpen && graphAnchor !== undefined
            ? h(
                'div',
                {
                  key: 'dgb-graph',
                  ref: graphRef,
                  className: 'dgb-graph',
                  role: 'dialog',
                  'aria-label': t('graph'),
                  tabIndex: -1,
                  style: {
                    left: `${graphAnchor.left}px`,
                    width: `${graphAnchor.width}px`,
                    maxHeight: `${graphAnchor.maxHeight}px`,
                    ...(typeof graphAnchor.bottom === 'number'
                      ? { bottom: `${graphAnchor.bottom}px` }
                      : { top: `${graphAnchor.top}px` }),
                  },
                },
                h(
                  'div',
                  { className: 'dgb-graph-head' },
                  GraphIcon(),
                  h('span', { className: 'dgb-graph-title' }, t('graph')),
                  h(
                    'span',
                    { className: 'dgb-graph-repo', title: typeof status.root === 'string' ? status.root : '' },
                    typeof status.root === 'string' ? status.root : '',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dgb-icon-btn',
                      title: t('refresh'),
                      'aria-label': t('refresh'),
                      onClick: loadGraph,
                    },
                    RefreshIcon(),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dgb-icon-btn',
                      title: t('graphClose'),
                      'aria-label': t('graphClose'),
                      onClick: () => closeGraph(true),
                    },
                    CloseIcon(),
                  ),
                ),
                h(
                  'div',
                  { className: 'dgb-graph-body' },
                  graphLoading
                    ? h('div', { className: 'dgb-graph-status' }, t('graphLoading'))
                    : graphError !== ''
                      ? h('div', { className: 'dgb-graph-status dgb-graph-status-error', role: 'alert' }, `${t('graphFailed')}: ${graphError}`)
                      : graphRows.length === 0
                        ? h('div', { className: 'dgb-graph-status' }, t('graphEmpty'))
                        : h('div', null, graphRows.map(renderGraphRow)),
                ),
              )
            : null,
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'dsh-git-branch: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'dsh-git-branch: en dictionary')
        const t = ctx.locale.bind(NS)
        const Chip = createChip(ctx.locale, t)
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'git-branch',
              order: 100,
            },
            Chip,
          ),
        )
      },
    }
  },
})
