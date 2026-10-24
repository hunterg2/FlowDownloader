# Flow Bulk Downloader

**Download all your Google Flow pictures and videos at once, at original quality or upscaled
(2K pictures, 1080p videos), instead of saving them one by one.**

Flow Bulk Downloader is a small add-on for your browser (a Tampermonkey userscript). It adds a
**⬇ Flow Export** button to [Google Flow](https://flow.google.com). Pick a date range, press
**Download**, and it saves everything you made in that time into your Downloads folder, named by
the date it was created so the files sort in order. It remembers what it already saved, so next
time it only fetches what's new.

- **Original quality:** fast. Saves the files Flow already stores.
- **Upscaled:** slower. Has Flow upscale each picture to 2K and each video to 1080p, one at a
  time, the same way you would by hand. Pictures and videos each have their own setting.
- Runs entirely inside your own signed-in Flow tab. Nothing is sent anywhere else: it only
  talks to Flow, using your existing session, the same way the Flow website does.

**Contents:** [Install](#install) · [Update](#update) ·
[Download at original quality](#download-at-original-quality) ·
[Download upscaled](#download-upscaled-2k-pictures-1080p-videos) · [The panel](#the-panel) · [FAQ](#faq) ·
[Tips for new users](#tips-for-new-users) · [If something breaks](#if-something-breaks) ·
[Reference](#reference)

---

## Install

You do this once. It takes about two minutes.

**1. Install Tampermonkey.** Tampermonkey is a free browser extension that runs userscripts like
this one. Get it from your browser's store:
[Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) ·
[Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) ·
[Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/). It's built and tested in
Chrome; Edge and Brave work the same way.

**2. Let Tampermonkey run scripts (Chrome, Edge, Brave).** Chrome only lets extensions run
userscripts once you switch this on:

1. Go to `chrome://extensions` (paste it into the address bar).
2. Find **Tampermonkey** and click **Details**.
3. Turn on **Allow User Scripts**. Older Chrome versions don't have that switch: turn on
   **Developer mode** in the top-right corner of `chrome://extensions` instead.

Tampermonkey shows a banner if this step is still needed.

**3. Install the script.** Open this link:

> **https://raw.githubusercontent.com/hunterg2/FlowDownloader/main/flow-bulk-downloader.user.js**

Tampermonkey opens an install page showing the script's name and version. Click **Install**.
Installing from that link is what lets it update itself later.

**4. Set up Chrome's downloads.** In Chrome Settings → **Downloads**:

- Turn **off** "Ask where to save each file before downloading". Otherwise Chrome asks
  about every single file.
- Optional: turn **off** "Show downloads when they're done", so Chrome's download pop-up
  doesn't keep appearing in the top-right corner during a run. Files still save normally.

**5. Open Flow.** Go to **https://flow.google.com** and sign in. A blue **⬇ Flow Export** button
appears in the bottom-right corner. If it doesn't, reload the page once.

## Update

The script updates itself: Tampermonkey checks the link above for a newer version every day
and installs it.

To get an update straight away:

1. Click the Tampermonkey icon in the toolbar (inside the puzzle-piece menu if it isn't pinned)
   → **Check for userscript updates**. Or open the install link above again and click
   **Update** (or **Reinstall**).
2. **Reload the Flow tab.** An update only takes effect when the page loads again; a tab that
   was already open keeps running the old version.
3. Check the panel's header. It shows the version, for example **⬇ Flow Export v0.3.7**. The
   [changelog](CHANGELOG.md) lists what changed in each version.

Updating never loses your download history or settings.

## Download at original quality

This is the quick way. It saves the files exactly as Flow stores them, usually a few seconds each.

1. Open the **project** you want in Flow and click **⬇ Flow Export**.
2. On the **Download** tab, set **From** to the date and time to start from. Leave **To** empty
   to go up to now.
3. Tick **Pictures**, **Videos** or both. Leave **Skip already saved** ticked.
4. Set the **Pictures** and **Videos** quality switches to **Original**.
5. Click **Scan**. Nothing is downloaded: it shows how many items match and roughly how long
   they would take, and lists them under **Matching items**. The Download button now shows the
   count, for example **Download 42**.
6. Click **Test 1**. It saves just the newest matching item, so you can check it lands where
   you expect. The first time, Chrome asks whether this site may **download multiple files**:
   click **Allow**.
7. Click **Download**. The panel shrinks to a small progress card in the corner while it works,
   and comes back when the run is done.

Files land in your Downloads folder, named like
`2026-10-21_14-03-55 - a red fox in the snow - 0f3a9c2e.png`. Sort the folder by name or
date to find them.

**Several projects at once:** in Original mode you can download from more than one project in
one go. Visit the Flow home page once so the script sees your projects, then go to
**Options → Projects**, choose **Selected projects** and tick the ones you want.

## Download upscaled (2K pictures, 1080p videos)

Flow's upscaled downloads aren't stored files. Flow makes them on request, behind a security
check that only Flow's own page can pass. So in this mode the script works Flow's page for you,
the same way you would by hand: it scrolls to each picture or video, opens its menu, picks
**Download → 2K Upscaled** (pictures) or **1080p Upscaled** (videos), waits for Flow to finish,
then moves on. That makes it slower: about **20 seconds per picture**, and longer per video.

Pictures and videos each have their own quality switch on the **Download** tab, so you can mix
them: for example 2K pictures with original videos, or original pictures with 1080p videos.

1. Open the **project** in Flow. Upscaled mode works on the project open in the tab.
2. Click **⬇ Flow Export**, set **From** (and **To** if you like), and tick **Pictures**,
   **Videos** or both.
3. Set the **Pictures** switch to **Upscaled 2K** and/or the **Videos** switch to
   **Upscaled 1080p**. The hint underneath shows the time per item.
4. Click **Scan** to see what will be upscaled and how long the run will take.
5. Click **Test 1** to check that a single upscaled file works.
6. Click **Download**, then **leave the Flow tab alone and visible** until it's done (the
   [FAQ](#faq) covers what you can and can't do meanwhile).

Good to know:

- Upscaled files get a tag in their name, such as `[2K Upscaled]` or `[1080p Upscaled]`. If
  Flow saves a file under its own name instead, the script still records it as done.
- **Flow limits how many upscales you can do per day.** When Flow says the limit is reached,
  the run stops (or carries on with originals, if you choose that under **Options →
  Upscaling → On the daily limit**) and upscaling pauses for 24 hours. The top strip shows how
  many upscales you've done in the last 24 hours. If you know your limit, enter it as the
  **Daily cap** and the script stops just before it.
- If an upscale fails, the original is saved meanwhile, so you still get the picture or video.
  It stays queued, and the next upscaled run tries the upscale again (without saving the
  original twice).
- Flow doesn't always say clearly that the limit is reached, so **two failed upscales in a
  row**, or upscale entries greyed out in Flow's menu, also count as the daily limit.
- An item it couldn't reach (for example because the page was busy) is **deferred**:
  nothing is saved, it isn't marked as done, and the next run tries it again.
- **Original and upscaled are tracked separately.** If you already saved something at original
  quality, an upscaled run still downloads it again, upscaled.
- 4K (for pictures and videos) is a paid Flow option. When it's locked, the best available size
  is used.

## The panel

- **Top strip:** whether you're signed in, which project is open, how many files are in the
  download history and, in Upscaled mode, upscales used in the last 24 hours. A yellow line
  appears if upscaling is paused because Flow's daily limit was hit.
- **Download tab:** what you change each run: dates, pictures/videos, a quality switch for
  each (Original or Upscaled), the buttons, and
  a **progress card** with the count ("3 / 11"), a bar, the current step, the time left and how
  many were saved, failed or deferred.
- **Options tab:** filters, upscaling, projects, saving and automation. Each section's heading
  shows its current setting, so you don't need to open it to check.
- **Tools tab:** history, exports and backup, Diagnose, credits, Learn mode and Advanced.
- **Log:** folded by default, with a badge counting new lines. It opens by itself if something
  fails or is deferred. **Copy** puts the whole log on your clipboard.
- **During a download** the panel shrinks to a small card in the bottom corner, below where
  Chrome's download pop-up appears. **⤢** opens the full panel, **▁** shrinks it back, **■**
  stops. The full panel comes back by itself when the run ends.
- **Settings lock while a run is going.** The run uses what was set when it started; press
  **Stop** to change them.
- **Move it** by dragging its header. It remembers where you put it; double-click the header to
  put it back in the corner. **✕** closes it to the round button; a running download keeps going.

## FAQ

**How does it know what I've already downloaded?**
Every Flow picture and video has its own ID. When a file saves, the script writes that ID into a
download history kept in Tampermonkey's own storage (with the file name, date and project). With
**Skip already saved** ticked, anything in that history is skipped. The **"N in history"** chip in
the top strip shows how many entries it holds. It never looks at your Downloads folder.

**If I move the downloaded files out of my Downloads folder, will it download them again?**
No. Moving, renaming or deleting the files changes nothing, because the history is separate
from the files. It only downloads something again if:
- you untick **Skip already saved**;
- you press **Tools → Clear history**;
- the history is lost: the script or Tampermonkey is reinstalled, or you use another browser or
  Chrome profile (each has its own history);
- you switch from Original to Upscaled (each quality is tracked separately).

**I lost my history (new PC, reinstall). How do I avoid downloading everything again?**
Before a reinstall or a move, use **Tools → Export backup**, and **Import backup…** afterwards.
If the history is already gone, **Tools → Mark all current as done** records everything in the
project (all dates, for the types, filters and quality you've set) as downloaded without
downloading anything, so future runs only fetch newer items.

**Can I click around in Flow while it's downloading?**
It depends on the quality:
- **Original:** yes. It fetches the files directly and doesn't touch the page, so you can
  scroll, open other projects, or use other tabs and windows.
- **Upscaled:** keep your hands off the Flow page. The script is scrolling and clicking
  the page itself. A click of yours can close the menu it just opened, and opening another
  project takes away the picture it was looking for. Nothing breaks if you do: that picture is
  just deferred to the next run. Using the panel or the small card (expand, shrink, Stop,
  dragging) is always fine.

**Can I minimize the window or switch to another tab?**
- **Original:** yes. It keeps going in the background (Chrome may slow it down a little).
- **Upscaled:** it **pauses** ("⏸ Paused: the Flow tab is hidden") and carries on when you
  come back. Flow only draws its pictures while the tab is visible, so the script can't work the
  page while it's hidden. Working in **another window** is fine as long as the Flow window stays
  visible, for example on a second monitor or side by side.

**Can I change Tampermonkey's settings, or the script's options, during a run?**
Changing Tampermonkey's settings, turning the script off or installing an update doesn't stop a
run in progress; those only apply when the Flow page loads again. The script's own settings are
locked while a run is going; press **Stop** first if you need to change something.

**What stops a run?**
Pressing **Stop** (it finishes the current file first), reloading the Flow tab, closing it, or
closing the browser. Nothing is lost: everything already saved is in the history, and anything
unfinished isn't marked as saved, so the next run picks up where this one left off.

**Chrome's download pop-up keeps covering things. Can I get rid of it?**
During a run the panel shrinks to a small card in the bottom corner, below where the pop-up
appears. To stop the pop-up altogether: Chrome Settings → Downloads → turn off **Show downloads
when they're done**. Files still save normally.

**Where do the files go? Can I save them into folders?**
By default, straight into your browser's Downloads folder with no subfolders. For subfolders
(for example `Downloads/Flow/<project>/<month>/`), go to **Options → Saving & folders**, set
**Save with → Tampermonkey** and tick **Folder per project** / **Folder per month**. See
[Folders and files](#folders-and-files).

**Chrome asked whether this site can download multiple files.**
Click **Allow**. Chrome asks this once per site. If you clicked **Block** by mistake, click the
download icon at the right of the address bar to change it.

**Does it use my Flow credits?**
Downloading originals doesn't. Upscaling costs whatever Flow normally charges for an upscaled
download, the same as doing it by hand. **Tools → Check credits** shows your balance in the top
strip.

**Is it safe? Does it see my password?**
It never touches your password, and it sends nothing anywhere except to Flow itself. It uses the
session your signed-in tab already has, exactly like the Flow website does. The whole script is
one readable file in this repo.

## Tips for new users

- **Always Scan first.** It costs nothing, shows exactly what would be downloaded and how long
  it will take, and catches a wrong date before you've saved 500 files.
- **Then Test 1.** One file is the quickest way to check the name, folder and quality are what
  you want.
- **Start small with upscaling.** Try a day or two first. Upscaling is slow (about 20 s per
  picture, longer per video)
  and limited per day, so a big run can take hours and hit the limit partway. It simply picks
  up the rest next time.
- **Do originals first, upscaled later.** Save everything at original quality quickly, then run
  an upscaled pass over the pictures and videos you actually want bigger, using a narrow date range or the
  **Prompt contains** filter (Options → Filters).
- **Keep the computer awake** during long runs. If it goes to sleep, the run stalls; anything
  that failed is tried again on the next run.
- **Use the To date** to download a particular stretch, for example one week.
- **Reference images you uploaded** are left out by default. Tick **Include pictures not shown
  in the project grid** (Options → Filters) if you want them too.
- **Back up your history** (Tools → Export backup) before reinstalling Tampermonkey,
  resetting the browser or moving to another PC.
- **Watch the progress card, not the log.** The card says what's happening and how long is left;
  the log opens by itself if something needs your attention.
- **One project at a time for upscaling.** Upscaled mode works on the project open in the tab;
  items from other projects are deferred until you open them.
- **Let it run on its own:** **Options → Automation** can check for new items every few
  minutes while the tab is open, or start a run whenever Flow opens. See
  [Automation](#automation).

## If something breaks

1. Reload the Flow tab and check the panel header shows the latest version ([Update](#update)).
2. Click **Scan**, then **Tools → Diagnose**. It saves a `flow-bulk-diagnose-….json` file with a
   trimmed, **redacted** sample of what Flow returned (download links, tokens and IDs removed),
   plus the menu texts and messages it last saw.
3. Google changes Flow from time to time. If the menu labels moved, try
   [Learn mode](#learn-mode-when-flow-changes).
4. [Open an issue](https://github.com/hunterg2/FlowDownloader/issues) describing what happened,
   with the log (**Copy**) and the Diagnose file.

**No ⬇ Flow Export button?** Reload the Flow tab. Check that **Allow User Scripts** (or Developer
mode) is on for Tampermonkey in `chrome://extensions`, and that Tampermonkey shows the script as
enabled. Then open DevTools (F12) → Console and look for a line starting with
`[Flow Bulk Downloader]`.

**Common messages:**
- *"No session token on this page"*: reload the Flow tab (you may have been signed out).
- *"Flow answered with an HTML page"*: sign in to Flow again.
- *"no Download entry in the tile menu: …"*: Flow renamed its menu. The menu texts are listed;
  set **Download menu label** under Tools → Advanced, or use Learn mode.

---

## Reference

### Folders and files

Under **Options → Saving & folders**:

- The default **Save with → Browser download** saves every file straight into your browser's
  Downloads folder, with no subfolders.
- **Save with → Tampermonkey** saves into `Downloads/<Base folder>/<Project>/<YYYY-MM>/…` when
  **Folder per project** / **Folder per month** are ticked. It also gives upscaled runs a reliable
  "saved to disk" signal. Tampermonkey may ask you once to allow file extensions (Dashboard →
  Settings → Downloads BETA: add `jpg png webp mp4 txt json csv`). If this mode fails for a
  file, the script falls back to a plain browser download so nothing is lost.
- **File name:** date first (default) or prompt first:
  `YYYY-MM-DD_HH-MM-SS - <prompt> - <id>.jpg|png|mp4`.
- **Prompt sidecar** (Tampermonkey mode) writes a `.txt` (prompt, date, project, model,
  quality) or `.json` (full details) next to each file.
- **CSV manifest after each run** writes `manifest-<timestamp>.csv` with media ID, project,
  prompt, created time, kind, model, quality, file name, size and status. **Tools → Manifest
  (CSV)** / **(JSON)** exports everything ever saved.

### Filters

**Options → Filters** narrows the date range and types further: **Prompt contains** / **but not**
(comma-separated terms, any of them matches; wrap a term in `/slashes/` for a regular
expression), **Model contains** (e.g. `NARWHAL`, `GEM_PIX`, `veo`, `abra`), and **Leave out my
uploaded reference images** (experimental: skips items that have no generation record).

Only pictures shown in the project grid are downloaded by default. Flow's listing also contains
the reference images used in prompts; tick **Include pictures not shown in the project grid** to
save those too. **Include items with no date** adds items whose creation time can't be read.

### Upscaling settings

Under **Options → Upscaling**:

- **Picture size:** 2K (default), or 4K if your Flow plan allows it. **Video size:** 1080p
  (default), or 4K if your plan allows it.
- Video upscales take longer, so they get three times the **Upscale timeout** (Tools → Advanced).
- **Pause between** upscales (default 8 s) and **Max per run** keep each run modest.
- **Daily cap:** stops before Flow's daily limit, using the script's own count of the last
  24 hours.
- **On the daily limit:** stop the run (default) or continue with originals, **and pause
  upscaling for** N hours (default 24). **Reset limit pause** overrides it.
- **If an upscale fails, save the original meanwhile** (on by default). The item stays queued
  for upscaling. Two failed upscales in a row count as the daily limit.
- Three failures in a row pause two minutes; six stop the run.

### Automation

- **Auto-check every N min** re-scans and downloads new items while the tab stays open.
- **Run on page load if the last run is older than N h** starts a run automatically when Flow
  opens. For Upscaled mode set **Auto project**; on the home page the script opens that project
  first.
- For unattended daily pulls, let Windows open Flow each morning:

  ```powershell
  cd schedule
  .\Register-FlowTask.ps1 -Time 08:00 -Url "https://flow.google.com/project/<your-project-id>"
  ```

  Add `-ProfileDirectory "Profile 2"` if Flow is signed in under a non-default Chrome profile;
  `-Unregister` removes the task. Chrome must already be signed in; the script never touches
  passwords. Keep that window in the foreground for Upscaled mode.
- **Desktop notifications** fire when a run finishes or the daily limit is hit.

### Backup and history

**Tools → Export backup** saves settings, download history, discovered projects, manifest and
learned values as a JSON file. **Import backup…** loads it back (settings are replaced; history
and manifest are merged). **Mark all current as done** records everything in the selected
project(s) as downloaded, for all dates, without downloading. **Clear history** forgets the
history (files on disk are untouched).

### Learn mode (when Flow changes)

Google renames internal IDs and menu labels from time to time. Under **Tools → Learn from my
clicks**, tick **Watch Flow's traffic and menus…**, then download one picture by hand the way you normally would (hover →
menu → Download → 2K Upscaled). Click **Refresh learned**: the box shows the IDs and labels the
page actually used. **Apply learned to Advanced** writes them into the settings, and **Test 1**
confirms. The learned values are also included in the Diagnose file.

### How it works

Flow moved to `flow.google.com` in September 2026, and its web app talks to Google's
`batchexecute` RPC endpoint. For originals the script uses calls that several open-source Flow
clients have mapped and which are **not** behind a CAPTCHA:

| RPC | Purpose |
|---|---|
| `Zzl0ze` | List every media item in a project (title, creation time, media ID, picture/video) |
| `as29s`  | For one media ID, get fresh signed download links on `flow-content.google` |
| `nzlxg`  | Credit balance and plan |

Requests are signed the same way the page signs its own (session cookies plus the page's tokens).
Upscales go through Flow's own menu, so Flow's page code does the security check and the
upscale; the script only automates the clicks, paces them and watches the outcome. The IDs above
live under **Tools → Advanced** and can be changed or learned.

### Alternatives worth knowing

- **Google Takeout** exports Flow: all generated media plus prompts and project structure,
  optionally every 2 months. No date filter, and it arrives hours later as a zip. Good for a
  one-time full backup. https://support.google.com/flow/answer/17571126
- **Chrome Web Store extensions** such as "Flow Auto Downloader" auto-scroll a project and click
  Flow's own download buttons. They're slower, mostly freemium, and have no date filter.

### Limitations

- Needs a signed-in Flow tab open; it can't run with the browser closed.
- Selecting several projects relies on the project links on the Flow home page; visit it once.
- Items whose creation time can't be read are skipped unless *Include items with no date* is
  ticked; guessed times are labelled `date≈`.
- Google's internal protocol and page can change without notice; see Learn mode and Diagnose.

### Development

```bash
npm test                 # unit tests for the parsing/naming/filter helpers
npm run check            # syntax check + tests
npm run harness          # serve this folder, then open http://localhost:8765/test/harness.html
```

`test/harness.html` fakes Tampermonkey's APIs, Flow's tokens, a batchexecute backend and a
project grid with hover menus, including a failing upscale and a fake daily limit, so the whole
panel can be exercised without touching Google.
