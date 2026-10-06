# Changelog

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
