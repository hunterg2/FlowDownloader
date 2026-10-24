# Changelog

## 0.3.11 — 2026-10-24

- **The round ⬇ Flow Export button can be dragged too.** Drag it anywhere; a plain click still opens the panel. It shares its spot with the panel and the run card.
- Opening the panel from a button near the left edge no longer moves the button when the panel closes.

## 0.3.10 — 2026-10-23

- **4K counts separately from 2K.** A 4K run downloads items whose 2K (or 1080p) is already saved. The original, the standard upscale and 4K each have their own entry in the history; existing upscaled entries count as 2K / 1080p.
- If 4K isn't available (locked on your plan) and Flow's menu only offers a size that is already saved, the item is deferred instead of saved again.
- README: new FAQ entries on how the history tracks each quality and why a 2K run can save some originals; harness switches documented.

## 0.3.9 — 2026-10-23

- **"Stop the run" on the daily limit now really stops.** Flow doesn't always word the limit clearly, so the script took it for an ordinary failed upscale and saved originals instead. Now two failed upscales in a row, or upscale entries greyed out in Flow's menu, count as the daily limit and follow the **On the daily limit** setting.
- **An original saved after a failed upscale no longer counts as done for upscaled runs.** The item stays queued and the next upscaled run tries the upscale again, without saving the original a second time. The same goes for "continue with originals" after the limit: items whose original is already saved are not downloaded again.
- Pressing Stop during an upscale no longer saves the original as a fallback.
- The history now records the quality each file was saved at (for example "2K Upscaled").

## 0.3.8 — 2026-10-23

- **Videos can be upscaled too.** The Download tab has a quality switch for each type: **Pictures** (Original | Upscaled 2K) and **Videos** (Original | Upscaled 1080p), so they can be mixed. Upscaled videos go through Flow's own video menu (270p GIF / 720p Original / 1080p Upscaled / 4K Upscaled) and are saved as `… [1080p Upscaled].mp4`. **Video size** sits next to **Picture size** under Options → Upscaling.
- Video upscales get three times the upscale timeout and their own time estimate.
- Each quality row only shows when that type is ticked.

## 0.3.7 — 2026-10-23

- **Settings lock while a run is going.** Every option, the project list and the buttons that change state (Clear history, Import backup, Reset limit pause, Learn) are disabled until the run ends, with a note saying why. The run uses what was set when it started; before, a button such as Export backup saved the form and could change a run partway through.
- **README rewritten as a how-to guide:** installing Tampermonkey, updating, downloading at original quality and at 2K, the panel, an FAQ (what counts as already downloaded, using Flow or other tabs during a run, minimizing) and tips for new users.

## 0.3.6 — 2026-10-23

- **Cleaner, tabbed panel.** A status strip at the top (signed in, project, history count, upscales in the last 24 h), then three tabs: **Download** (dates, type, quality, buttons, progress card), **Options** (filters, upscaling, projects, saving, automation, each heading showing its current settings) and **Tools** (history, exports, backup, Diagnose, Learn, Advanced).
- **Progress card** with a big "3 / 11" count, bar, the current step, time left and a saved/failed/deferred tally. After a scan, the Download button shows how many items it would fetch.
- **Small run card during downloads.** The panel shrinks to a short card in the bottom corner so Chrome's download pop-up (top right) no longer covers the progress. ⤢ opens the full panel; it comes back by itself when the run ends.
- **Drag the panel** by its header; it remembers the spot (double-click the header to reset).
- **Log folded by default** with a new-lines badge; it opens on its own when something fails or is deferred, and has a Copy button.
- A hideable tip explains how to turn off Chrome's download pop-up.

## 0.3.5 — 2026-10-23

- **Upscaled mode no longer re-scrolls the whole grid for every picture.** Flow's grid is virtual and sorted newest first by a timestamp in the listing, so the script jumps straight to where each picture should be and corrects from the tiles on screen (on a real 5,500-tile project every test picture was found within two jumps, in 1–6 s). Pictures Flow does not show in the grid are recognised quickly instead of after a full sweep; the full sweep remains only as a fallback.
- **Live activity line** under the buttons: which picture is being worked on, the current step ("Scrolling the grid to it", "Flow is upscaling to 2K… 6 s", "Waiting before the next picture… 5 s left", "⏸ Paused"), and about how long the run has left.
- **Scan (dry run) shows a clear summary** under the buttons (what would be downloaded or upscaled, a time estimate, what was skipped) and scrolls to the list of matching items, now headed with its count.
- The panel header shows the installed version (it always said v0.3.0).

## 0.3.4 — 2026-10-23

- **Upscaled runs pause while the Flow tab is hidden** instead of deferring every picture. The log shows "⏸ Paused: the Flow tab is hidden" and the run carries on when you switch back; a picture interrupted by switching away is retried, not deferred.
- **Fix: some pictures were treated as videos** and failed with "no download URL available". A flag on Flow's grid entries that older notes read as "is video" is set on ordinary pictures too (299 of 323 "videos" in a real project were pictures). The generation record now decides the kind.

## 0.3.3 — 2026-10-23

- **Fix: Upscaled mode deferred every picture on the live site.** Flow reveals each tile's hover toolbar with CSS `:hover`, which scripted mouse events cannot trigger, so the script never saw a visible "More options" button. It now clicks the labelled menu button even while hidden; Flow opens the menu normally (verified on flow.google.com).
- Locked sizes (such as 4K behind "Upgrade") are skipped; the best enabled upscaled size is used instead.
- Test harness hides its tile toolbar with CSS `:hover` and disables 4K, like Flow.

## 0.3.2 — 2026-10-23

- **Fix: every picture was listed twice on the live site.** Flow's generation records carry the media id in their first field, not the third as older open-source notes said, so grid entries and records never merged. The parser now works out the layout from the data itself (verified against a real project) and both layouts are covered by tests.
- Pictures that only appear as generation records and not in the project grid (in practice, reference images used in prompts) are skipped by default; tick *Include pictures not shown in the project grid* to get them. The scan log shows how many there are.

## 0.3.1 — 2026-10-23

- **Fix: the ⬇ Flow Export button never appeared on flow.google.com.** Flow enforces Trusted Types, which blocks building the panel from an HTML string. Panel markup now goes through a Trusted Types policy, with a node-by-node fallback builder if a policy cannot be created.
- The panel re-mounts if the page removes it and logs a clear console error instead of failing silently.
- Test harness: `?tt=1` enforces Trusted Types like Flow, `?tt=strict` also forces the fallback builder.

## 0.3.0 — 2026-10-06

- **Learn mode**: watch Flow's own traffic and the menus you click while downloading one picture by hand, then propose and apply the current RPC ids and menu labels.
- **Test 1 picture** button to validate the whole path before a bulk run.
- **Manifest**: CSV after each run plus full CSV/JSON export; optional `.txt`/`.json` prompt sidecar next to each file.
- **Folders**: per-project and per-month folders and a choice of filename pattern (Tampermonkey mode).
- **Automation**: "Run on page load if last run older than N h", auto project for Upscaled mode, desktop notifications, and `schedule/Register-FlowTask.ps1` to open Flow daily via Task Scheduler.
- **Limits**: local daily upscale cap that pauses before Flow refuses, "upscales in last 24 h" counter, credit balance lookup.
- **Backup**: export/import settings + history, "Mark all current as done".
- **Filters**: prompt keyword include/exclude (with `/regex/`), model contains, exclude uploaded reference images (experimental).
- Auto-update headers pointing at the GitHub repo; MIT license; `npm test`.

## 0.2.0 — 2026-10-06

- Upscaled quality mode driving Flow's own Download menu, with pacing, per-file completion waits, toast watching for "upscale failed" and the daily limit, deferral of unreachable tiles, and backoff after repeated failures.

## 0.1.0 — 2026-10-06

- First version: list project media via Flow's internal RPCs, filter by date and type, download originals with date-based filenames, dedupe history, auto-check timer, Diagnose export.
