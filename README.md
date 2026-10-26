# dsh-git-branch

> npm package: **`dsh-git-branch-plugin`** (`npm i dsh-git-branch-plugin` /
> `dsh plugin add dsh-git-branch-plugin`). The GitHub repository is
> [MYiYang/dsh-git-branch](https://github.com/MYiYang/dsh-git-branch); the
> in-plugin id `dsh-git-branch`, the route prefix `/git-branch/api` and the
> loader row id `git-branch` are unaffected by the npm name.

A DSH Web plugin that puts the current Git branch into the session composer,
lists every local and remote branch there, lets you switch local branches, and
opens a read-only commit graph.

- **Visible only for Git projects.** The chip is hidden when the session's
  working directory is not inside a Git repository.
- **Where:** the compact control row of the message composer
  (`conversation.input.left`), left of the model selector.
- **What it shows:** the current branch name; on a detached HEAD it shows
  `HEAD@<short commit>`.
- **Branch table:** click the chip to open a four-column table:

  | Column | Local branch | Remote branch |
  | --- | --- | --- |
  | Branch | name (check mark when checked out) | name (globe) |
  | Upstream | tracking ref, e.g. `origin/main` | *empty* |
  | Ahead·Behind | `↑2 ↓1` vs. upstream, `=` when in sync | *empty* |
  | Last commit | short hash (subject/date in the tooltip) | short hash |

  Local rows are grouped first, then remote rows. A search field appears for
  repositories with more than 8 branches and filters both groups. Switching
  (`git checkout <branch>`) is offered for local branches only — remote rows are
  display-only, so clicking one never detaches HEAD or creates a branch.
  Failures (dirty tree conflicts, invalid state) are shown inside the menu.
- **Commit graph:** the button in the menu header opens a read-only graph panel
  (above the chip when there is room, otherwise below). It draws lanes and dots
  for the history reachable from every ref (up to 200 commits), with branch,
  remote and tag badges, subject, short hash, author and date. `Esc`, the close
  button or an outside click dismisses it.
- **Freshness:** the status is re-read every 15 s while the page is visible, and
  immediately on window focus, on the page becoming visible, and after a
  switch — so branches changed by the agent or a terminal show up too. The
  graph is read when the panel opens and can be refreshed from its header.

## Layout

| File | Role |
|---|---|
| `index.js` | Host half: mounts the trust-fenced `POST /git-branch/api/{status,checkout,graph}` route and resolves the session's working directory. |
| `git.js` | The git layer: argv-only git invocations, local/remote branch listing (upstream, ahead/behind, last commit), branch switch, commit-graph read, detached-HEAD and non-repository detection. |
| `graph.js` | Pure commit-log parser and `git log --graph`-style lane layout used by the graph panel — no repository or DOM access, fully unit-tested. |
| `client.js` | Web client half: the composer chip, the four-column branch table, the commit-graph panel, polling, and locale wiring. |
| `cordis.patch.yml` | Bundle patch inserting the Host row (`git-branch`). |
| `locale/*.json` | Plugin Manager title/description (English and Chinese). |
| `icon.svg` | Plugin icon. |
| `test/git.test.js` | Git-layer tests over throwaway repositories (including a real remote). |
| `test/graph.test.js` | Parser/layout unit tests plus a real merge-history smoke test. |
| `test/route.test.js` | Route tests through the real `apply` and handler. |

## How the halves talk

The browser cannot run git, so the Client half calls the one Host route:

- `status` → `{ isRepo, root?, branch?, detached?, commit?, branches }` for the
  session's live working directory (`workingDirectory.get(session)`, falling
  back to the session header's `cwd`). Each branch row is
  `{ name, kind: 'local'|'remote', current?, upstream?, ahead?, behind?, lastCommit? }`;
  remote rows carry only `name` and `lastCommit`, and the Client leaves the
  upstream / ahead-behind cells empty for them.
- `checkout` → `git checkout <branch>` there (local names only), then the same
  status shape.
- `graph` → `{ root, rows }` where each row is a commit plus its lane geometry:
  `{ hash, short, parents, author, time, subject, refs, head, lane, nodeColor,
  nodeFromTop, links: [{ from, to, color }], laneCount }`. A link runs from a
  lane at the top edge (`from`), the commit's dot (`null`, for a parent) or to a
  lane at the bottom edge (`to`, for this commit's parents).

The route is registered through `ctx.webServer` and fenced with
`ctx.connection.requestRejection`, so only the authenticated Harness page can
call it; it accepts `POST` only. The directory never comes from the request, and
a branch name is checked against the repository's own `refs/heads` listing
before checkout, so a request cannot reach an arbitrary path or a git flag.

## Install

```bash
# from npm
dsh plugin --profile web add dsh-git-branch-plugin

# or a local checkout (development)
dsh plugin --profile web add ./dsh-git-branch
```

The package is a DSH **bundle** (it ships its own `cordis.patch.yml`), so adding
it installs the dependency and activates the Host row. Make sure the package is
also listed in the profile's `dsh.profile.bundles` (`~/.dsh/profiles/web/package.json`);
without that entry the bundle is installed but never layered.

After installing or editing this package, restart DSH so the Host half loads the
new route, then refresh the Harness page so the browser loads the current
`client.js` (an open page can keep the client module it already loaded).

## Test

From this directory:

```text
node --test test/git.test.js test/graph.test.js test/route.test.js
```

or `npm test`. The suite builds throwaway repositories under the OS temp
directory and removes them afterwards; one fixture also creates a bare remote
to exercise remote-tracking refs, `origin/HEAD` and ahead/behind counts.

## Notes and limits

- Switches **local** branches only; remote branches are listed read-only
  (checking one out would detach HEAD or need a new local branch — both are
  terminal/agent actions).
- The commit graph is read-only and caps at the most recent 200 commits across
  all refs. It never runs `git log` with a path or revision taken from the
  request; the repository is always the session's own.
- Uses `git checkout` rather than `git switch` so it also works on the Git 2.18
  shipped with some Windows hosts.
- The plugin resolves git once — the `subprocess` service's execution world
  first, then a PATH scan — and PROBES every candidate with `git --version`.
  A non-executable PATH shim (for example a Windows `git.bat` from depot_tools)
  is skipped, so a real repository is never misreported as "not a repository".
  When no git can start, the chip simply stays hidden.
- The working directory is re-resolved on every request, so a session that moved
  into a linked worktree shows that worktree's branch.

## License

[MIT](LICENSE)
