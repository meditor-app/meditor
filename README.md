<img src="icons/icon.svg" width="72" align="right" alt="">

# meditor

Edit the Markdown files of your GitHub repositories in the browser: the source on one side,
the rendered page on the other, and a commit (or a pull request) when you are done.
In the spirit of [prose.io](https://prose.io), as one static page.

**→ <https://meditor-app.github.io/meditor/>**

No installation, no dependencies: the page talks to `api.github.com` directly from your
browser. The only server-side piece is a tiny relay that completes *Sign in with GitHub*.

## Using it

- **Open a repository** with *open…* (`Ctrl+O`): pick one of yours, or paste a GitHub URL or
  `owner/name`. A link to a file (`https://github.com/owner/name/blob/main/docs/x.md`) opens
  that file. The file list on the left shows the branch's Markdown files; switch branches
  above it, create a file with *＋ new*. Hover over a file for *✎* (rename or move it) and
  *✕* (delete it): each is one commit to the branch, and the file's draft and its place among
  the recent files go with it.
- **Edit** on the left, read on the right. The two panels scroll together (*sync scroll*);
  links between documents of the repository open in the editor, and images from the
  repository show, private ones included. Tick a task box in the rendered page and the
  `[ ]` in the source ticks with it.
  - **Paste or drop an image** into the source: it goes next to the document
    (`images/<document>-1.png`, or the dropped file's own name), its link goes in at the
    cursor, and it is committed with the document, in the same commit. Until then it is
    kept with the draft in this browser; delete the link and it is left out.
  - `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+E` code, `Ctrl+K` link, `Ctrl+1/2/3` headings
  - `Enter` continues a list or a quote (on an empty item it ends the list);
    `Tab` / `Shift+Tab` indent and outdent
  - *source / both / rendered* choose the panels; *files* hides the file list; drag the gaps
    between panels to resize them (double-click to reset)
- **Rendering**: *meditor (live)* renders as you type, GitHub-flavoured: tables, task lists,
  strikethrough, autolinks, footnotes, alerts (`> [!NOTE]`), front matter, and HTML (sanitised
  much like GitHub does). *GitHub (exact)* asks GitHub to render it, which is exactly what
  github.com shows (syntax highlighting included) but costs one API request per pause in
  typing.
- **Commit** with *commit…* (`Ctrl+S`): see the changes, write a message, and commit straight
  to the branch, or to a new branch with a pull request opened for you. If the file changed on
  GitHub meanwhile, GitHub refuses the commit rather than lose that change; load the latest
  version, check the diff, and commit again.
- **Drafts**: unsaved changes are kept in your browser, per file and branch, until committed —
  close the tab, come back, they are still there (the file list marks them with ●).
- **Without a repository** the editor is a scratchpad kept in the browser; open a local file
  into it and download the result.
- The address names the open file (`#repo=owner/name&ref=main&path=README.md`), so it can be
  bookmarked or shared.

## Installing it as an app

meditor can be installed like a desktop (or phone) application: its own window and icon,
started from the dock or the applications menu, and it opens without a network — the
scratchpad, drafts and recent files work offline; opening and committing files need GitHub.

- **Chrome, Edge** (Windows, macOS, Linux, ChromeOS, Android): the **install app** button in
  meditor's top bar, or the install icon at the right of the address bar.
- **Safari** (macOS 14+): *File → Add to Dock*. **iPhone / iPad**: *Share → Add to Home Screen*.
- **Firefox** has no app install on desktop; use it as a page.

The installed app is the same site: it updates itself whenever it starts online, and shares
the sign-in, drafts and recent files with the page in the same browser.

## Signing in

**Sign in with GitHub** (top right) goes through meditor's GitHub App: GitHub asks you to
allow it, and you choose which repositories meditor may see. It can read and change files
and open pull requests there, and nothing else. The permission renews itself every eight
hours while you use meditor; withdraw it under *GitHub → Settings → Applications*.

Alternatively, paste a **personal access token** (under *use a personal access token
instead*): a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
with *Contents: Read and write* (and *Pull requests: Read and write*), or a
[classic token](https://github.com/settings/tokens/new?scopes=repo&description=meditor) with
the `repo` scope.

Either way the token stays in your browser and is sent only to `api.github.com`. Public
repositories can be read without signing in, at GitHub's anonymous rate of 60 requests an
hour.

### Why there is a relay

A static page cannot finish GitHub's sign-in by itself: trading the one-time code for a
token needs the app's client secret, which cannot be published in a page, and github.com does
not accept that request from a page anyway (no CORS). [`worker/relay.js`](worker/relay.js), a
small Cloudflare Worker, does just that step (and token renewal): it adds the secret, asks
GitHub, and hands the answer back. It stores and logs nothing, and serves only the pages
listed in `ALLOWED_ORIGINS`. This is the same arrangement as prose.io's Gatekeeper.

### Why its own address

The sign-in tokens live in the browser's local storage, which every page of the same
*origin* can read. meditor is therefore published from an organization of its own,
`meditor-app`, whose GitHub Pages origin (`meditor-app.github.io`) hosts nothing else. It
used to live at `ondrik.github.io/meditor/`, shared with the other pages of that account.

### Setting up Sign in with GitHub

Needed once, by whoever deploys meditor. Until it is done the page offers tokens only.

1. **Register a GitHub App** at <https://github.com/settings/apps/new>:
   - *GitHub App name*: e.g. `meditor`; *Homepage URL*: `https://meditor-app.github.io/meditor/`
   - *Callback URL*: `https://meditor-app.github.io/meditor/`; add a second one,
     `http://localhost:8000/`, for development
   - *Expire user authorization tokens*: on. *Request user authorization (OAuth) during
     installation*: **off**. *Enable Device Flow*: off.
   - *Setup URL*: `https://meditor-app.github.io/meditor/`, with *Redirect on update* on
   - *Webhook*: uncheck *Active*
   - *Repository permissions*: **Contents: Read and write**, **Pull requests: Read and
     write** (Metadata: Read-only is added by itself)
   - *Where can this GitHub App be installed?*: *Any account*, so that others can use it

   Then, on the app's page, note the **Client ID** and the app's URL name (the *slug*, as in
   `github.com/apps/<slug>`), and **generate a client secret**.
2. **Deploy the relay** (a free Cloudflare account is enough): set `GITHUB_CLIENT_ID` in
   `worker/wrangler.toml`, then from `worker/`:
   ```
   npx wrangler login
   npx wrangler secret put GITHUB_CLIENT_SECRET     # paste the client secret
   npx wrangler deploy                             # prints https://meditor-auth.<you>.workers.dev
   ```
3. **Point the page at them** in `src/config.js` (client ID, slug, relay URL), and push.

## Development

```
python3 -m http.server 8000     # then open http://localhost:8000/
node --test tests/*.test.js     # no npm install needed
```

The page is `index.html` plus native ES modules in `src/`; there is no build step, and the
same files are what GitHub Pages serves.

| file | what |
| --- | --- |
| `src/markdown.js` | GitHub-flavoured Markdown → HTML, and the HTML sanitiser |
| `src/github.js` | the REST API calls (files, trees, branches, commits, pull requests) |
| `src/auth.js` | signing in: the GitHub App's OAuth flow (with PKCE), token renewal, tokens |
| `src/config.js` | the GitHub App's client ID and slug, and the relay's URL |
| `worker/relay.js` | the sign-in relay (Cloudflare Worker) |
| `src/links.js` | the address fragment, GitHub URLs, relative links inside a document |
| `src/edit.js` | the formatting commands, as pure functions on text + selection |
| `src/diff.js` | the line diff shown before committing |
| `src/ui.js` | everything on the page; the only module that touches the DOM |
| `src/app.css` | the look, shared with [quedit](https://quantum.fit.vut.cz/quedit/) |
| `manifest.webmanifest`, `sw.js` | installing as an app, and starting offline |
| `icons/` | the logo (`icon.svg`) and its PNG renderings for app icons |

### Deploying

`.github/workflows/pages.yml` runs the tests on every push and pull request, and publishes
`master` to GitHub Pages. Enable it once in the repository's *Settings → Pages → Source:
GitHub Actions*.
