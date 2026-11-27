# meditor

Edit the Markdown files of your GitHub repositories in the browser: the source on one side,
the rendered page on the other, and a commit (or a pull request) when you are done.
In the spirit of [prose.io](https://prose.io), as one static page.

**→ <https://ondrik.github.io/meditor/>**

No server, no installation, no dependencies: the page talks to `api.github.com` directly
from your browser.

## Using it

- **Open a repository** with *open…* (`Ctrl+O`): pick one of yours, or paste a GitHub URL or
  `owner/name`. A link to a file (`https://github.com/owner/name/blob/main/docs/x.md`) opens
  that file. The file list on the left shows the branch's Markdown files; switch branches
  above it, create a file with *＋ new*.
- **Edit** on the left, read on the right. The two panels scroll together (*sync scroll*);
  links between documents of the repository open in the editor, and images from the
  repository show, private ones included. Tick a task box in the rendered page and the
  `[ ]` in the source ticks with it.
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

## Signing in

A static page cannot complete GitHub's OAuth login (that needs a server to hold a client
secret), so meditor uses a **personal access token** you create:

- a [fine-grained token](https://github.com/settings/personal-access-tokens/new) limited to the
  repositories you want to edit, with *Repository permissions → Contents: Read and write*
  (plus *Pull requests: Read and write* to open pull requests), or
- a [classic token](https://github.com/settings/tokens/new?scopes=repo&description=meditor) with
  the `repo` scope (`public_repo` for public repositories only).

The token stays in your browser (local storage, or only for the session if you untick
*remember*) and is sent nowhere but `api.github.com`. Public repositories can be read without
signing in, at GitHub's anonymous rate of 60 requests an hour.

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
| `src/links.js` | the address fragment, GitHub URLs, relative links inside a document |
| `src/edit.js` | the formatting commands, as pure functions on text + selection |
| `src/diff.js` | the line diff shown before committing |
| `src/ui.js` | everything on the page; the only module that touches the DOM |
| `src/app.css` | the look, shared with [quedit](https://quantum.fit.vut.cz/quedit/) |

### Deploying

`.github/workflows/pages.yml` runs the tests on every push and pull request, and publishes
`master` to GitHub Pages. Enable it once in the repository's *Settings → Pages → Source:
GitHub Actions*.
