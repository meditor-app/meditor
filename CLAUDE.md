# meditor — project conventions

A static web page (GitHub Pages) for editing Markdown files in GitHub repositories: source
and rendered side by side, commits and pull requests through the GitHub REST API. Styled
after quedit (`~/quedit`), whose palette and panel layout it shares.

## Hard constraints

- **No runtime dependencies. No CDN. No build step.** `index.html` loads native ES modules
  from `src/`; Pages serves exactly those files.
- **No server.** Everything talks to `api.github.com` from the browser; auth is a personal
  access token kept in the browser. Never send the token anywhere else.
- `node --test tests/*.test.js` must pass with **zero `node_modules`**.
- **Only `ui.js` touches the DOM.** Rendering, API calls, routing, edit commands and diffing
  are pure modules with headless tests.
- Raw HTML from documents (and from GitHub's renderer) goes through `sanitizeHtml` before it
  reaches `innerHTML`.
- The rendered page's top-level blocks carry `data-line` (source line); scroll sync and task
  box toggling depend on it.
