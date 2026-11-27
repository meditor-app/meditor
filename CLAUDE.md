# meditor — project conventions

A static web page (GitHub Pages) for editing Markdown files in GitHub repositories: source
and rendered side by side, commits and pull requests through the GitHub REST API. Styled
after quedit (`~/quedit`), whose palette and panel layout it shares.

## Hard constraints

- **No runtime dependencies. No CDN. No build step.** `index.html` loads native ES modules
  from `src/`; Pages serves exactly those files.
- **No server** beyond `worker/relay.js`, a stateless Cloudflare Worker that only trades
  OAuth codes and refresh tokens for tokens (it holds the GitHub App's client secret).
  Everything else talks to `api.github.com` from the browser. Tokens are kept in the browser
  and sent nowhere but `api.github.com` (and, for renewal/revocation, the relay).
- `node --test tests/*.test.js` must pass with **zero `node_modules`**.
- **Only `ui.js` touches the DOM.** Rendering, API calls, auth, routing, edit commands and
  diffing are pure modules with headless tests; so is the relay (`tests/relay.test.js`).
- Raw HTML from documents (and from GitHub's renderer) goes through `sanitizeHtml` before it
  reaches `innerHTML`.
- The rendered page's top-level blocks carry `data-line` (source line); scroll sync and task
  box toggling depend on it.
- It installs as an app (`manifest.webmanifest`, `sw.js`). A new file in `src/` must also go
  into `SHELL` in `sw.js` (a test checks), and a new top-level file the page needs must be
  copied in `.github/workflows/pages.yml`. The PNG icons are rendered from `icons/icon.svg`
  and `icons/icon-maskable.svg` with `rsvg-convert`.

## Workflow

`master` is protected: every change goes through a pull request (opened as a draft), CI's
`test` job must pass, and Ondra merges by hand on GitHub. Never push to `master`, and never
merge a pull request. Merging deploys the site (GitHub Pages builds from `master`).
