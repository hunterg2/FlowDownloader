# Flow Bulk Downloader

A Tampermonkey userscript that bulk-downloads every image (and optionally video) in your
Google Flow projects created since a date/time you choose, at original or upscaled quality.
It runs inside your normal, signed-in `flow.google.com` tab, remembers what it already saved,
writes a manifest, and can run on its own every day.

Nothing leaves your browser: the script talks only to Flow's own backend using your existing
session, exactly like the Flow web app does.

## Install (about 2 minutes)

1. Install the **Tampermonkey** extension (Chrome / Edge / Brave / Firefox). In Chrome also
   turn on **Developer mode** on `chrome://extensions` once; Tampermonkey shows a banner if
   that is needed.
2. Install the script. Either open the raw file in your browser and let Tampermonkey pick
   it up (once the repo is on GitHub:
   `https://raw.githubusercontent.com/hunterg2/FlowDownloader/main/flow-bulk-downloader.user.js`),
   or click the Tampermonkey icon → **Create a new script…**, paste the contents of
   [`flow-bulk-downloader.user.js`](flow-bulk-downloader.user.js), press **Ctrl+S**.
   Installed from the raw URL, Tampermonkey auto-updates when fixes are pushed.
3. In Chrome settings → Downloads, turn **off** "Ask where to save each file".
4. Open **https://flow.google.com** (signed in). A blue **⬇ Flow Export** button appears
   bottom-right.

## First run

1. Open a project. Click **⬇ Flow Export**, set **Since**, tick **Images** (and **Videos**
   if wanted).
2. Click **Scan (dry run)** to see what matches, then **Test 1 picture**. If that file lands
   correctly, click **Download**. The first time, Chrome asks once to allow this site to
   download multiple files → **Allow**.
3. Files are named `YYYY-MM-DD_HH-MM-SS - <prompt> - <id>.jpg|png|mp4` (or prompt first,
   your choice) so they sort by creation time.

Every saved file is remembered by its media id, so you can click Download again any time and
only new items are fetched.

## Upscaled pictures (2K / 4K)

Flow's "2K / 4K Upscaled" download is not a stored file: Flow upscales on demand through a
reCAPTCHA-protected call that only its own page code can make. So **Picture quality →
Upscaled** drives Flow's own UI: it finds each picture's tile in the project grid (scrolling
the grid if needed), opens the tile's menu, picks *Download → 2K/4K Upscaled*, and lets Flow
do the upscale and the download. When it can intercept the file it saves it under the normal
name with a `[2K Upscaled]` tag; otherwise Flow saves it under its own name and the script
records it as done.

Because Flow throttles downloads and caps upscales per day, this mode is deliberately slow
and careful:

- Strictly one picture at a time, waiting for each file to finish. Use *Mode → Tampermonkey*
  for a real "saved to disk" signal; plain browser downloads only get a size-based wait.
- **Pause between upscales** (default 8 s). **Max per run** budgets a single run.
- **Daily cap**: if you know Flow's limit, enter it and the script stops *before* Flow
  refuses, using its own count of upscales in the last 24 h (shown in the status line).
- Flow's toasts are watched. "Upscale failed" → the original is saved instead (if the
  fallback box is ticked) and the picture is not retried for upscaling. A daily-limit
  message → **On daily limit** decides: stop the run (default) or continue with originals.
  Either way upscaling pauses for the configured hours (default 24); *Reset limit pause*
  overrides.
- Pictures whose tile or menu cannot be reached are **deferred** (nothing downloaded) and
  retried next run. Three failures in a row pause two minutes; six stop the run.

Keep the Flow tab in the **foreground** while an upscaled run is going: Flow's grid only
renders tiles while the tab is visible. Upscaled mode works for the project open in the tab;
videos are always saved at original quality.

## Learn mode (when Flow changes)

Google renames internal RPC ids and menu labels with frontend builds. Under **Learn &
tools**, tick **Learn from my clicks**, then download one picture by hand the way you
normally would (hover → menu → Download → 2K Upscaled). Click **Refresh learned**: the box
shows the RPC ids and labels the page actually used. **Apply learned to Advanced** writes
them into the settings, and **Test 1 picture** confirms. The learned values are also included
in the Diagnose export.

## Folders, manifest and prompt sidecars

Under **Saving & folders**:

- *Mode → Tampermonkey* saves into `Downloads/<Base folder>/<Project>/<YYYY-MM>/…` when
  **Folder per project** / **Folder per month** are ticked. Tampermonkey may ask you once to
  whitelist file extensions (Dashboard → Settings → Downloads BETA: add
  `jpg png webp mp4 txt json csv`). If that mode fails for a file, the script falls back to a
  plain browser download so nothing is lost.
- **Prompt sidecar** writes a `.txt` (prompt, date, project, model, quality) or `.json`
  (full metadata) next to each file.
- **CSV manifest after each run** writes `manifest-<timestamp>.csv` with media id, project,
  prompt, created time, kind, model, quality, filename, size and status. **Export full
  manifest** (CSV or JSON) dumps everything ever saved.

## Filters

**What to download** supports, besides the date range and types: **Prompt contains** /
**but not** (comma-separated terms, OR'd; wrap a term in `/slashes/` for a regex), **Model
contains** (e.g. `NARWHAL`, `GEM_PIX`, `veo`, `abra`), and **Exclude my uploaded reference
images** (experimental: skips items that have no generation record).

## Automation

- **Auto-check every N min** re-scans while the tab stays open.
- **Run on page load if last run older than N h** starts a run automatically when Flow
  opens. For Upscaled mode set **Auto project**; on the home page the script opens that
  project first.
- For unattended daily pulls, let Windows open Flow each morning:

  ```powershell
  cd schedule
  .\Register-FlowTask.ps1 -Time 08:00 -Url "https://flow.google.com/project/<your-project-id>"
  ```

  Add `-ProfileDirectory "Profile 2"` if Flow is signed in under a non-default Chrome
  profile; `-Unregister` removes the task. Chrome must already be signed in; the script never
  touches passwords. Keep that window in the foreground for Upscaled mode.
- **Desktop notifications** fire when a run finishes or the daily limit is hit.
- **Refresh credits** shows your Flow credit balance and plan in the status line.

## Backup and history

**Export backup** saves settings, download history, discovered projects, manifest and
learned values as JSON; **Import backup…** restores/merges it on another machine or after a
Tampermonkey reinstall. **Mark all current as done** records everything currently in the
selected projects as downloaded, so future runs only pick up newer items. **Clear history**
forgets everything (files on disk are untouched).

## How it works

Flow moved to `flow.google.com` in September 2026 and its web app talks to Google's
`batchexecute` RPC endpoint. For originals the script uses two RPCs that several open-source
Flow clients have mapped and which are **not** CAPTCHA-gated:

| RPC | Purpose |
|---|---|
| `Zzl0ze` | List every media item in a project (title, creation time, media id, image/video) |
| `as29s`  | For one media id, mint fresh signed download URLs on `flow-content.google` |
| `nzlxg`  | Credit balance and plan |

Requests are signed the same way the page signs its own (session cookies plus the page's
`at` / `f.sid` / `bl` tokens). Upscales go through Flow's own menu, so Flow's page code does
the reCAPTCHA and the upscale; the script only automates the clicks, paces them and watches
the outcome. The ids above live under **Advanced** and can be changed or learned.

## If something breaks

1. Click **Scan**, then **Diagnose**. A `flow-bulk-diagnose-….json` file is saved with a
   trimmed, *redacted* sample of what Flow returned (signed URLs, tokens and ids removed),
   the tile markup, the menu texts last seen, recent toasts and learned values.
2. Try **Learn mode** (above) if the menu labels or RPC ids moved.
3. Share the Diagnose file and the parser/selectors can be adjusted quickly.

No **⬇ Flow Export** button? Reload the Flow tab, check that Developer mode (or "Allow User
Scripts" on Tampermonkey's details page) is on in `chrome://extensions`, and make sure
Tampermonkey shows version 0.3.1 or later (Dashboard → Installed userscripts → Last updated;
0.3.0 could not draw its panel on flow.google.com). Then open DevTools (F12) → Console and
look for a line starting with `[Flow Bulk Downloader]`.

Common messages: *"No session token on this page"* → reload the Flow tab (signed out?).
*"Flow answered with an HTML page"* → sign in again. *"no Download entry in the tile
menu: …"* → the menu texts are listed; set **Download menu label** under Advanced or use
Learn mode.

## Alternatives worth knowing

- **Google Takeout** exports Flow: all generated media plus prompts and project structure,
  optionally every 2 months. No date filter, arrives hours later as a zip. Good for a
  one-time full backup. https://support.google.com/flow/answer/17571126
- **Chrome Web Store extensions** such as "Flow Auto Downloader" auto-scroll a project and
  click Flow's own download buttons; slower, mostly freemium, no date filter.

## Development

```bash
npm test                 # unit tests for the parsing/naming/filter helpers
npm run check            # syntax check + tests
npm run harness          # serve this folder, then open http://localhost:8765/test/harness.html
```

`test/harness.html` fakes Tampermonkey's APIs, Flow's tokens, a batchexecute backend and a
project grid with hover menus, including a failing upscale and a fake daily limit, so the
whole panel can be exercised without touching Google.

## Limitations

- Needs a signed-in Flow tab; it cannot run with the browser closed.
- Project discovery relies on project links rendered on the Flow home page; visit it once.
- Items whose creation time cannot be read are skipped unless *Include items with no date*
  is ticked; inferred times are labelled `date≈`.
- Google's internal protocol and UI can change without notice; see Learn mode and Diagnose.
