// ==UserScript==
// @name         Flow Bulk Downloader
// @namespace    https://github.com/hunterg2/FlowDownloader
// @version      0.3.13
// @description  Bulk-download every image/video in your Google Flow projects created since a chosen date, at original or upscaled quality, with manifests, folders, filters and rate-limit handling. Runs entirely inside your signed-in flow.google.com tab.
// @author       hunterg2
// @homepageURL  https://github.com/hunterg2/FlowDownloader
// @supportURL   https://github.com/hunterg2/FlowDownloader/issues
// @updateURL    https://raw.githubusercontent.com/hunterg2/FlowDownloader/main/flow-bulk-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/hunterg2/FlowDownloader/main/flow-bulk-downloader.user.js
// @match        https://flow.google.com/*
// @match        https://labs.google/fx/tools/flow*
// @run-at       document-idle
// @sandbox      raw
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      flow-content.google
// @connect      googleusercontent.com
// @connect      flow.google.com
// @noframes
// ==/UserScript==

/*
  HOW IT WORKS (short version)
  ----------------------------
  Flow's web app (flow.google.com, Sept 2026 rewrite) talks to its backend through
  Google's "batchexecute" RPC endpoint. Two of those RPCs are all we need for
  original-quality files, and neither is reCAPTCHA-gated:

    Zzl0ze  -> list every media item in a project (title, created time, media id, kind)
    as29s   -> for one media id, return fresh *signed* download URLs on flow-content.google

  The script signs requests the same way the page does (session cookies + the
  page's own `at`/`f.sid`/`bl` tokens from window.WIZ_global_data), so it only
  works while you are signed in and the Flow tab is open. Nothing is sent to any
  third party; all state lives in Tampermonkey storage on this machine.

  UPSCALED QUALITY
  ----------------
  Flow's "2K / 4K Upscaled" image download is computed on demand by a
  reCAPTCHA-protected RPC that only Flow's own page code can call. So for
  "Upscaled" quality the script drives Flow's own UI: it finds each picture's
  (or video's) tile in the project grid, opens the tile's Download menu and picks
  the upscaled entry (2K for pictures, 1080p for videos). Flow performs the upscale and the download; the script paces
  the clicks, waits for each file, watches Flow's toasts for "upscale failed"
  and the daily limit, and renames the file when it can intercept it.

  LEARN MODE
  ----------
  Google renames RPC ids and menu labels with frontend builds. With "Learn from
  my clicks" on, the script passively watches the page's own traffic and the
  menus you use while you download one picture by hand, then proposes the
  RPC ids / labels it observed. "Apply learned" writes them into Advanced.

  If a scan returns nothing, use Diagnose: it exports a redacted JSON sample of
  what the page returned so the parser can be adapted.
*/

(function () {
  'use strict';

  const IS_NODE = typeof module !== 'undefined' && module.exports && typeof window === 'undefined';
  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : (typeof window !== 'undefined' ? window : {});
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.3.13';

  // ---------------------------------------------------------------------------
  // Pure helpers (also exported for unit tests)
  // ---------------------------------------------------------------------------

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CONTENT_HOST = 'flow-content.google';
  const POSTER_HOST = 'googleusercontent.com';
  const FLOW_LAUNCH_MS = Date.UTC(2025, 0, 1); // anything older than this is not a Flow creation time
  const MODEL_RE = /^(veo[_0-9a-z.]*|abra_[a-z0-9_]+|omni[_a-z0-9]*|GEM_PIX[_0-9]*|NARWHAL|HARBOR_SEAL|IMAGEN[_0-9.]*|R2I|nano[_a-z0-9]*|gemini[_a-z0-9.]*image[_a-z0-9.]*)$/i;
  const TIER_NAMES = { 0: 'Unspecified', 1: 'Pro', 2: 'Ultra', 3: 'Free', 4: 'Unsubscribed (credits left)', 5: 'Zero', 6: 'Exempt', 7: 'Gemnova', 8: 'Ultra 1.5' };

  const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
  const uniq = (arr) => Array.from(new Set(arr));
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function epochMs(n) {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    if (n > 1e9 && n < 4e9) return n * 1000;
    if (n > 1e12 && n < 4e12) return n;
    if (n > 1e15 && n < 4e15) return n / 1e3;
    if (n > 1e18 && n < 4e18) return n / 1e6;
    return null;
  }
  function tsPairMs(v) {
    if (!Array.isArray(v) || v.length < 1 || v.length > 2) return null;
    if (typeof v[0] !== 'number') return null;
    const base = epochMs(v[0]);
    if (base == null) return null;
    if (v.length === 2) {
      if (typeof v[1] !== 'number' || v[1] < 0 || v[1] >= 1e9) return null;
      return base + Math.floor(v[1] / 1e6);
    }
    return base;
  }
  function isoMs(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  function guessCreatedMs(node) {
    const strong = [], weak = [];
    const walk = (n, depth) => {
      if (depth > 12) return;
      if (Array.isArray(n)) {
        const p = tsPairMs(n);
        if (p != null && p >= FLOW_LAUNCH_MS) { strong.push(p); return; }
        for (const c of n) walk(c, depth + 1);
      } else if (typeof n === 'string') {
        const t = isoMs(n);
        if (t != null && t >= FLOW_LAUNCH_MS) strong.push(t);
      } else if (typeof n === 'number') {
        const t = epochMs(n);
        if (t != null && t >= FLOW_LAUNCH_MS) weak.push(t);
      }
    };
    walk(node, 0);
    const pool = strong.length ? strong : weak;
    return pool.length ? Math.min(...pool) : null;
  }

  function scanJsonEnd(s, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  }
  function parseBatchResponse(text) {
    let body = String(text || '');
    if (body.startsWith(")]}'")) {
      const nl = body.indexOf('\n');
      body = nl === -1 ? '' : body.slice(nl + 1);
    }
    const frames = [];
    let i = 0;
    while (i < body.length) {
      const start = body.indexOf('[', i);
      if (start === -1) break;
      const end = scanJsonEnd(body, start);
      if (end === -1) break;
      let chunk;
      try { chunk = JSON.parse(body.slice(start, end)); } catch (e) { i = start + 1; continue; }
      i = end;
      if (!Array.isArray(chunk)) continue;
      for (const entry of chunk) {
        if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
        const rpcid = entry[1];
        if (typeof entry[2] === 'string' && entry[2].length) {
          let payload;
          try { payload = JSON.parse(entry[2]); } catch (e) { payload = entry[2]; }
          frames.push({ rpcid, payload, error: null });
        } else {
          frames.push({ rpcid, payload: null, error: entry[5] != null ? entry[5] : (entry[3] != null ? entry[3] : 'unknown error') });
        }
      }
    }
    return frames;
  }

  function collectUrls(node, out, depth) {
    out = out || []; depth = depth || 0;
    if (depth > 14) return out;
    if (typeof node === 'string') {
      if (node.startsWith('https://') || node.startsWith('http://')) out.push(node);
    } else if (Array.isArray(node)) {
      for (const c of node) collectUrls(c, out, depth + 1);
    }
    return out;
  }
  function collectStrings(node, out, depth) {
    out = out || []; depth = depth || 0;
    if (depth > 14) return out;
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) for (const c of node) collectStrings(c, out, depth + 1);
    return out;
  }
  function splitUrls(urls) {
    const content = [], poster = [], other = [];
    for (const u of urls) {
      if (u.includes(CONTENT_HOST + '/')) content.push(u);
      else if (u.includes(POSTER_HOST + '/')) poster.push(u);
      else other.push(u);
    }
    return { content: uniq(content), poster: uniq(poster), other: uniq(other) };
  }
  function kindFromUrls(urls) {
    if (urls.some((u) => u.includes(CONTENT_HOST + '/video/'))) return 'video';
    if (urls.some((u) => u.includes(CONTENT_HOST + '/image/'))) return 'image';
    return null;
  }
  /** First string in a record that looks like a Flow model key. */
  function detectModel(node) {
    for (const s of collectStrings(node)) if (s.length < 60 && MODEL_RE.test(s)) return s;
    return null;
  }

  /** Shape A ("asset entry"): [assetId, folderId, null, [title, [sec,nanos], isVideo, null, mediaId, operationId, done], projectId] */
  function readAssetEntry(n) {
    if (!Array.isArray(n) || n.length < 4 || !isUuid(n[0])) return null;
    const d = n[3];
    if (!Array.isArray(d) || d.length < 5 || !isUuid(d[4])) return null;
    const created = tsPairMs(d[1]);
    const titleOk = d[0] == null || typeof d[0] === 'string';
    if (created == null && !titleOk) return null;
    return {
      mediaId: d[4],
      assetId: n[0],
      operationId: isUuid(d[5]) ? d[5] : null,
      projectId: isUuid(n[n.length - 1]) ? n[n.length - 1] : null,
      title: typeof d[0] === 'string' ? d[0] : '',
      createdMs: created,
      // Older notes read d[2] as "is video"; live (2026-10) it is true on some plain pictures, so
      // extractItems() lets the generation record's kind win and keeps this only as a fallback.
      kind: d[2] === true ? 'video' : (d[2] === false ? 'image' : null),
      done: d[6],
      gridMs: tsPairMs(d[6]), // the project grid is sorted newest first by this
      urls: splitUrls(collectUrls(n)),
    };
  }
  /** Shape B ("generation record"): [id0, projectId, id2, ?, ?, details[], ?, (videoArm)].
   *  Live flow.google.com (2026-10) puts the downloadable media id at id0 (it equals the asset
   *  entry's d[4] and is what as29s accepts) and the asset id at id2. Older open-source notes had
   *  them the other way round, so extractItems() decides per listing which one links to entries. */
  function readRecord(n) {
    if (!Array.isArray(n) || n.length < 6 || n.length > 10) return null;
    if (!isUuid(n[0]) || !isUuid(n[1]) || !isUuid(n[2])) return null;
    const details = Array.isArray(n[5]) ? n[5] : null;
    if (!details) return null;
    const urls = splitUrls(collectUrls(n));
    const videoArm = n.length >= 8 && n[7] != null;
    const status = details[8] && Array.isArray(details[8]) ? details[8][0] : null;
    const size = typeof details[13] === 'number' ? details[13] : null;
    return {
      mediaId: n[0],
      altId: n[2],
      projectId: n[1],
      title: '',
      createdMs: guessCreatedMs(details),
      kind: kindFromUrls(urls.content) || (videoArm ? 'video' : (n.length === 7 ? 'image' : null)),
      status,
      sizeBytes: size,
      model: detectModel(n),
      hasRecord: true,
      urls,
    };
  }
  function extractItems(payload) {
    const byId = new Map();
    const stats = { assetEntries: 0, records: 0, arrays: 0 };
    const merge = (it) => {
      const cur = byId.get(it.mediaId) || { mediaId: it.mediaId, urls: { content: [], poster: [], other: [] } };
      for (const k of Object.keys(it)) {
        if (k === 'createdSource') continue;
        if (k === 'urls') {
          cur.urls.content = uniq(cur.urls.content.concat(it.urls.content));
          cur.urls.poster = uniq(cur.urls.poster.concat(it.urls.poster));
          cur.urls.other = uniq(cur.urls.other.concat(it.urls.other));
        } else if (k === 'createdMs') {
          if (it.createdMs == null) continue;
          const incomingStrong = it.createdSource === 'entry';
          const currentStrong = cur.createdSource === 'entry';
          if (cur.createdMs == null || (incomingStrong && !currentStrong) || (incomingStrong === currentStrong && it.createdMs < cur.createdMs)) {
            cur.createdMs = it.createdMs; cur.createdSource = it.createdSource;
          }
        } else if (k === 'kind') {
          if (it.kind && (cur.kind == null || it.hasRecord)) cur.kind = it.kind;
        } else if (it[k] != null && it[k] !== '' && (cur[k] == null || cur[k] === '')) {
          cur[k] = it[k];
        }
      }
      byId.set(it.mediaId, cur);
    };
    const entries = [], records = [];
    const walk = (n, depth) => {
      if (!Array.isArray(n) || depth > 40) return;
      stats.arrays++;
      const a = readAssetEntry(n);
      if (a) { stats.assetEntries++; a.createdSource = a.createdMs != null ? 'entry' : null; a.inGrid = true; entries.push(a); }
      const r = readRecord(n);
      if (r) { stats.records++; r.createdSource = r.createdMs != null ? 'guess' : null; records.push(r); }
      for (const c of n) walk(c, depth + 1);
    };
    walk(payload, 0);
    // Which record id links to the entries' media ids? Use whichever matches more often.
    const entryMedia = new Set(entries.map((e) => e.mediaId));
    let at0 = 0, at2 = 0;
    for (const r of records) { if (entryMedia.has(r.mediaId)) at0++; if (entryMedia.has(r.altId)) at2++; }
    stats.recordIdSlot = at2 > at0 ? 2 : 0;
    for (const r of records) {
      if (stats.recordIdSlot === 2) { const t = r.mediaId; r.mediaId = r.altId; r.altId = t; }
      delete r.altId;
    }
    for (const e of entries) merge(e);
    for (const r of records) merge(r);
    const items = Array.from(byId.values());
    // With no grid entries at all (unknown listing shape), treat every item as visible.
    stats.notInGrid = 0;
    for (const it of items) {
      if (!entries.length) it.inGrid = true;
      else if (!it.inGrid) { it.inGrid = false; stats.notInGrid++; }
    }
    for (const it of items) {
      if (!it.kind) it.kind = kindFromUrls(it.urls.content) || 'unknown';
      if (!it.title) it.title = '';
      if (!it.hasRecord) it.hasRecord = false;
    }
    return { items, stats };
  }

  function pickContentUrl(contentUrls, kind) {
    if (!contentUrls || !contentUrls.length) return null;
    if (kind === 'video') return contentUrls.find((u) => u.includes('/video/')) || null;
    if (kind === 'image') return contentUrls.find((u) => u.includes('/image/')) || null;
    return contentUrls.find((u) => u.includes('/video/')) || contentUrls.find((u) => u.includes('/image/')) || contentUrls[0];
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtStamp(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }
  function fmtMonth(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
  function fmtHuman(ms) {
    if (ms == null) return 'unknown date';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function safeName(s, max) {
    return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 60).trim().replace(/[. ]+$/g, '');
  }
  /** Base filename (no folders). pattern: 'date-title-id' | 'title-date-id' */
  function buildFileName(item, ext, pattern, tag) {
    const stamp = item.createdMs != null ? fmtStamp(item.createdMs) : 'nodate';
    const title = safeName(item.title, 60);
    const id8 = String(item.mediaId).slice(0, 8);
    const parts = pattern === 'title-date-id' ? [title, stamp, id8] : [stamp, title, id8];
    const base = parts.filter(Boolean).join(' - ');
    return `${base}${tag ? ` [${safeName(tag, 30)}]` : ''}.${ext}`;
  }
  /** Relative path under the downloads folder, for Tampermonkey mode. */
  function buildRelPath(item, fileName, opts) {
    const segs = [];
    if (opts.subfolder) segs.push(safeName(opts.subfolder, 80));
    if (opts.folderByProject) segs.push(safeName(opts.projectTitle || (item.projectId ? item.projectId.slice(0, 8) : 'project'), 80) || 'project');
    if (opts.folderByMonth) segs.push(item.createdMs != null ? fmtMonth(item.createdMs) : 'undated');
    segs.push(fileName);
    return segs.filter(Boolean).join('/');
  }

  const EXT_BY_MIME = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  };
  function extFromMime(mime, fallbackKind) {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (EXT_BY_MIME[m]) return EXT_BY_MIME[m];
    if (m.startsWith('image/')) return m.slice(6).replace(/[^a-z0-9]/g, '') || 'img';
    if (m.startsWith('video/')) return m.slice(6).replace(/[^a-z0-9]/g, '') || 'mp4';
    return fallbackKind === 'video' ? 'mp4' : 'jpg';
  }
  function sniffExt(bytes) {
    if (!bytes || bytes.length < 12) return null;
    const b = bytes;
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
    if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'mp4';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
    return null;
  }
  function redact(node) {
    if (typeof node === 'string') {
      if (node.startsWith('http')) return node.split('?')[0].replace(/\/asb\/[^/]+/, '/asb/<token>').replace(/\/(image|video)\/[^/]+/, '/$1/<id>');
      if (node.length > 120) return node.slice(0, 60) + '…(' + node.length + ' chars)';
      return node;
    }
    if (Array.isArray(node)) return node.map(redact);
    return node;
  }

  /** Keyword filter: comma-separated terms OR'd, case-insensitive substring; a term wrapped in /slashes/ is a regex. */
  function compileTerms(text) {
    return String(text || '').split(',').map((s) => s.trim()).filter(Boolean).map((t) => {
      const m = t.match(/^\/(.+)\/([a-z]*)$/i);
      if (m) { try { return new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i'); } catch (e) { /* fall through */ } }
      return new RegExp(escapeRe(t), 'i');
    });
  }
  function matchesKeywords(text, includeTerms, excludeTerms) {
    const t = String(text || '');
    if (includeTerms.length && !includeTerms.some((re) => re.test(t))) return false;
    if (excludeTerms.length && excludeTerms.some((re) => re.test(t))) return false;
    return true;
  }

  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows, columns) {
    const cols = columns || Object.keys(rows[0] || {});
    return [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))).join('\r\n') + '\r\n';
  }
  const countSince = (stamps, sinceMs) => (stamps || []).filter((t) => t >= sinceMs).length;

  /** Learn mode: turn observed traffic + clicks into proposed settings. */
  function inferLearned(net, clicks) {
    const out = {};
    const byRpc = {};
    for (const s of net || []) {
      if (!s.rpcid) continue;
      const b = byRpc[s.rpcid] || (byRpc[s.rpcid] = { items: 0, content: 0, big: 0, numbers: 0, n: 0, maxSize: 0 });
      b.n++; b.items = Math.max(b.items, s.items || 0); if (s.hasContent) b.content++; if (s.hasBig) b.big++; if (s.numbersOnly) b.numbers++; b.maxSize = Math.max(b.maxSize, s.size || 0);
    }
    let listing = null;
    for (const [id, b] of Object.entries(byRpc)) if (b.items >= 3 && (!listing || b.items > byRpc[listing].items)) listing = id;
    if (listing) out.rpcListing = listing;
    let media = null;
    for (const [id, b] of Object.entries(byRpc)) if (id !== listing && b.content > 0 && b.items <= 2 && (!media || b.content > byRpc[media].content)) media = id;
    if (media) out.rpcMedia = media;
    const ups = Object.entries(byRpc).filter(([, b]) => b.big > 0).map(([id]) => id);
    if (ups.length) out.rpcUpscaleIds = ups;
    const credits = Object.entries(byRpc).filter(([, b]) => b.numbers > 0 && b.maxSize < 64).map(([id]) => id);
    if (credits.length === 1) out.rpcCredits = credits[0];
    const resRe = /(\d+)\s*([kK]|p\b)/;
    for (const c of clicks || []) {
      if (c.kind === 'menuitem' && Array.isArray(c.visibleAfter)) {
        const newItems = c.visibleAfter.filter((t) => !c.visibleBefore.includes(t));
        if (newItems.filter((t) => resRe.test(t)).length >= 2) out.downloadLabel = c.text.replace(/[▸▶›»>\s]+$/g, '').trim();
      }
      if (c.kind === 'menuitem' && resRe.test(c.text)) {
        const m = c.text.match(resRe);
        out.imageUpscale = (m[1] + m[2]).replace(/k$/i, 'K').replace(/P$/, 'p');
        const label = c.text.replace(resRe, '').replace(/[()\-–—:]/g, ' ').replace(/\s+/g, ' ').trim();
        if (label) out.upscaleLabel = label;
      }
      if (c.kind === 'button' && c.inTile && c.ariaLabel && Array.isArray(c.visibleAfter) && c.visibleAfter.length > c.visibleBefore.length) out.optionsLabel = c.ariaLabel;
    }
    return out;
  }

  /** Flow's project grid shows tiles newest first by the entry's second timestamp (gridMs;
   *  verified on a 5,500-tile project, 2026-10). Returns mediaId -> position in that order. */
  function gridRanks(items, projectId) {
    const pid = projectId ? projectId.toLowerCase() : null;
    const list = items.filter((i) => i.inGrid !== false && (!pid || !i.projectId || i.projectId.toLowerCase() === pid));
    const key = (i) => (i.gridMs != null ? i.gridMs : (i.createdMs || 0));
    list.sort((a, b) => key(b) - key(a));
    return new Map(list.map((i, n) => [i.mediaId, n]));
  }
  /** Whether an item of this kind is to be upscaled: pictures and videos each have their own quality. */
  function wantsUpscale(kind, settings) {
    return kind === 'video' ? settings.videoQuality === 'upscaled' : kind === 'image' && settings.quality === 'upscaled';
  }
  /** Whether this item gets upscaled. Flow's upscale sizes live in the tile menu, so an item Flow
   *  doesn't show in the project grid (a reference image used in a prompt) is saved at original quality. */
  function upscalable(it, settings) { return wantsUpscale(it.kind, settings) && it.inGrid !== false; }
  /** An uploaded picture: its title is the file name it was uploaded with (e.g. "<hash>.jpg"), where a
   *  generated one's is the prompt. Flow's menu offers no upscaled sizes for these, so a saved original counts. */
  function isUploadedFile(it) { return /^[^\n/\\]{1,120}\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i.test(it.title || ''); }
  function anyUpscale(settings) { return settings.quality === 'upscaled' || settings.videoQuality === 'upscaled'; }
  /** Rough duration of a run over these items with the current pacing, in ms. */
  function estimateRunMs(items, settings, avgUpscaleMs, avgVideoUpscaleMs) {
    const delay = Math.max(0, settings.delayMs || 0);
    const extra = 3000 + Math.max(0, settings.upscalePauseSec || 0) * 1000 + delay;
    const perUp = (avgUpscaleMs || 12000) + extra, perVideoUp = (avgVideoUpscaleMs || 45000) + extra;
    const perOrig = 1500 + delay;
    let ms = 0;
    for (const it of items) ms += !upscalable(it, settings) ? perOrig : it.kind === 'video' ? perVideoUp : perUp;
    return ms;
  }
  function fmtDuration(ms) {
    const min = Math.round(Math.max(0, ms) / 60000);
    if (min < 1) return 'under a minute';
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${min % 60} min`;
  }
  function describeMatches(items, settings) {
    if (!items.length) return 'Nothing matches';
    const vids = items.filter((i) => i.kind === 'video').length, pics = items.length - vids;
    const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    if (anyUpscale(settings)) {
      const how = (kind, size) => (wantsUpscale(kind, settings) ? `would be upscaled to ${size}` : 'saved at original quality');
      // items Flow's grid doesn't show can't be upscaled (see upscalable)
      const hidden = items.filter((i) => i.inGrid === false && wantsUpscale(i.kind, settings)).length;
      const hp = items.filter((i) => i.inGrid === false && i.kind === 'image' && wantsUpscale(i.kind, settings)).length, hv = hidden - hp;
      return [pics - hp ? `${n(pics - hp, 'picture')} ${how('image', settings.imageUpscale)}` : '', vids - hv ? `${n(vids - hv, 'video')} ${how('video', settings.videoUpscale)}` : '',
        hidden ? `${n(hidden, hv ? 'item' : 'picture')} not in the grid saved at original quality` : ''].filter(Boolean).join(', ');
    }
    return `${[pics ? n(pics, 'picture') : '', vids ? n(vids, 'video') : ''].filter(Boolean).join(' and ')} would be downloaded`;
  }

  /** A small thumbnail for the picker: Flow's poster URLs take a size after "=" (=s0 is full size). */
  function thumbUrl(item) {
    const u = ((item.urls && item.urls.poster) || []).find((x) => /googleusercontent\.com\/asb\//.test(x));
    return u ? u.split('=')[0] + '=s96' : '';
  }

  const helpers = {
    isUuid, epochMs, tsPairMs, guessCreatedMs, parseBatchResponse, extractItems, readAssetEntry, readRecord,
    pickContentUrl, buildFileName, buildRelPath, safeName, extFromMime, sniffExt, collectUrls, splitUrls, redact, scanJsonEnd,
    detectModel, compileTerms, matchesKeywords, csvEscape, toCsv, countSince, inferLearned, fmtMonth,
    gridRanks, estimateRunMs, fmtDuration, describeMatches, wantsUpscale, upscalable, isUploadedFile, anyUpscale, pickUpscaleSize, doneKey, thumbUrl,
  };
  if (IS_NODE) { module.exports = helpers; return; }

  // ---------------------------------------------------------------------------
  // Browser side: storage, transport, Flow operations
  // ---------------------------------------------------------------------------

  const store = {
    get(k, d) { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch (e) { return d; } },
    set(k, v) { try { GM_setValue(k, v); } catch (e) { /* ignore */ } },
  };

  const DEFAULT_SETTINGS = {
    // what
    sinceLocal: '', untilLocal: '', images: true, videos: false, includeUndated: false, skipDone: true,
    keywordInclude: '', keywordExclude: '', modelFilter: '', excludeUploads: false, includeNotInGrid: false,
    // quality
    quality: 'original', imageUpscale: '2K', videoQuality: 'original', videoUpscale: '1080p', upscaleLabel: 'Upscal', fallbackOriginal: false, upscaleTimeoutSec: 120,
    upscalePauseSec: 8, maxUpscalesPerRun: 0, dailyUpscaleCap: 0, onLimit: 'stop', limitPauseHours: 24,
    // projects
    scope: 'current', selectedProjects: [], extraProjects: '',
    // saving
    downloadMode: 'browser', subfolder: 'Flow Export', folderByProject: true, folderByMonth: false, namePattern: 'date-title-id',
    sidecar: 'none', manifestPerRun: true, allowPosterFallback: false, delayMs: 400,
    // automation
    autoMinutes: 0, runOnLoadHours: 0, autoProjectId: '', notify: true, showFab: true,
    // learn / advanced
    learnMode: false, rpcListing: 'Zzl0ze', rpcListingAlt: 'ngNC2', rpcMedia: 'as29s', rpcCredits: 'nzlxg',
    rpcUpscaleIds: 'SPrCad,p0UkFb', downloadLabel: 'Download', optionsLabel: 'option|more|menu|opcion|más|mehr|plus|autres|altro|mais',
  };

  /** History key: the original, the standard upscale (2K / 1080p, key "|up" as before 0.3.10) and
   *  any other size such as 4K ("|up:4k") are each tracked on their own. */
  function doneKey(mediaId, upscaled, size) {
    if (!upscaled) return mediaId;
    const s = String(size || '').replace(/\s+/g, '').toLowerCase();
    return !s || s === '2k' || s === '1080p' ? `${mediaId}|up` : `${mediaId}|up:${s}`;
  }
  function loadSettings() { return Object.assign({}, DEFAULT_SETTINGS, store.get('fbd.settings', {})); }
  function saveSettings(s) { store.set('fbd.settings', s); }
  function loadDone() { return store.get('fbd.done', {}); }
  function saveDone(d) { store.set('fbd.done', d); }
  function loadProjects() { return store.get('fbd.projects', {}); }
  function saveProjects(p) { store.set('fbd.projects', p); }
  function loadManifest() { return store.get('fbd.manifest', []); }
  function saveManifest(m) { if (m.length > 20000) m.splice(0, m.length - 20000); store.set('fbd.manifest', m); }
  function loadUpscaleLog() { return store.get('fbd.upscaleLog', []); }
  function saveUpscaleLog(l) { store.set('fbd.upscaleLog', l.filter((t) => Date.now() - t < 8 * 86400000)); }
  function loadLearned() { return store.get('fbd.learned', {}); }
  function saveLearned(l) { store.set('fbd.learned', l); }

  function currentProjectId() {
    const m = location.pathname.match(/\/project\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  }
  function projectTitleFor(pid) {
    const p = loadProjects()[String(pid || '').toLowerCase()];
    if (p && p.title) return p.title;
    if (pid && currentProjectId() === pid.toLowerCase()) {
      const t = safeName((document.title || '').replace(/^\s*Google Flow\s*[-–—|:]?\s*/i, '').replace(/\s*[-–—|:]?\s*Google Flow\s*$/i, ''), 80);
      if (t) return t;
    }
    return pid ? pid.slice(0, 8) : '';
  }

  function getWiz() {
    const wiz = PAGE.WIZ_global_data || {};
    let at = wiz.SNlM0e, sid = wiz.FdrFJe, bl = wiz.cfb2h;
    if (!at) {
      const html = document.documentElement.innerHTML;
      const g = (re) => { const m = html.match(re); return m ? m[1] : undefined; };
      at = g(/"SNlM0e":"([^"]+)"/); sid = sid || g(/"FdrFJe":"([^"]+)"/); bl = bl || g(/"cfb2h":"([^"]+)"/);
    }
    return { at, sid: sid != null ? String(sid) : '', bl: bl || '' };
  }
  function observedBatchUrls() {
    try { return performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/data/batchexecute')); } catch (e) { return []; }
  }
  function candidateBatchPaths() {
    const m = location.pathname.match(/^\/u\/\d+/);
    const prefix = m ? m[0] : '';
    const paths = [];
    const seen = observedBatchUrls();
    if (seen.length) { try { paths.push(new URL(seen[seen.length - 1]).pathname); } catch (e) { /* ignore */ } }
    paths.push(prefix + '/_/AiSandboxAngularFrontend/data/batchexecute');
    paths.push(prefix + '/_/FlowUi/data/batchexecute');
    if (prefix) paths.push('/_/AiSandboxAngularFrontend/data/batchexecute');
    return uniq(paths);
  }
  function observedHl() {
    const seen = observedBatchUrls();
    for (let i = seen.length - 1; i >= 0; i--) {
      try { const hl = new URL(seen[i]).searchParams.get('hl'); if (hl) return hl; } catch (e) { /* ignore */ }
    }
    return (document.documentElement.lang || navigator.language || 'en').split('-')[0];
  }

  let workingBatchPath = null;
  const pageFetch = (u, o) => (typeof PAGE.fetch === 'function' ? PAGE.fetch.call(PAGE, u, o) : fetch(u, o));

  async function rpc(rpcid, inner) {
    const { at, sid, bl } = getWiz();
    if (!at) throw new Error('No session token on this page (not signed in, or page still loading). Reload the Flow tab and try again.');
    const paths = workingBatchPath ? [workingBatchPath].concat(candidateBatchPaths().filter((p) => p !== workingBatchPath)) : candidateBatchPaths();
    const hl = observedHl();
    const freq = JSON.stringify([[[rpcid, JSON.stringify(inner), null, 'generic']]]);
    let lastErr = null;
    for (const path of paths) {
      const reqid = Math.floor(Math.random() * 900000) + 100000;
      const url = `${path}?rpcids=${encodeURIComponent(rpcid)}&source-path=${encodeURIComponent(location.pathname || '/')}` +
        `&bl=${encodeURIComponent(bl)}&f.sid=${encodeURIComponent(sid)}&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`;
      let resp, text;
      try {
        resp = await pageFetch(url, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
          body: new URLSearchParams({ 'f.req': freq, at }).toString(),
        });
        text = await resp.text();
      } catch (e) { lastErr = e; continue; }
      if (resp.status === 404) { lastErr = new Error(`404 at ${path}`); continue; }
      if (text.trimStart().startsWith('<')) throw new Error(`Flow answered with an HTML page (HTTP ${resp.status}). You are probably signed out — reload the tab.`);
      const frames = parseBatchResponse(text);
      const mine = frames.filter((f) => f.rpcid === rpcid);
      if (!mine.length) { lastErr = new Error(`No ${rpcid} frame in response (HTTP ${resp.status}, ${text.length} bytes)`); continue; }
      workingBatchPath = path;
      const ok = mine.find((f) => f.payload != null);
      if (ok) return ok.payload;
      const err = mine.find((f) => f.error);
      throw new Error(`${rpcid} returned an error: ${JSON.stringify(err && err.error).slice(0, 400)}`);
    }
    throw lastErr || new Error('batchexecute call failed');
  }

  async function listProjectMedia(projectId, settings, log) {
    let items = [], stats = null, raw = null, source = null;
    try {
      raw = await rpc(settings.rpcListing, [`projects/${projectId}`, null, null, null, [1]]);
      const r = extractItems(raw); items = r.items; stats = r.stats; source = settings.rpcListing;
    } catch (e) { log(`  ${settings.rpcListing} failed: ${e.message}`); }
    if (!items.length && settings.rpcListingAlt) {
      try {
        const raw2 = await rpc(settings.rpcListingAlt, [`tools/PINHOLE/projects/${projectId}`]);
        const r = extractItems(raw2); if (r.items.length) { items = r.items; stats = r.stats; raw = raw2; source = settings.rpcListingAlt; }
      } catch (e) { log(`  ${settings.rpcListingAlt} failed: ${e.message}`); }
    }
    for (const it of items) if (!it.projectId) it.projectId = projectId;
    return { items, stats, raw, source };
  }
  async function resolveUrls(mediaId, settings) {
    const payload = await rpc(settings.rpcMedia, [mediaId]);
    return splitUrls(collectUrls(payload));
  }
  async function fetchCredits(settings) {
    const payload = await rpc(settings.rpcCredits, []);
    const credits = Array.isArray(payload) && typeof payload[0] === 'number' ? payload[0] : null;
    const tierCode = Array.isArray(payload) && typeof payload[1] === 'number' ? payload[1] : null;
    return { credits, tier: tierCode != null ? (TIER_NAMES[tierCode] || `tier ${tierCode}`) : null, raw: redact(payload) };
  }

  function discoverProjectsFromDom() {
    const found = loadProjects();
    const now = Date.now();
    for (const a of Array.from(document.querySelectorAll('a[href*="/project/"]'))) {
      const m = (a.getAttribute('href') || '').match(/\/project\/([0-9a-f-]{36})/i);
      if (!m) continue;
      const id = m[1].toLowerCase();
      const text = safeName(a.textContent, 80);
      const prev = found[id] || {};
      found[id] = { id, title: text && !/^https?:/.test(text) ? text : (prev.title || ''), lastSeen: now };
    }
    const cur = currentProjectId();
    if (cur) {
      const t = safeName((document.title || '').replace(/^\s*Google Flow\s*[-–—|:]?\s*/i, '').replace(/\s*[-–—|:]?\s*Google Flow\s*$/i, ''), 80);
      const prev = found[cur] || {};
      found[cur] = { id: cur, title: t || prev.title || '', lastSeen: now };
    }
    saveProjects(found);
    return found;
  }
  function parseExtraProjects(text) {
    const ids = [];
    for (const m of String(text || '').matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) ids.push(m[0].toLowerCase());
    return uniq(ids);
  }

  // ---------------------------------------------------------------------------
  // Saving files
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let stopFlag = false;
  // Live "what is it doing now" line under the panel buttons; mountUI() replaces this no-op.
  // opts.untilMs shows a countdown instead of the time spent so far.
  let activity = () => {};
  const AVG_UP_KEY = 'fbd.avgUpscaleMs';
  const AVG_UP_VIDEO_KEY = 'fbd.avgVideoUpscaleMs';
  async function pacedSleep(ms) { const end = Date.now() + ms; while (Date.now() < end && !stopFlag) await sleep(Math.min(250, end - Date.now())); }

  // Flow only draws its grid while the tab is visible and Chrome throttles hidden tabs, so an
  // upscaled run waits for the tab to come back instead of deferring every picture.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hiddenAt = Date.now(); });
  const tabHidden = () => document.visibilityState === 'hidden';
  async function waitForVisibleTab(log) {
    if (!tabHidden() || stopFlag) return;
    log('⏸ Paused: the Flow tab is hidden. Switch back to it and the run carries on.');
    activity('⏸ Paused: the Flow tab is hidden. Switch back to it to continue.');
    const t0 = Date.now();
    await new Promise((res) => {
      const check = () => {
        if (tabHidden() && !stopFlag) return;
        document.removeEventListener('visibilitychange', check); clearInterval(iv); res();
      };
      const iv = setInterval(check, 1000);
      document.addEventListener('visibilitychange', check);
    });
    if (stopFlag) return;
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`▶ Resumed (paused ${secs < 120 ? secs + ' s' : Math.round(secs / 60) + ' min'}).`);
    await sleep(1500); // let Flow redraw the grid
  }

  function gmFetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: 600000,
        headers: { 'Referer': location.origin + '/' },
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) resolve({ blob: r.response, headers: r.responseHeaders || '', finalUrl: r.finalUrl });
          else reject(new Error(`HTTP ${r.status}`));
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }
  function saveViaAnchor(blob, name) {
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 120000);
  }
  /** Save a blob. `relPath` may contain folders; they are used only in Tampermonkey mode. Returns {how, path}. */
  async function saveBlob(blob, relPath, settings) {
    const baseName = relPath.split('/').pop();
    if (settings.downloadMode === 'tampermonkey' && typeof GM_download === 'function') {
      const objUrl = URL.createObjectURL(blob);
      try {
        await new Promise((resolve, reject) => {
          GM_download({
            url: objUrl, name: relPath, saveAs: false,
            onload: resolve,
            onerror: (e) => reject(new Error('GM_download: ' + (e && (e.error + (e.details ? ' ' + JSON.stringify(e.details) : '')) || 'failed'))),
            ontimeout: () => reject(new Error('GM_download timeout')),
          });
        });
        return { how: 'tampermonkey', path: relPath };
      } catch (e) {
        saveViaAnchor(blob, baseName);
        await pacedSleep(Math.min(10000, 600 + blob.size / 3e6 * 1000));
        return { how: 'browser (fallback: ' + e.message + ')', path: baseName };
      } finally {
        setTimeout(() => URL.revokeObjectURL(objUrl), 120000);
      }
    }
    saveViaAnchor(blob, baseName);
    await pacedSleep(Math.min(10000, 600 + blob.size / 3e6 * 1000)); // no completion callback for plain downloads
    return { how: 'browser', path: baseName };
  }
  async function saveText(text, relPath, settings, mime) {
    return saveBlob(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }), relPath, settings);
  }

  function pathOptsFor(item, settings) {
    return { subfolder: settings.subfolder, folderByProject: settings.folderByProject, folderByMonth: settings.folderByMonth, projectTitle: projectTitleFor(item.projectId) };
  }
  function sidecarText(item, result, settings) {
    const lines = [
      `Prompt / title: ${item.title || ''}`,
      `Created: ${item.createdMs != null ? new Date(item.createdMs).toISOString() : 'unknown'}`,
      `Project: ${projectTitleFor(item.projectId)} (${item.projectId || ''})`,
      `Media id: ${item.mediaId}`,
      `Kind: ${item.kind}`,
      `Model: ${item.model || ''}`,
      `Quality: ${result.qualityLabel}`,
      `File: ${result.path || result.name}`,
      `Saved: ${new Date().toISOString()}`,
      `Source: Google Flow, exported by Flow Bulk Downloader ${VERSION}`,
    ];
    return lines.join('\r\n') + '\r\n';
  }
  function sidecarJson(item, result) {
    const copy = Object.assign({}, item);
    delete copy.urls; delete copy.raw;
    return JSON.stringify({ item: copy, projectTitle: projectTitleFor(item.projectId), quality: result.qualityLabel, file: result.path || result.name, savedAt: new Date().toISOString(), exporter: `Flow Bulk Downloader ${VERSION}` }, null, 2);
  }
  async function writeSidecar(item, result, settings) {
    if (!settings.sidecar || settings.sidecar === 'none' || result.flowNamed) return;
    const base = (result.path || result.name).replace(/\.[a-z0-9]+$/i, '');
    if (settings.sidecar === 'json') await saveText(sidecarJson(item, result), base + '.json', settings, 'application/json');
    else await saveText(sidecarText(item, result, settings), base + '.txt', settings);
  }

  async function downloadItem(item, settings, log) {
    let urls = item.urls;
    try {
      const fresh = await resolveUrls(item.mediaId, settings);
      urls = { content: uniq(fresh.content.concat(item.urls.content)), poster: uniq(fresh.poster.concat(item.urls.poster)), other: uniq(fresh.other.concat(item.urls.other)) };
      if (!item.kind || item.kind === 'unknown') item.kind = kindFromUrls(fresh.content) || item.kind;
    } catch (e) {
      log(`  ${settings.rpcMedia} failed for ${item.mediaId.slice(0, 8)}: ${e.message} (trying URLs from the listing)`);
    }
    let url = pickContentUrl(urls.content, item.kind);
    let viaPoster = false;
    if (!url && settings.allowPosterFallback && urls.poster.length) { url = urls.poster[0].split('=')[0] + '=s0'; viaPoster = true; }
    if (!url) throw new Error('no download URL available (enable "preview-quality fallback" to save a thumbnail-based copy)');
    const { blob, headers } = await gmFetchBlob(url);
    const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(headers || '');
    const mime = (ctMatch && ctMatch[1]) || blob.type || '';
    if (/text\/html/i.test(mime)) throw new Error('got an HTML page instead of media (signed URL rejected — are you signed in?)');
    let ext = extFromMime(mime, item.kind);
    try { ext = sniffExt(new Uint8Array(await blob.slice(0, 16).arrayBuffer())) || ext; } catch (e) { /* ignore */ }
    const name = buildFileName(item, ext, settings.namePattern, viaPoster ? 'preview' : '');
    const rel = buildRelPath(item, name, pathOptsFor(item, settings));
    const saved = await saveBlob(blob, rel, settings);
    return { name, path: saved.path, bytes: blob.size, how: saved.how, viaPoster, upscaled: false, qualityLabel: viaPoster ? 'preview' : 'original' };
  }

  // ---------------------------------------------------------------------------
  // Upscaled quality: drive Flow's own Download menu for a tile
  // ---------------------------------------------------------------------------

  const batchObserved = [];
  (function startNetObserver() {
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.name && e.name.includes('/data/batchexecute')) batchObserved.push({ t: Date.now(), url: e.name, bytes: e.transferSize || e.encodedBodySize || 0 });
        if (batchObserved.length > 3000) batchObserved.splice(0, batchObserved.length - 1500);
      });
      po.observe({ type: 'resource', buffered: true });
    } catch (e) { /* ignore */ }
  })();
  function upscaleRpcRe(settings) {
    const ids = String(settings.rpcUpscaleIds || '').split(',').map((s) => s.trim()).filter(Boolean).map(escapeRe);
    return ids.length ? new RegExp('rpcids=(' + ids.join('|') + ')') : /rpcids=(SPrCad|p0UkFb)/;
  }
  function upscaleCallsSince(t0, settings) { const re = upscaleRpcRe(settings); return batchObserved.filter((b) => b.t >= t0 && (re.test(b.url) || b.bytes > 300000)); }

  const toastLog = [];
  const TOAST_SEL = '[role="alert"],[role="status"],[aria-live],mat-snack-bar-container,.mat-mdc-snack-bar-container,[class*="snack"],[class*="toast"],[class*="notification"],[class*="banner"]';
  const LIMIT_RE = /(daily|per day|today|24\s*-?\s*hours?).{0,60}(limit|quota|maximum|max\b|allowance)|(limit|quota|maximum|max\b|allowance).{0,60}(daily|per day|today|24\s*-?\s*hours?)|reached (your|the) .{0,40}limit|no (more )?upscales? (left|remaining)|out of upscales|upscale (limit|quota)|too many (upscale|request|download)|rate.?limit|try again (tomorrow|later)|downloads? (are )?(temporarily )?(paused|throttled)/i;
  const FAIL_RE = /upscal\w*.{0,40}(fail|error|unable|couldn|can.t|wrong|not available)|(fail|error|unable|couldn|can.t|wrong).{0,40}upscal|download (has )?(failed|error)|something went wrong|could not (download|export|save)/i;
  (function startToastObserver() {
    try {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (!n || n.nodeType !== 1) continue;
            const txt = (n.textContent || '').replace(/\s+/g, ' ').trim();
            if (!txt || txt.length > 400) continue;
            let roleish = false;
            try { roleish = n.matches(TOAST_SEL) || !!n.querySelector(TOAST_SEL); } catch (e) { /* ignore */ }
            if (roleish || ((FAIL_RE.test(txt) || LIMIT_RE.test(txt)) && txt.length < 220)) toastLog.push({ t: Date.now(), text: txt });
          }
        }
        if (toastLog.length > 300) toastLog.splice(0, 150);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  })();
  function toastsSince(t0) { return toastLog.filter((x) => x.t >= t0); }
  class UpscaleLimitError extends Error { constructor(toast, msg) { super(msg || `Flow reports the upscale limit: "${toast}"`); this.limit = true; this.toast = toast; } }
  class UpscaleDeferError extends Error { constructor(msg, noGrid) { super(msg); this.defer = true; this.noGrid = !!noGrid; } }

  function fireMouse(el, type, init) {
    const Ctor = (type.startsWith('pointer') && typeof PAGE.PointerEvent === 'function') ? PAGE.PointerEvent : PAGE.MouseEvent;
    el.dispatchEvent(new Ctor(type, Object.assign({ bubbles: !/enter|leave/.test(type), cancelable: true, composed: true, view: PAGE }, init || {})));
  }
  function pointInit(el, extra) {
    const r = el.getBoundingClientRect();
    return Object.assign({ clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), pointerType: 'mouse', pointerId: 1, isPrimary: true }, extra || {});
  }
  function hoverEl(el) { const init = pointInit(el); for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) fireMouse(el, t, init); }
  function clickEl(el) {
    const init = pointInit(el, { button: 0 });
    for (const t of ['pointerdown', 'mousedown']) fireMouse(el, t, Object.assign({}, init, { buttons: 1 }));
    try { if (el.focus) el.focus(); } catch (e) { /* ignore */ }
    for (const t of ['pointerup', 'mouseup', 'click']) fireMouse(el, t, Object.assign({}, init, { buttons: 0 }));
  }
  function pressEscape() {
    for (const target of [document.activeElement, document.body]) {
      if (!target) continue;
      for (const t of ['keydown', 'keyup']) target.dispatchEvent(new PAGE.KeyboardEvent(t, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true }));
    }
  }
  const isVisible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  function visibleMenuItems() { return Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')).filter(isVisible); }
  const textOf = (el) => ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
  async function waitUntil(fn, ms, step) {
    const t0 = Date.now();
    for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step || 120); }
  }

  const TILE_SELECTOR = 'flow-tile-container, flow-image-tile, flow-video-tile, [class*="tile-container"], [class*="Tile"], [class*="tile"]';
  function posterTokens(item) {
    const out = [];
    for (const u of (item.urls && item.urls.poster) || []) { const m = u.match(/\/asb\/([^=?&/]+)/); if (m) out.push(m[1]); }
    return uniq(out);
  }
  const cssQuote = (s) => '"' + String(s).replace(/["\\]/g, '\\$&') + '"';
  function findTileNow(item) {
    const tokens = posterTokens(item);
    let el = null;
    if (tokens.length) el = document.querySelector(tokens.map((t) => `img[src*=${cssQuote(t)}]`).join(','));
    if (!el) el = document.querySelector(`[data-media-id=${cssQuote(item.mediaId)}], a[href*=${cssQuote(item.mediaId)}], img[src*=${cssQuote(item.mediaId)}]`);
    if (!el) return null;
    return el.closest(TILE_SELECTOR) || el.parentElement;
  }
  function scrollContainerOf(el) {
    let n = el;
    while (n && n !== document.body && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 10) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  const nudgeScroll = (sc) => { try { sc.dispatchEvent(new PAGE.Event('scroll', { bubbles: false })); } catch (e) { /* ignore */ } };
  const asbToken = (src) => { const m = String(src || '').match(/\/asb\/([^=?&/]+)/); return m ? m[1] : null; };
  let gridCache = null;
  function gridIndexFor(projectId) {
    if (!lastScan) return null;
    if (gridCache && gridCache.at === lastScan.at && gridCache.pid === projectId) return gridCache;
    const ranks = gridRanks(lastScan.items, projectId);
    const byToken = new Map();
    for (const it of lastScan.items) {
      const r = ranks.get(it.mediaId);
      if (r != null) for (const t of posterTokens(it)) byToken.set(t, r);
    }
    gridCache = { at: lastScan.at, pid: projectId, ranks, byToken };
    return gridCache;
  }
  /** Grid positions of the tiles currently drawn inside the scroller's viewport. */
  function renderedRanks(sc, byToken) {
    const isPage = sc === document.scrollingElement || sc === document.documentElement;
    const top = isPage ? 0 : sc.getBoundingClientRect().top;
    const out = [];
    for (const img of document.querySelectorAll('img[src*="/asb/"]')) {
      const r = byToken.get(asbToken(img.src));
      if (r == null) continue;
      const y = img.getBoundingClientRect().top - top + sc.scrollTop;
      if (y > sc.scrollTop - 50 && y < sc.scrollTop + sc.clientHeight + 50) out.push({ r, y });
    }
    return out;
  }
  async function settleGrid(sc, byToken) {
    let last = '', same = 0;
    for (let k = 0; k < 20; k++) {
      await sleep(150);
      const sig = renderedRanks(sc, byToken).map((x) => x.r).join(',');
      if (sig && sig === last) { if (++same >= 2) return; } else same = 0;
      last = sig;
    }
  }
  // Flow's grid is virtual (only ~100 tiles exist at a time), so jump to where the picture should
  // be from its grid position, then correct using the positions of the tiles that got drawn.
  async function jumpToTile(item, sc) {
    const g = gridIndexFor(currentProjectId());
    const target = g && g.ranks.get(item.mediaId);
    if (target == null) return { tile: null, absent: !!(g && g.ranks.size && item.inGrid === false) };
    let bracketed = 0;
    for (let step = 0; step < 12 && !stopFlag; step++) {
      const tile = findTileNow(item);
      if (tile) return { tile };
      const R = renderedRanks(sc, g.byToken);
      let y;
      if (!R.length) y = sc.scrollTop + sc.clientHeight * 0.5;
      else {
        // Tiles on both sides of it are drawn but it is not: Flow does not show it in the grid.
        if (R.some((x) => x.r < target) && R.some((x) => x.r > target) && ++bracketed >= 2) return { tile: null, absent: true };
        const rows = uniq(R.map((x) => Math.round(x.y))).sort((a, b) => a - b);
        const pitch = rows.length > 1 ? (rows[rows.length - 1] - rows[0]) / (rows.length - 1) : sc.clientHeight / 3;
        const cols = Math.max(...rows.map((t) => R.filter((x) => Math.round(x.y) === t).length));
        let a = R[0];
        for (const x of R) if (Math.abs(x.r - target) < Math.abs(a.r - target)) a = x;
        const dRows = (target - a.r) / cols;
        y = Math.abs(dRows) < 1.5 ? sc.scrollTop + Math.sign(dRows || 1) * sc.clientHeight * 0.4 : a.y + dRows * pitch - sc.clientHeight / 2;
      }
      sc.scrollTop = Math.max(0, y); nudgeScroll(sc);
      await settleGrid(sc, g.byToken);
    }
    return { tile: findTileNow(item) };
  }
  async function findTile(item) {
    let tile = findTileNow(item);
    if (tile) return tile;
    const anyTile = document.querySelector('img[src*="/asb/"]') || document.querySelector(TILE_SELECTOR);
    if (!anyTile) throw new UpscaleDeferError('no project grid is visible in this tab (open the project and keep the tab in the foreground)', true);
    const sc = scrollContainerOf(anyTile);
    activity('Scrolling the grid to it…');
    const j = await jumpToTile(item, sc);
    if (j.tile) return j.tile;
    if (j.absent) return null;
    // Fallback when the grid order is unknown: sweep the whole grid from the top.
    activity('Searching the whole grid for it…');
    const startTop = sc.scrollTop;
    sc.scrollTop = 0; nudgeScroll(sc); await sleep(350);
    let lastTop = -1, stalls = 0;
    for (let i = 0; i < 400 && !stopFlag; i++) {
      tile = findTileNow(item);
      if (tile) return tile;
      sc.scrollTop += Math.max(200, sc.clientHeight * 0.7);
      nudgeScroll(sc);
      await sleep(300);
      if (Math.abs(sc.scrollTop - lastTop) < 2) { if (++stalls >= 3) break; } else stalls = 0;
      lastTop = sc.scrollTop;
    }
    sc.scrollTop = startTop; nudgeScroll(sc);
    return null;
  }
  function optionsRe(settings) { try { return new RegExp(settings.optionsLabel || DEFAULT_SETTINGS.optionsLabel, 'i'); } catch (e) { return new RegExp(DEFAULT_SETTINGS.optionsLabel, 'i'); } }
  // Flow (2026-10) hides each tile's hotbar with CSS :hover, which synthetic mouse events cannot
  // trigger. Its "More options" button still opens the menu when clicked while hidden, so a
  // labelled menu trigger is used whether or not it is visible; unlabelled guesses must be visible.
  function optionsButtonIn(tile, settings) {
    const re = optionsRe(settings);
    const label = (b) => (b.getAttribute('aria-label') || '') + ' ' + (b.title || '');
    const isTrigger = (b) => /^(menu|true)$/.test(b.getAttribute('aria-haspopup') || '');
    const roots = uniq([tile, tile.parentElement, tile.closest('flow-grid-tile-container, [role="group"]')].filter(Boolean));
    for (const root of roots) {
      const all = Array.from(root.querySelectorAll('button, [role="button"]'));
      const pref = all.find((b) => isTrigger(b) && re.test(label(b))) || all.find((b) => re.test(label(b))) || all.find(isTrigger);
      if (pref) return pref;
      const vis = all.filter(isVisible);
      if (vis.length) return vis[vis.length - 1];
    }
    return null;
  }
  const DOWNLOAD_WORDS_RE = /download|descargar|t[ée]l[ée]charger|herunterladen|scarica|baixar|ダウンロード|下载|다운로드/i;
  function isDownloadItem(text, settings) {
    if (settings.downloadLabel && settings.downloadLabel.toLowerCase() !== 'download') { try { if (new RegExp(escapeRe(settings.downloadLabel), 'i').test(text)) return true; } catch (e) { /* ignore */ } }
    return DOWNLOAD_WORDS_RE.test(text);
  }

  let lastMenuTexts = [];
  const resRank = (t) => { const m = t.match(/(\d+)\s*(k|p)\b/i); if (!m) return 0; const n = parseInt(m[1], 10); return m[2].toLowerCase() === 'k' ? n * 1000 : n; };
  /** The upscaled size wanted for this kind of item. */
  function pickUpscaleSize(kind, settings) { return kind === 'video' ? String(settings.videoUpscale || '1080p') : String(settings.imageUpscale || '2K'); }
  function pickResolutionItem(items, settings, kind) {
    const wantRes = pickUpscaleSize(kind, settings);
    const labelRe = new RegExp(escapeRe(settings.upscaleLabel || 'upscal'), 'i');
    const isDisabled = (el) => !!el.disabled || el.getAttribute('aria-disabled') === 'true';
    const notGif = items.filter((el) => !/gif/i.test(textOf(el)) && !isDisabled(el)); // e.g. 4K locked behind "Upgrade"
    const up = notGif.filter((el) => labelRe.test(textOf(el)));
    const resRe = new RegExp(wantRes.replace(/\s+/g, '').replace(/(\d)([kp])$/i, '$1\\s*$2'), 'i');
    return up.find((el) => resRe.test(textOf(el))) || up.slice().sort((a, b) => resRank(textOf(b)) - resRank(textOf(a)))[0] || null;
  }
  function armDownloadCapture() {
    const W = PAGE;
    const state = { blob: null, blobUrl: null, anchor: null, link: null, waiters: [] };
    const notify = () => { for (const w of state.waiters.splice(0)) w(); };
    let origCreate = null, origClick = null;
    try {
      origCreate = W.URL.createObjectURL;
      W.URL.createObjectURL = function (obj) {
        const u = origCreate.call(this, obj);
        try { if (obj && typeof obj.type === 'string' && /^(image|video)\//.test(obj.type) && obj.size > 100000) { state.blob = obj; state.blobUrl = u; notify(); } } catch (e) { /* ignore */ }
        return u;
      };
    } catch (e) { origCreate = null; }
    try {
      origClick = W.HTMLAnchorElement.prototype.click;
      W.HTMLAnchorElement.prototype.click = function () {
        try {
          if (this.hasAttribute('download') && /^(blob|data):/.test(this.href || '')) { state.anchor = { href: this.href, name: this.getAttribute('download') }; notify(); return; }
          if (this.hasAttribute('download') || /flow-content\.google|googleusercontent\.com|storage\.googleapis\.com/.test(this.href || '')) { state.link = true; notify(); } // Flow saves this one itself
        } catch (e) { /* ignore */ }
        return origClick.apply(this, arguments);
      };
    } catch (e) { origClick = null; }
    return {
      canSuppress: !!origClick, state,
      wait(ms) {
        return new Promise((res) => {
          if (state.anchor || state.link) return res(state);
          const t = setTimeout(() => res(state), ms);
          state.waiters.push(() => { clearTimeout(t); setTimeout(() => res(state), state.anchor ? 0 : 400); });
        });
      },
      disarm() {
        try { if (origCreate) W.URL.createObjectURL = origCreate; } catch (e) { /* ignore */ }
        try { if (origClick) W.HTMLAnchorElement.prototype.click = origClick; } catch (e) { /* ignore */ }
      },
    };
  }

  async function uiDownloadUpscaled(item, settings, savedSize) {
    if (!currentProjectId()) throw new UpscaleDeferError('upscaled mode needs a project page open in this tab', true);
    if (item.projectId && item.projectId.toLowerCase() !== currentProjectId()) throw new UpscaleDeferError('belongs to another project; only the open project\'s grid can be driven');
    activity('Finding its tile in the grid…');
    const tile = await findTile(item);
    if (!tile) throw new UpscaleDeferError('tile not found in the grid (Flow does not show it there, or the thumbnail did not match)');
    try { tile.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
    await sleep(250);
    hoverEl(tile);
    const img = tile.querySelector('img'); if (img) hoverEl(img);
    const btn = await waitUntil(() => optionsButtonIn(tile, settings), 2500);
    if (!btn) throw new UpscaleDeferError('no options button appeared on the tile after hover');
    activity('Opening its menu…');
    const before = new Set(visibleMenuItems());
    clickEl(btn);
    const menu = await waitUntil(() => { const v = visibleMenuItems().filter((m) => !before.has(m)); return v.length ? v : null; }, 3000);
    if (!menu) throw new UpscaleDeferError('tile menu did not open');
    lastMenuTexts = menu.map(textOf);
    const dl = menu.find((m) => isDownloadItem(textOf(m), settings));
    if (!dl) { pressEscape(); throw new UpscaleDeferError('no Download entry in the tile menu: ' + lastMenuTexts.join(' | ')); }
    const seen = new Set(visibleMenuItems());
    const t0 = Date.now();
    const capture = armDownloadCapture();
    try {
      hoverEl(dl); clickEl(dl);
      const sub = await waitUntil(() => { const v = visibleMenuItems().filter((m) => !seen.has(m)); return v.length ? v : null; }, 2500);
      let chosenText = 'direct download', upscaled = false;
      if (sub) {
        lastMenuTexts = sub.map(textOf);
        const chosen = pickResolutionItem(sub, settings, item.kind);
        if (!chosen) {
          pressEscape();
          const labelRe = new RegExp(escapeRe(settings.upscaleLabel || 'upscal'), 'i');
          const grey = sub.filter((el) => labelRe.test(textOf(el)) && !/gif/i.test(textOf(el)) && (!!el.disabled || el.getAttribute('aria-disabled') === 'true'));
          if (grey.length) throw new UpscaleLimitError(grey.map(textOf).join(', '), `Flow's upscale entries are greyed out (${grey.map(textOf).join(', ')}), so no upscales are left`);
          throw new Error('no upscaled entry found in: ' + lastMenuTexts.join(' | '));
        }
        chosenText = textOf(chosen); upscaled = true;
        const gotSize = (chosenText.match(/\d+\s*[kp]\b/i) || [''])[0];
        const wantSize = pickUpscaleSize(item.kind, settings);
        if (gotSize && savedSize && doneKey('', true, gotSize) !== doneKey('', true, wantSize) && savedSize(gotSize)) {
          pressEscape(); // e.g. 4K is locked on this plan and its 2K is already saved
          throw new UpscaleDeferError(`${wantSize} isn't available in Flow's menu, and its ${gotSize.replace(/\s+/g, '')} is already saved`);
        }
        hoverEl(chosen); clickEl(chosen);
      }
      const shownSize = (chosenText.match(/\d+\s*[kp]\b/i) || [pickUpscaleSize(item.kind, settings)])[0].replace(/\s+/g, '');
      activity(upscaled ? `Flow is upscaling to ${shownSize}…` : 'Waiting for Flow\'s download…');
      const timeoutMs = Math.max(10, settings.upscaleTimeoutSec || 120) * 1000 * (item.kind === 'video' ? 3 : 1); // video upscales take longer
      const deadline = Date.now() + timeoutMs;
      let signal = null;
      const checkToasts = () => {
        for (const t of toastsSince(t0)) {
          if (LIMIT_RE.test(t.text)) { pressEscape(); throw new UpscaleLimitError(t.text); }
          if (FAIL_RE.test(t.text)) { pressEscape(); throw new Error(`Flow reported: "${t.text}"`); }
        }
      };
      while (Date.now() < deadline) {
        if (stopFlag) { pressEscape(); throw new Error('stopped by user'); }
        const st = await capture.wait(Math.min(1500, Math.max(50, deadline - Date.now())));
        checkToasts();
        if (st.anchor || st.blob || st.link) { signal = 'file'; break; }
        if (upscaleCallsSince(t0, settings).length) { signal = 'rpc'; await capture.wait(5000); checkToasts(); break; }
      }
      pressEscape();
      const avgKey = item.kind === 'video' ? AVG_UP_VIDEO_KEY : AVG_UP_KEY;
      if (signal && upscaled) { const d = Date.now() - t0; const avg = store.get(avgKey, 0); store.set(avgKey, Math.round(avg ? avg * 0.7 + d * 0.3 : d)); }
      if (signal) activity('Saving the file…');
      if (!signal) throw new UpscaleDeferError(`no completion signal within ${timeoutMs / 1000}s after choosing "${chosenText}" (Flow may still be working; it stays queued)`);
      const st = capture.state;
      const tag = chosenText.replace(/[^\w\s-]/g, '').trim();
      const qualityLabel = upscaled ? (tag || 'upscaled') : 'original';
      if (st.anchor && capture.canSuppress) {
        let blob = st.blob;
        if (!blob || st.anchor.href !== st.blobUrl) { try { blob = await (await fetch(st.anchor.href)).blob(); } catch (e) { blob = blob || null; } }
        if (!blob) throw new Error('intercepted the download but could not read its bytes');
        let ext = extFromMime(blob.type, item.kind);
        try { ext = sniffExt(new Uint8Array(await blob.slice(0, 16).arrayBuffer())) || ext; } catch (e) { /* ignore */ }
        const name = buildFileName(item, ext, settings.namePattern, upscaled ? tag : '');
        const rel = buildRelPath(item, name, pathOptsFor(item, settings));
        capture.disarm();
        const saved = await saveBlob(blob, rel, settings);
        return { name, path: saved.path, bytes: blob.size, how: saved.how, viaPoster: false, upscaled, size: upscaled ? shownSize : '', qualityLabel };
      }
      await pacedSleep(Math.min(15000, 1500 + (st.blob ? st.blob.size / 2e6 * 1000 : 3000)));
      return { name: `${chosenText} — saved by Flow under its own filename`, path: '', bytes: st.blob ? st.blob.size : 0, how: 'flow-ui', viaPoster: false, upscaled, size: upscaled ? shownSize : '', qualityLabel, flowNamed: true };
    } finally {
      capture.disarm();
    }
  }

  // ---------------------------------------------------------------------------
  // Learn mode: watch the page's own traffic and the menus you click
  // ---------------------------------------------------------------------------

  const netSamples = [];
  const clickSamples = [];
  let hooksInstalled = false;
  function analyzeBatchText(url, text) {
    try {
      let urlRpcids = '';
      try { urlRpcids = new URL(url, location.origin).searchParams.get('rpcids') || ''; } catch (e) { /* ignore */ }
      for (const f of parseBatchResponse(text)) {
        if (!f.payload) { netSamples.push({ t: Date.now(), rpcid: f.rpcid, size: 0, error: true, urlRpcids }); continue; }
        const json = JSON.stringify(f.payload);
        const items = extractItems(f.payload).items.length;
        const hasContent = collectUrls(f.payload).some((u) => u.includes(CONTENT_HOST));
        const hasBig = collectStrings(f.payload).some((s) => s.length > 50000);
        const numbersOnly = Array.isArray(f.payload) && f.payload.length > 0 && f.payload.length <= 4 && f.payload.every((x) => typeof x === 'number' || x == null);
        netSamples.push({ t: Date.now(), rpcid: f.rpcid, size: json.length, items, hasContent, hasBig, numbersOnly, urlRpcids });
      }
      if (netSamples.length > 400) netSamples.splice(0, 200);
    } catch (e) { /* ignore */ }
  }
  function onLearnClick(e) {
    try {
      if (!e.isTrusted) return; // only learn from the human, not from our own synthetic clicks
      const el = e.target && e.target.closest && e.target.closest('[role="menuitem"],[role="menuitemradio"],button,[role="button"]');
      if (!el) return;
      const isMenuItem = /^menuitem/.test(el.getAttribute('role') || '');
      const sample = { t: Date.now(), kind: isMenuItem ? 'menuitem' : 'button', text: textOf(el), ariaLabel: el.getAttribute('aria-label') || '', inTile: !!el.closest(TILE_SELECTOR), visibleBefore: visibleMenuItems().map(textOf), visibleAfter: null };
      clickSamples.push(sample); if (clickSamples.length > 60) clickSamples.splice(0, 30);
      setTimeout(() => { sample.visibleAfter = visibleMenuItems().map(textOf); }, 450);
    } catch (err) { /* ignore */ }
  }
  function installLearnHooks() {
    if (hooksInstalled) return; hooksInstalled = true;
    try {
      const origFetch = PAGE.fetch;
      PAGE.fetch = function (input, init) {
        const p = origFetch.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.includes('/data/batchexecute')) p.then((resp) => { try { resp.clone().text().then((t) => analyzeBatchText(url, t)).catch(() => {}); } catch (e) { /* ignore */ } }).catch(() => {});
        } catch (e) { /* ignore */ }
        return p;
      };
    } catch (e) { /* ignore */ }
    try {
      const X = PAGE.XMLHttpRequest.prototype;
      const origOpen = X.open, origSend = X.send;
      X.open = function (method, url) { try { this.__fbdUrl = String(url); } catch (e) { /* ignore */ } return origOpen.apply(this, arguments); };
      X.send = function () {
        try {
          if (this.__fbdUrl && this.__fbdUrl.includes('/data/batchexecute')) {
            this.addEventListener('load', () => { try { if (!this.responseType || this.responseType === 'text') analyzeBatchText(this.__fbdUrl, this.responseText); } catch (e) { /* ignore */ } });
          }
        } catch (e) { /* ignore */ }
        return origSend.apply(this, arguments);
      };
    } catch (e) { /* ignore */ }
    document.addEventListener('click', onLearnClick, true);
  }
  function learnedNow() {
    const inferred = inferLearned(netSamples, clickSamples);
    const prev = loadLearned();
    const merged = Object.assign({}, prev, inferred, { at: Date.now() });
    if (Object.keys(inferred).length) saveLearned(merged);
    return merged;
  }

  // ---------------------------------------------------------------------------
  // Scan / run orchestration
  // ---------------------------------------------------------------------------

  let running = false;
  let lastScan = null;
  function localInputToMs(v) { if (!v) return null; const t = new Date(v).getTime(); return isNaN(t) ? null : t; }
  function msToLocalInput(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  function targetProjectIds(settings) {
    if (settings.scope === 'current') { const cur = currentProjectId(); return cur ? [cur] : []; }
    return uniq((settings.selectedProjects || []).map((s) => s.toLowerCase()).concat(parseExtraProjects(settings.extraProjects)));
  }
  function filterItems(items, settings, opts) {
    opts = opts || {};
    const since = opts.ignoreDates ? null : localInputToMs(settings.sinceLocal);
    const until = opts.ignoreDates ? null : localInputToMs(settings.untilLocal);
    const done = loadDone();
    const inc = compileTerms(settings.keywordInclude), exc = compileTerms(settings.keywordExclude);
    const modelRe = settings.modelFilter ? new RegExp(escapeRe(settings.modelFilter), 'i') : null;
    const out = { keep: [], skippedDone: 0, skippedType: 0, skippedDate: 0, skippedUndated: 0, skippedKeyword: 0, skippedModel: 0, skippedUpload: 0, skippedNotInGrid: 0 };
    for (const it of items) {
      const kind = it.kind || 'unknown';
      const wantKind = (kind === 'image' && settings.images) || (kind === 'video' && settings.videos) || (kind === 'unknown' && (settings.images || settings.videos));
      if (!wantKind) { out.skippedType++; continue; }
      if (!settings.includeNotInGrid && it.inGrid === false) { out.skippedNotInGrid++; continue; }
      if (settings.excludeUploads && !it.hasRecord) { out.skippedUpload++; continue; }
      if (!matchesKeywords(it.title, inc, exc)) { out.skippedKeyword++; continue; }
      if (modelRe && !modelRe.test(it.model || '')) { out.skippedModel++; continue; }
      if (it.createdMs == null) {
        if (!settings.includeUndated && !opts.ignoreDates) { out.skippedUndated++; continue; }
      } else {
        if (since != null && it.createdMs < since) { out.skippedDate++; continue; }
        if (until != null && it.createdMs > until) { out.skippedDate++; continue; }
      }
      if (settings.skipDone && !opts.ignoreDone) {
        const wantUp = upscalable(it, settings);
        const orig = done[doneKey(it.mediaId, false)];
        if (done[doneKey(it.mediaId, wantUp, wantUp && pickUpscaleSize(kind, settings))] || (wantUp && orig && (orig.noUpscale || isUploadedFile(it)))) { out.skippedDone++; continue; }
      }
      out.keep.push(it);
    }
    out.keep.sort((a, b) => (a.createdMs || 0) - (b.createdMs || 0));
    return out;
  }
  function skipSummaryShort(f) { return 'skipped ' + (skipSummary(f).split(', ').filter((x) => !/^0 /.test(x)).join(', ') || 'nothing'); }
  function skipSummary(f) {
    const parts = [`${f.skippedDone} already downloaded`, `${f.skippedDate} outside date range`, `${f.skippedType} wrong type`, `${f.skippedUndated} undated`];
    if (f.skippedKeyword) parts.push(`${f.skippedKeyword} keyword`);
    if (f.skippedModel) parts.push(`${f.skippedModel} model`);
    if (f.skippedUpload) parts.push(`${f.skippedUpload} uploads`);
    if (f.skippedNotInGrid) parts.push(`${f.skippedNotInGrid} not shown in the project grid`);
    return parts.join(', ');
  }

  async function scan(settings, log) {
    const ids = targetProjectIds(settings);
    if (!ids.length) throw new Error(settings.scope === 'current' ? 'Open a project page (flow.google.com/project/…) or switch scope to "Selected projects".' : 'No projects selected. Visit the Flow home page so projects can be discovered, or paste project IDs.');
    const all = [], perProject = [];
    for (const pid of ids) {
      if (stopFlag) break;
      log(`Listing project ${projectTitleFor(pid)} (${pid.slice(0, 8)})…`);
      activity(`Listing project ${projectTitleFor(pid) || pid.slice(0, 8)}… (big projects take a few seconds)`);
      const r = await listProjectMedia(pid, settings, log);
      const dates = r.items.map((i) => i.createdMs).filter((x) => x != null);
      const range = dates.length ? `${fmtHuman(Math.min(...dates))} → ${fmtHuman(Math.max(...dates))}` : 'no dates found';
      log(`  ${r.items.length} items via ${r.source || 'n/a'} (${r.items.filter((i) => i.kind === 'image').length} images, ${r.items.filter((i) => i.kind === 'video').length} videos${r.stats && r.stats.notInGrid ? `, ${r.stats.notInGrid} not in the grid` : ''}); dates ${range}`);
      perProject.push({ projectId: pid, count: r.items.length, source: r.source, stats: r.stats, rawSample: r.raw });
      all.push(...r.items);
      await sleep(settings.delayMs);
    }
    lastScan = { items: all, perProject, at: Date.now() };
    return lastScan;
  }

  function notifyUser(settings, title, text) {
    if (!settings.notify) return;
    try { if (typeof GM_notification === 'function') GM_notification({ title, text, timeout: 8000 }); } catch (e) { /* ignore */ }
  }
  function recordUpscale() { const l = loadUpscaleLog(); l.push(Date.now()); saveUpscaleLog(l); }
  function upscalesLast24h() { return countSince(loadUpscaleLog(), Date.now() - 86400000); }

  async function runDownload(settings, ui, opts) {
    opts = opts || {};
    if (running) return;
    running = true; stopFlag = false;
    const log = ui.log;
    const runStamp = Date.now();
    const rows = [];
    try {
      const s = await scan(settings, log);
      const f = filterItems(s.items, settings);
      let keep = f.keep;
      if (opts.exclude && opts.exclude.size) {
        const n0 = keep.length;
        keep = keep.filter((i) => !opts.exclude.has(i.mediaId));
        if (keep.length < n0) log(`Leaving out ${n0 - keep.length} item(s) you unticked in the list.`);
      }
      if (opts.limit) keep = keep.slice(-opts.limit); // newest first for a test run
      log(`${opts.limit ? 'TEST RUN — ' : ''}Matched ${f.keep.length} item(s)${opts.limit ? `, processing ${keep.length}` : ''}. Skipped: ${skipSummary(f)}.`);
      ui.renderItems(keep);
      if (!keep.length) { ui.finish('Nothing to download: ' + skipSummaryShort(f) + '.'); return; }
      const upMode = anyUpscale(settings);
      let upAllowed = upMode;
      const limitPauseMs = Math.max(1, settings.limitPauseHours || 24) * 3600000;
      if (upMode) {
        const cur = currentProjectId();
        if (!cur) log('Upscaled mode needs a project page open in this tab; items to upscale will be deferred.');
        else if (keep.some((i) => upscalable(i, settings) && i.projectId && i.projectId.toLowerCase() !== cur)) log('Upscaled mode can only drive the grid of the project open in this tab; items from other projects are deferred.');
        const what = [settings.quality === 'upscaled' && `pictures (preferring ${settings.imageUpscale})`, settings.videoQuality === 'upscaled' && `videos (preferring ${settings.videoUpscale})`].filter(Boolean).join(' and ');
        const plain = [settings.quality !== 'upscaled' && settings.images && 'Pictures', settings.videoQuality !== 'upscaled' && settings.videos && 'Videos'].filter(Boolean).join(' and ');
        log(`Upscaled mode: Flow will upscale ${what}, else the best size your plan allows, one at a time (pause ${settings.upscalePauseSec}s between).${plain ? ` ${plain} are saved at original quality.` : ''}`);
        const limitAt = store.get('fbd.upscaleLimitAt', 0);
        if (limitAt && Date.now() - limitAt < limitPauseMs) {
          log(`⏸ Flow's upscale limit was hit at ${fmtHuman(limitAt)}; upscaling is paused until ${fmtHuman(limitAt + limitPauseMs)} (${settings.onLimit === 'originals' ? 'saving originals meanwhile' : 'those pictures are deferred'}). Use "Reset limit pause" to override.`);
          upAllowed = false;
        }
        if (upAllowed && settings.dailyUpscaleCap > 0) log(`Upscales in the last 24 h: ${upscalesLast24h()} / ${settings.dailyUpscaleCap}`);
      }
      const done = loadDone();
      let ok = 0, fail = 0, upscalesDone = 0, deferred = 0, failStreak = 0, noGridStreak = 0, gridMissing = false;
      let retryIdx = -1, hiddenRetries = 0, upFailStreak = 0;
      const hitLimit = (reason) => {
        store.set('fbd.upscaleLimitAt', Date.now());
        upAllowed = false;
        log(`⚠ ${reason}`);
        notifyUser(settings, 'Flow Bulk Downloader', 'Upscale limit reached — upscaling paused.');
      };
      for (let i = 0; i < keep.length; i++) {
        if (stopFlag) { log('Stopped.'); break; }
        const it = keep[i];
        const needsUp = upscalable(it, settings);
        if (needsUp && gridMissing) { deferred++; continue; }
        if (needsUp && upAllowed && settings.dailyUpscaleCap > 0 && upscalesLast24h() >= settings.dailyUpscaleCap) {
          const oldest = Math.min(...loadUpscaleLog().filter((t) => Date.now() - t < 86400000));
          store.set('fbd.upscaleLimitAt', isFinite(oldest) ? oldest : Date.now());
          upAllowed = false;
          log(`⏸ Daily upscale cap of ${settings.dailyUpscaleCap} reached (counted locally); upscaling pauses until ${fmtHuman((isFinite(oldest) ? oldest : Date.now()) + limitPauseMs)}.`);
          if (settings.onLimit !== 'originals') { deferred += keep.length - i; log('Remaining upscales are deferred to a later run.'); break; }
        }
        if (needsUp && !upAllowed && settings.onLimit !== 'originals') { deferred++; continue; }
        if (needsUp && !upAllowed && done[doneKey(it.mediaId, false)]) { deferred++; continue; } // original already saved; it waits for upscaling
        if (needsUp && upAllowed && settings.maxUpscalesPerRun > 0 && upscalesDone >= settings.maxUpscalesPerRun) {
          if (deferred === 0) log(`Per-run upscale budget of ${settings.maxUpscalesPerRun} reached; remaining upscales are deferred to the next run.`);
          deferred++; continue;
        }
        ui.progress(i, keep.length, it, { ok, fail, deferred });
        try {
          let r, upscaleFailed = false, noUpscale = false;
          if (needsUp && upAllowed) {
            await waitForVisibleTab(log);
            if (stopFlag) continue;
            if (retryIdx !== i) { retryIdx = i; hiddenRetries = 0; }
            const attemptAt = Date.now();
            try {
              r = await uiDownloadUpscaled(it, settings, (size) => !!done[doneKey(it.mediaId, true, size)]);
              if (!r.upscaled) { noUpscale = true; log(`  Flow's menu offers no upscaled sizes for ${it.mediaId.slice(0, 8)} (e.g. an uploaded picture); saved at original quality and counted as done`); }
              if (r.upscaled) {
                upscalesDone++; recordUpscale(); upFailStreak = 0;
                const pauseMs = Math.max(0, settings.upscalePauseSec || 0) * 1000;
                if (pauseMs && i < keep.length - 1) activity('Waiting before the next one so Flow is not rushed…', { untilMs: pauseMs });
                await pacedSleep(pauseMs);
              }
            } catch (e) {
              if (stopFlag) { log('Stopped.'); break; }
              const hadOrig = !!done[doneKey(it.mediaId, false)];
              let limitMsg = e && e.limit ? e.message : '';
              // Flow does not always word the limit clearly, so two failed upscales in a row count as the limit
              if (!limitMsg && !(e && e.defer) && ++upFailStreak >= 2) limitMsg = `${upFailStreak} upscales failed in a row (last: ${e.message}), so Flow's upscale limit is probably reached`;
              if (limitMsg) {
                hitLimit(limitMsg);
                if (settings.onLimit !== 'originals') { log(`Stopping this run. Run again after ${fmtHuman(Date.now() + limitPauseMs)}; nothing was marked as done, so these items will be retried.`); deferred++; break; }
                log('Continuing with original quality for the rest; they stay queued for upscaling after the pause.');
                if (hadOrig) { deferred++; log(`  ⏭ ${it.mediaId.slice(0, 8)}: its original is already saved`); continue; }
                r = await downloadItem(it, settings, log);
              } else if (e && e.defer && (tabHidden() || hiddenAt >= attemptAt) && hiddenRetries++ < 3) {
                i--; continue; // the tab was hidden mid-attempt: wait for it, then retry this picture
              } else if (e && e.defer) {
                deferred++;
                log(`  ⏭ ${it.mediaId.slice(0, 8)} deferred: ${e.message}`);
                if (e.noGrid && ++noGridStreak >= 2) { gridMissing = true; log('No usable project grid in this tab — remaining pictures are deferred. Open the project, keep the tab visible, and run again.'); }
                await pacedSleep(settings.delayMs);
                continue;
              } else if (!settings.fallbackOriginal) {
                throw e;
              } else if (hadOrig) {
                deferred++;
                log(`  upscale failed for ${it.mediaId.slice(0, 8)}: ${e.message}; its original is already saved, so it stays queued for upscaling`);
                await pacedSleep(settings.delayMs);
                continue;
              } else {
                log(`  upscale failed for ${it.mediaId.slice(0, 8)}: ${e.message} → saving the original instead (it stays queued for upscaling)`);
                r = await downloadItem(it, settings, log); upscaleFailed = true;
              }
            }
          } else {
            activity(it.kind === 'video' ? 'Downloading the video…' : 'Downloading the original…');
            r = await downloadItem(it, settings, log);
          }
          try { await writeSidecar(it, r, settings); } catch (e) { log(`  sidecar failed: ${e.message}`); }
          ok++; failStreak = 0;
          done[doneKey(it.mediaId, !!r.upscaled, r.size)] = { name: r.path || r.name, at: Date.now(), project: it.projectId, bytes: r.bytes, upscaled: !!r.upscaled, quality: r.qualityLabel || (r.upscaled ? 'upscaled' : 'original'), upscaleFailed, noUpscale };
          saveDone(done);
          rows.push({
            savedAt: new Date().toISOString(), mediaId: it.mediaId, projectId: it.projectId || '', projectTitle: projectTitleFor(it.projectId), title: it.title || '',
            created: it.createdMs != null ? new Date(it.createdMs).toISOString() : '', kind: it.kind, model: it.model || '', quality: r.qualityLabel,
            file: r.path || r.name, bytes: r.bytes || '', status: r.flowNamed ? 'saved by Flow' : (upscaleFailed ? 'original (upscale failed)' : 'saved'), flowSizeBytes: it.sizeBytes || '',
          });
          log(`✔ ${r.path || r.name}${r.flowNamed ? '' : ` (${(r.bytes / 1024).toFixed(0)} KB${r.viaPoster ? ', preview quality' : ''}${r.upscaled ? ', upscaled' : ''})`}`);
        } catch (e) {
          fail++; failStreak++;
          log(`✘ ${it.mediaId.slice(0, 8)} ${fmtHuman(it.createdMs)}: ${e.message}`);
          rows.push({ savedAt: new Date().toISOString(), mediaId: it.mediaId, projectId: it.projectId || '', projectTitle: projectTitleFor(it.projectId), title: it.title || '', created: it.createdMs != null ? new Date(it.createdMs).toISOString() : '', kind: it.kind, model: it.model || '', quality: '', file: '', bytes: '', status: 'failed: ' + e.message, flowSizeBytes: it.sizeBytes || '' });
          if (failStreak >= 6) { log('6 failures in a row — stopping this run so Flow is not hammered. Check the log / Diagnose, then run again.'); break; }
          if (failStreak >= 3) { log('3 failures in a row — pausing 2 minutes before continuing.'); activity('Pausing after 3 failures in a row…', { untilMs: 120000 }); await pacedSleep(120000); }
        }
        await pacedSleep(settings.delayMs);
      }
      if (!opts.limit) store.set('fbd.lastRun', Date.now());
      if (rows.length) {
        const m = loadManifest(); m.push(...rows); saveManifest(m);
        if (settings.manifestPerRun && ok > 0) {
          const name = `manifest-${fmtStamp(runStamp)}.csv`;
          const rel = (settings.subfolder ? safeName(settings.subfolder, 80) + '/' : '') + name;
          try { await saveText(toCsv(rows, MANIFEST_COLUMNS), rel, settings, 'text/csv;charset=utf-8'); log(`Manifest saved: ${name}`); } catch (e) { log(`Manifest failed: ${e.message}`); }
        }
      }
      const doneMsg = `Done: ${ok} saved, ${fail} failed${upscalesDone ? `, ${upscalesDone} upscaled` : ''}${deferred ? `, ${deferred} deferred` : ''}.`;
      log(doneMsg);
      ui.finish(stopFlag ? 'Stopped. ' + doneMsg : doneMsg, 1);
      if (!opts.limit && (ok || fail)) notifyUser(settings, 'Flow Bulk Downloader', `Done: ${ok} saved, ${fail} failed${deferred ? `, ${deferred} deferred` : ''}.`);
    } catch (e) {
      log(`Error: ${e.message}`);
      ui.finish(`Error: ${e.message}`);
    } finally {
      running = false;
      ui.setRunning(false);
    }
  }
  const MANIFEST_COLUMNS = ['savedAt', 'mediaId', 'projectId', 'projectTitle', 'title', 'created', 'kind', 'model', 'quality', 'file', 'bytes', 'status', 'flowSizeBytes'];

  async function markAllDone(settings, log) {
    const s = await scan(settings, log);
    const f = filterItems(s.items, settings, { ignoreDates: true, ignoreDone: true });
    const done = loadDone();
    let n = 0;
    for (const it of f.keep) {
      const up = upscalable(it, settings);
      const k = doneKey(it.mediaId, up, up && pickUpscaleSize(it.kind, settings));
      if (!done[k]) { done[k] = { name: '(marked as done manually)', at: Date.now(), project: it.projectId, bytes: 0, upscaled: up, upscaleFailed: false, manual: true }; n++; }
    }
    saveDone(done);
    log(`Marked ${n} item(s) as already downloaded. Future runs will only pick up newer items.`);
  }

  function buildBackup(settings) {
    return {
      app: 'flow-bulk-downloader', version: VERSION, exportedAt: new Date().toISOString(),
      settings, done: loadDone(), projects: loadProjects(), upscaleLog: loadUpscaleLog(), manifest: loadManifest(), learned: loadLearned(),
      lastRun: store.get('fbd.lastRun', null), upscaleLimitAt: store.get('fbd.upscaleLimitAt', 0),
    };
  }
  function restoreBackup(b) {
    if (!b || b.app !== 'flow-bulk-downloader') throw new Error('not a Flow Bulk Downloader backup file');
    if (b.settings) saveSettings(Object.assign({}, DEFAULT_SETTINGS, b.settings));
    if (b.done) saveDone(Object.assign({}, loadDone(), b.done));
    if (b.projects) saveProjects(Object.assign({}, loadProjects(), b.projects));
    if (Array.isArray(b.upscaleLog)) saveUpscaleLog(uniq(loadUpscaleLog().concat(b.upscaleLog)));
    if (Array.isArray(b.manifest)) { const seen = new Set(loadManifest().map((r) => r.savedAt + '|' + r.mediaId + '|' + r.quality)); const m = loadManifest(); for (const r of b.manifest) { const k = r.savedAt + '|' + r.mediaId + '|' + r.quality; if (!seen.has(k)) { m.push(r); seen.add(k); } } m.sort((a, c) => String(a.savedAt).localeCompare(String(c.savedAt))); saveManifest(m); }
    if (b.learned) saveLearned(Object.assign({}, loadLearned(), b.learned));
    if (b.lastRun) store.set('fbd.lastRun', Math.max(store.get('fbd.lastRun', 0) || 0, b.lastRun));
    if (b.upscaleLimitAt) store.set('fbd.upscaleLimitAt', Math.max(store.get('fbd.upscaleLimitAt', 0) || 0, b.upscaleLimitAt));
  }

  function buildDiagnostics(settings) {
    const wiz = getWiz();
    const rpcids = {};
    for (const u of observedBatchUrls()) { try { const r = new URL(u).searchParams.get('rpcids'); if (r) rpcids[r] = (rpcids[r] || 0) + 1; } catch (e) { /* ignore */ } }
    const tiles = document.querySelectorAll(TILE_SELECTOR);
    const out = {
      generatedAt: new Date().toISOString(), scriptVersion: VERSION, page: location.origin + location.pathname,
      session: { hasAt: !!wiz.at, hasSid: !!wiz.sid, bl: wiz.bl },
      batchPaths: candidateBatchPaths(), workingBatchPath, rpcidsObservedOnPage: rpcids,
      settings: Object.assign({}, settings, { extraProjects: parseExtraProjects(settings.extraProjects) }),
      learned: loadLearned(), learnSamples: { net: netSamples.slice(-40), clicks: clickSamples.slice(-20) },
      upscalesLast24h: upscalesLast24h(),
      ui: { tileCount: tiles.length, thumbnailCount: document.querySelectorAll('img[src*="/asb/"]').length, sampleTile: tiles[0] ? tiles[0].outerHTML.slice(0, 2000).replace(/(src|href|srcset)="[^"]*"/g, '$1="<redacted>"') : null, lastMenuTexts, recentToasts: toastLog.slice(-10) },
      lastScan: null,
    };
    if (lastScan) {
      out.lastScan = {
        at: new Date(lastScan.at).toISOString(),
        perProject: lastScan.perProject.map((p) => ({ projectId: p.projectId, count: p.count, source: p.source, stats: p.stats, rawSample: redactSample(p.rawSample) })),
        itemsSample: lastScan.items.slice(0, 25).map((i) => ({ mediaId: i.mediaId, kind: i.kind, title: i.title, createdMs: i.createdMs, createdSource: i.createdSource, sizeBytes: i.sizeBytes, status: i.status, model: i.model, hasRecord: i.hasRecord, inGrid: i.inGrid, urlKinds: { content: i.urls.content.map((u) => u.split('?')[0].replace(/\/[^/]+$/, '/<id>')), poster: i.urls.poster.length } })),
      };
    }
    return out;
  }
  function redactSample(raw) {
    if (raw == null) return null;
    const trim = (n, depth) => {
      if (depth > 9) return '…';
      if (Array.isArray(n)) return n.slice(0, 6).map((c) => trim(c, depth + 1)).concat(n.length > 6 ? [`…+${n.length - 6} more`] : []);
      return redact(n);
    };
    return trim(raw, 0);
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // flow.google.com sends `require-trusted-types-for 'script'`, so assigning a plain string to
  // innerHTML throws. All UI markup goes through setHTML(): a Trusted Types policy when one can be
  // created, otherwise a tiny builder that creates the (script-free, self-authored) markup node by node.
  const TT_POLICY = (() => {
    try {
      const tt = window.trustedTypes;
      if (tt && typeof tt.createPolicy === 'function') return tt.createPolicy('flow-bulk-downloader', { createHTML: (s) => s });
    } catch (_) { /* policy names restricted by CSP: use the builder */ }
    return null;
  })();

  const VOID_TAGS = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
  const RAW_TAGS = /^(style|textarea|title)$/i;
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k[0] === '#') { const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k];
    });
  }
  function buildFromHtml(parent, html) {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
    const tagRe = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
    const attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    const stack = [parent];
    const top = () => stack[stack.length - 1];
    let last = 0, m;
    while ((m = tagRe.exec(html))) {
      if (m.index > last) top().appendChild(document.createTextNode(decodeEntities(html.slice(last, m.index))));
      last = tagRe.lastIndex;
      if (m[0].startsWith('<!--')) continue;
      if (m[1]) { // closing tag: pop back to the matching element
        const name = m[1].toLowerCase();
        for (let i = stack.length - 1; i > 0; i--) if (stack[i].localName === name) { stack.length = i; break; }
        continue;
      }
      const el = document.createElement(m[2]);
      let a; attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[3] || ''))) el.setAttribute(a[1], decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
      top().appendChild(el);
      if (VOID_TAGS.test(m[2])) continue;
      if (RAW_TAGS.test(m[2])) { // contents are text up to the closing tag
        const close = html.toLowerCase().indexOf(`</${m[2].toLowerCase()}`, last);
        const end = close < 0 ? html.length : close;
        const text = html.slice(last, end);
        el.textContent = /^style$/i.test(m[2]) ? text : decodeEntities(text);
        const gt = close < 0 ? html.length : html.indexOf('>', close) + 1;
        last = tagRe.lastIndex = gt;
        continue;
      }
      stack.push(el);
    }
    if (last < html.length) top().appendChild(document.createTextNode(decodeEntities(html.slice(last))));
  }
  function setHTML(el, html) {
    if (TT_POLICY) { el.innerHTML = TT_POLICY.createHTML(html); return; }
    try { el.innerHTML = html; } catch (_) { buildFromHtml(el, html); }
  }

  function mountUI() {
    if (document.getElementById('fbd-host')) return;
    const host = document.createElement('div');
    host.id = 'fbd-host';
    host.style.cssText = 'position:fixed;z-index:2147483646;right:16px;bottom:16px;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const onLabs = location.hostname === 'labs.google';

    setHTML(root, `
      <style>
        :host { all: initial; --bg:#1e1f22; --bg2:#26272b; --field:#2f3034; --line:#3c4043; --text:#e8eaed; --muted:#9aa0a6; --accent:#8ab4f8; --blue:#1a73e8; --ok:#81c995; --bad:#f28b82; --warn:#fdd663; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; font-size: 13px; color: var(--text); }
        [hidden] { display:none !important; }
        .fab { display:none; background:var(--blue); color:#fff; border:none; border-radius:999px; padding:10px 14px; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,.4); font-weight:600; touch-action:none; user-select:none; }
        .fab.on { display:inline-flex; gap:6px; align-items:center; }
        .fab .badge { background:#fff; color:var(--blue); }
        .panel { display:none; flex-direction:column; width:440px; max-width:calc(100vw - 32px); max-height:min(640px, calc(100vh - 32px)); background:var(--bg); border:1px solid var(--line); border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,.6); overflow:hidden; }
        .panel.on { display:flex; }
        .head, .miniHead { display:flex; align-items:center; gap:8px; padding:8px 8px 8px 12px; cursor:grab; user-select:none; touch-action:none; }
        .head:active, .miniHead:active { cursor:grabbing; }
        .title { font-weight:600; font-size:14px; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .ver { color:var(--muted); font-weight:400; font-size:11px; }
        .icon { background:none; border:none; color:var(--muted); cursor:pointer; font-size:15px; padding:2px 6px; border-radius:6px; }
        .icon:hover { background:var(--field); color:var(--text); }
        .chips { display:flex; flex-wrap:wrap; gap:4px; padding:0 12px 8px; }
        .chip { background:var(--bg2); border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:11.5px; color:#c4c7c5; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .chip.ok { color:var(--ok); } .chip.warn { color:var(--warn); }
        .alert { margin:0 12px 8px; padding:6px 8px; border-radius:8px; background:rgba(253,214,99,.1); border:1px solid rgba(253,214,99,.35); color:var(--warn); font-size:12px; }
        .tabs { display:flex; gap:2px; padding:0 8px; border-bottom:1px solid var(--line); }
        .tab { background:none; border:none; border-bottom:2px solid transparent; color:var(--muted); padding:7px 10px; cursor:pointer; font-weight:600; }
        .tab.on { color:var(--accent); border-bottom-color:var(--accent); }
        .body { overflow:auto; padding:10px 12px 12px; flex:1; min-height:0; }
        .pane { display:none; } .pane.on { display:block; }
        .field { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; margin:0 0 8px; }
        .lbl { color:var(--muted); min-width:56px; }
        label { display:inline-flex; align-items:center; gap:6px; }
        .grid label { margin:3px 12px 3px 0; }
        input[type=text], input[type=number], input[type=datetime-local], select, textarea { background:var(--field); color:var(--text); border:1px solid #5f6368; border-radius:6px; padding:5px 7px; }
        input[type=checkbox], input[type=radio] { accent-color:var(--blue); }
        input[type=number] { width:70px; }
        input[type=text].wide { width:200px; }
        textarea { width:100%; min-height:44px; resize:vertical; }
        .seg { display:inline-flex; border:1px solid #5f6368; border-radius:8px; overflow:hidden; }
        .seg label { gap:0; position:relative; }
        .seg input { position:absolute; opacity:0; pointer-events:none; }
        .seg span { padding:5px 12px; cursor:pointer; color:#c4c7c5; }
        .seg input:checked + span { background:var(--blue); color:#fff; }
        .seg input:focus-visible + span { outline:2px solid var(--accent); outline-offset:-2px; }
        .hint { color:var(--muted); font-size:12px; margin:-2px 0 10px; }
        .actions { display:flex; gap:6px; margin:4px 0 10px; }
        .btn { background:var(--field); border:1px solid #5f6368; color:var(--text); border-radius:6px; padding:6px 10px; cursor:pointer; }
        .btn:hover:not(:disabled) { border-color:#80868b; }
        .btn.primary { background:var(--blue); border-color:var(--blue); color:#fff; font-weight:600; flex:1; }
        .btn.danger { border-color:#d93025; color:var(--bad); }
        .actions .btn.danger { flex:1; font-weight:600; }
        .btn.sm { padding:3px 8px; font-size:12px; }
        .btn:disabled { opacity:.5; cursor:not-allowed; }
        input:disabled, select:disabled, textarea:disabled, .seg input:disabled + span { opacity:.55; cursor:not-allowed; }
        label:has(> input:disabled) { color:var(--muted); }
        .btns { display:flex; gap:6px; flex-wrap:wrap; margin:6px 0; }
        .card { background:var(--bg2); border:1px solid var(--line); border-radius:10px; padding:10px; margin:0 0 8px; }
        .cardTop { display:flex; align-items:center; gap:10px; margin-bottom:2px; }
        .card.idle .cardTop { display:none; }
        .card.idle .lines > div:first-child { margin-top:0; }
        .count { font-size:18px; font-weight:700; white-space:nowrap; }
        .pct { color:var(--muted); font-size:12px; min-width:32px; text-align:right; }
        .bar { flex:1; height:6px; background:var(--line); border-radius:3px; overflow:hidden; }
        .bar > div { height:100%; background:var(--blue); width:0; transition:width .3s; }
        .lines > div { margin-top:4px; }
        .lines .item { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .lines .step { color:var(--accent); }
        .lines .eta, .lines .tally { color:var(--muted); font-size:12px; }
        .lines .msg { white-space:pre-wrap; color:#c4c7c5; }
        .tip { color:var(--muted); font-size:11.5px; margin:0 0 8px; }
        .link { background:none; border:none; color:var(--accent); cursor:pointer; padding:0 2px; font-size:11.5px; }
        details { border:1px solid var(--line); border-radius:8px; padding:6px 10px; margin:0 0 8px; }
        summary { color:#c4c7c5; cursor:pointer; font-weight:600; padding:2px 0; display:flex; align-items:center; gap:6px; list-style:none; }
        summary::-webkit-details-marker { display:none; }
        summary::before { content:'▸'; color:var(--muted); width:10px; }
        details[open] > summary::before { content:'▾'; }
        summary .sum { color:var(--muted); font-weight:400; font-size:11.5px; margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:60%; }
        .row { display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; margin:5px 0; }
        .badge { background:var(--blue); color:#fff; border-radius:999px; padding:0 6px; font-size:11px; font-weight:600; }
        .log { background:#111; border:1px solid var(--line); border-radius:6px; padding:6px; margin-top:6px; height:160px; overflow:auto; font-family: ui-monospace, Consolas, monospace; font-size:11.5px; white-space:pre-wrap; }
        .items { max-height:170px; overflow:auto; font-size:12px; margin-top:6px; }
        .items div { padding:2px 0; border-bottom:1px solid #2a2b2e; }
        .items.picking { max-height:300px; }
        .items .pick { display:flex; align-items:center; gap:8px; padding:3px 0; border-bottom:1px solid #2a2b2e; cursor:pointer; }
        .items .pick input { flex:none; margin:0; }
        .items .pick img, .items .pick .noimg { width:36px; height:36px; flex:none; object-fit:cover; border-radius:4px; background:var(--field); }
        .items .pick.off { opacity:.45; }
        .items .pickBar { position:sticky; top:0; z-index:1; display:flex; gap:6px; align-items:center; flex-wrap:wrap; background:var(--bg); padding:2px 0 6px; border-bottom:none; }
        .projects { max-height:120px; overflow:auto; }
        .projects label { display:flex; }
        .muted { color:var(--muted); }
        .note { color:var(--muted); font-size:12px; margin:6px 0 2px; }
        .warn { color:var(--warn); }
        h4 { margin:12px 0 4px; font-size:11.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
        h4:first-child { margin-top:0; }
        .learned { background:#1b1f24; border:1px dashed #5f6368; border-radius:6px; padding:6px; margin-top:6px; font-family: ui-monospace, Consolas, monospace; font-size:11.5px; white-space:pre-wrap; }
        .mini { display:none; width:320px; max-width:calc(100vw - 32px); background:var(--bg); border:1px solid var(--line); border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,.6); padding-bottom:10px; }
        .mini.on { display:block; }
        .mini .miniHead { padding:6px 6px 6px 12px; }
        .mini .title { font-size:13px; }
        .miniBar { display:flex; align-items:center; gap:8px; padding:0 12px; }
        .mini .lines { padding:0 12px; }
      </style>
      <div class="panel" id="panel">
        <div class="head" id="dragPanel" title="Drag to move · double-click to put it back in the corner">
          <div class="title">⬇ Flow Export <span class="ver">v${VERSION}</span></div>
          <button class="icon" id="minimize" title="Shrink to the small progress card" hidden>▁</button>
          <button class="icon" id="close" title="Close">✕</button>
        </div>
        <div class="chips" id="status"></div>
        <div class="alert" id="statusWarn" hidden></div>
        ${onLabs ? '<div class="alert">This page is the old labs.google Flow. Open <b>https://flow.google.com</b> and use the tool there.</div>' : ''}
        <div class="tabs">
          <button class="tab on" data-tab="main">Download</button>
          <button class="tab" data-tab="options">Options</button>
          <button class="tab" data-tab="tools">Tools</button>
        </div>
        <div class="body">
          <div class="alert" id="lockNote" hidden>🔒 Settings are locked while a run is going; the run uses what was set when it started. Press Stop to change them.</div>
          <section class="pane on" data-pane="main">
            <div class="field">
              <span class="lbl">From</span><input type="datetime-local" id="since">
            </div>
            <div class="field">
              <span class="lbl">To</span><input type="datetime-local" id="until"><span class="muted">empty = up to now</span>
            </div>
            <div class="field">
              <span class="lbl">Get</span>
              <label><input type="checkbox" id="images"> Pictures</label>
              <label><input type="checkbox" id="videos"> Videos</label>
              <label title="Leave out files that are already in the download history"><input type="checkbox" id="skipDone"> Skip already saved</label>
            </div>
            <div class="field" id="qPicRow">
              <span class="lbl">Pictures</span>
              <div class="seg">
                <label><input type="radio" name="quality" value="original" id="qOriginal"><span>Original</span></label>
                <label><input type="radio" name="quality" value="upscaled" id="qUpscaled"><span id="qUpLabel">Upscaled</span></label>
              </div>
            </div>
            <div class="field" id="qVidRow">
              <span class="lbl">Videos</span>
              <div class="seg">
                <label><input type="radio" name="vquality" value="original" id="vqOriginal"><span>Original</span></label>
                <label><input type="radio" name="vquality" value="upscaled" id="vqUpscaled"><span id="vqUpLabel">Upscaled</span></label>
              </div>
            </div>
            <div class="hint" id="qualityHint"></div>
            <div class="actions">
              <button class="btn" id="scan" title="List what would be downloaded, without downloading anything">Scan</button>
              <button class="btn primary" id="download">Download</button>
              <button class="btn danger" id="stop" disabled hidden>■ Stop</button>
              <button class="btn" id="test1" title="Download only the newest matching item, to check everything works">Test 1</button>
            </div>
            <div class="card idle" id="card">
              <div class="cardTop"><span class="count" id="pCount" hidden></span><div class="bar"><div id="barfill"></div></div><span class="pct" id="pPct"></span></div>
              <div class="lines" id="progress"></div>
            </div>
            <div class="tip" id="popupTip">Chrome's download pop-up can cover this panel. To turn it off: Chrome Settings → Downloads → turn off "Show downloads when they're done". Files still save normally. <button class="link" id="tipHide">Hide</button></div>
            <details id="itemsBox"><summary><span id="itemsHead">Matching items</span></summary><div class="items" id="items"><span class="muted">Scan to see matching items here.</span></div></details>
            <details id="logBox"><summary>Log <span class="badge" id="logBadge" hidden></span><span class="sum"><button class="link" id="copyLog" title="Copy the log to the clipboard">Copy</button></span></summary><div class="log" id="log"></div></details>
          </section>

          <section class="pane" data-pane="options">
            <details open>
              <summary>Filters <span class="sum" id="sumFilters"></span></summary>
              <div class="row grid">
                <label><input type="checkbox" id="undated"> Include items with no date</label>
              </div>
              <div class="row">
                <label>Prompt contains <input type="text" id="kwInc" class="wide" placeholder="cat, sunset, /regex/"></label>
                <label>but not <input type="text" id="kwExc" class="wide" placeholder="test, draft"></label>
              </div>
              <div class="row">
                <label>Model contains <input type="text" id="modelFilter" placeholder="e.g. NARWHAL"></label>
              </div>
              <div class="row grid">
                <label><input type="checkbox" id="excludeUploads"> Leave out my uploaded reference images (experimental)</label>
                <label><input type="checkbox" id="includeNotInGrid"> Include pictures not shown in the project grid (e.g. reference images used in prompts; always saved at original quality)</label>
              </div>
            </details>

            <details>
              <summary>Upscaling <span class="sum" id="sumUpscale"></span></summary>
              <div class="row">
                <label>Picture size <input type="text" id="imageUpscale" list="fbd-res" size="5"><datalist id="fbd-res"><option value="2K"><option value="4K"><option value="1K"></datalist></label>
                <label>Video size <input type="text" id="videoUpscale" list="fbd-vres" size="5"><datalist id="fbd-vres"><option value="1080p"><option value="4K"></datalist></label>
                <label>Pause between <input type="number" id="upscalePause" min="0" step="1"> s</label>
              </div>
              <div class="row">
                <label>Max per run <input type="number" id="maxUpscales" min="0" step="1" title="0 = no cap"></label>
                <label>Daily cap <input type="number" id="dailyCap" min="0" step="1" title="0 = unknown; otherwise stop before Flow refuses"></label>
              </div>
              <div class="row">
                <label>On the daily limit <select id="onLimit"><option value="stop">stop the run</option><option value="originals">continue with originals</option></select></label>
                <label>and pause upscaling for <input type="number" id="limitPause" min="1" step="1"> h</label>
              </div>
              <div class="row grid">
                <label><input type="checkbox" id="fallbackOriginal"> If an upscale fails, save the original meanwhile (it stays queued for upscaling)</label>
              </div>
              <div class="row"><button class="btn sm" id="resetLimit" title="Forget that the daily limit was hit">Reset limit pause</button></div>
              <div class="note">Upscaled mode drives Flow's own Download menu one picture or video at a time, waits for each file, and watches Flow's messages for "upscale failed" or the daily limit. Two failed upscales in a row, or greyed-out upscale entries, also count as the daily limit. Keep the project open and the tab visible. Items it cannot reach are deferred to the next run. Video upscales take longer, so they get three times the upscale timeout.</div>
            </details>

            <details>
              <summary>Projects <span class="sum" id="sumProjects"></span></summary>
              <div class="row">
                <label><input type="radio" name="scope" value="current" id="scopeCurrent"> This project only</label>
                <label><input type="radio" name="scope" value="selected" id="scopeSelected"> Selected projects</label>
                <button class="btn sm" id="refreshProjects" title="Re-read project links from this page">Refresh list</button>
              </div>
              <div class="projects" id="projects"></div>
              <div class="note">Projects are found from links on the Flow home page and from project pages you visit. You can also paste project URLs or IDs:</div>
              <textarea id="extra" placeholder="https://flow.google.com/project/xxxxxxxx-xxxx-…  (one per line)"></textarea>
            </details>

            <details>
              <summary>Saving &amp; folders <span class="sum" id="sumSaving"></span></summary>
              <div class="row">
                <label>Save with <select id="mode"><option value="browser">Browser download (simple)</option><option value="tampermonkey">Tampermonkey (folders, completion signal)</option></select></label>
              </div>
              <div class="row">
                <label>Base folder <input type="text" id="subfolder" size="14"></label>
                <label><input type="checkbox" id="folderByProject"> Folder per project</label>
                <label><input type="checkbox" id="folderByMonth"> Folder per month</label>
              </div>
              <div class="row">
                <label>File name <select id="namePattern"><option value="date-title-id">date - prompt - id</option><option value="title-date-id">prompt - date - id</option></select></label>
                <label>Prompt sidecar <select id="sidecar"><option value="none">none</option><option value="txt">.txt next to each file</option><option value="json">.json next to each file</option></select></label>
              </div>
              <div class="row grid">
                <label><input type="checkbox" id="manifestPerRun"> CSV manifest after each run</label>
                <label><input type="checkbox" id="poster"> Preview-quality fallback if there is no original</label>
              </div>
              <div class="row">
                <label>Delay between items <input type="number" id="delay" min="0" step="100"> ms</label>
              </div>
              <div class="note">Folders and sidecars need Tampermonkey mode (Tampermonkey → Settings → Downloads: whitelist jpg png webp mp4 txt json csv). In browser mode everything lands flat in your Downloads folder.</div>
            </details>

            <details>
              <summary>Automation <span class="sum" id="sumAuto"></span></summary>
              <div class="row">
                <label>Auto-check every <input type="number" id="auto" min="0" step="1"> min while this tab is open (0 = off)</label>
              </div>
              <div class="row">
                <label>Run on page load if the last run is older than <input type="number" id="runOnLoad" min="0" step="1"> h (0 = off)</label>
              </div>
              <div class="row">
                <label>Auto project (for Upscaled mode) <input type="text" id="autoProject" class="wide" placeholder="project URL or id"></label>
              </div>
              <div class="row grid">
                <label><input type="checkbox" id="notify"> Desktop notifications</label>
              </div>
              <div class="note">For unattended daily runs, schedule Chrome to open Flow each morning (see <code>schedule/Register-FlowTask.ps1</code> in the repo) and set "Run on page load". On the home page the auto project is opened first so Upscaled mode has a grid to work with.</div>
            </details>

            <details>
              <summary>Panel <span class="sum" id="sumPanel"></span></summary>
              <div class="row grid">
                <label><input type="checkbox" id="showFab"> Show the round ⬇ Flow Export button</label>
              </div>
              <div class="note"><b>Alt+Shift+F</b> opens and closes the panel at any time, and Tampermonkey's menu (its icon in Chrome's toolbar) has <b>Open Flow Export</b>. With the button hidden, the small run card still shows during downloads.</div>
            </details>
          </section>

          <section class="pane" data-pane="tools">
            <h4>History</h4>
            <div class="btns">
              <button class="btn" id="markDone" title="Mark everything currently in the selected projects as downloaded, so future runs only pick up new items">Mark all current as done</button>
              <button class="btn" id="clear" title="Forget which files were already downloaded">Clear history</button>
            </div>
            <h4>Export &amp; backup</h4>
            <div class="btns">
              <button class="btn" id="exportCsv">Manifest (CSV)</button>
              <button class="btn" id="exportJson">Manifest (JSON)</button>
              <button class="btn" id="backup" title="Settings and download history">Export backup</button>
              <button class="btn" id="restore">Import backup…</button>
              <input type="file" id="restoreFile" accept=".json,application/json" style="display:none">
            </div>
            <h4>Troubleshooting</h4>
            <div class="btns">
              <button class="btn" id="diag" title="Export a redacted JSON of what Flow returned, for troubleshooting">Diagnose</button>
              <button class="btn" id="credits" title="Ask Flow for your credit balance">Check credits</button>
            </div>
            <details>
              <summary>Learn from my clicks</summary>
              <div class="row grid">
                <label><input type="checkbox" id="learnMode"> Watch Flow's traffic and menus while I download one picture by hand</label>
              </div>
              <div class="learned" id="learnedBox">Nothing learned yet.</div>
              <div class="btns">
                <button class="btn sm" id="refreshLearned">Refresh learned</button>
                <button class="btn sm" id="applyLearned">Apply learned to Advanced</button>
              </div>
            </details>
            <details>
              <summary>Advanced (RPC ids &amp; labels)</summary>
              <div class="row">
                <label>Listing RPC <input type="text" id="rpcListing" size="7"></label>
                <label>Alt listing <input type="text" id="rpcListingAlt" size="7"></label>
              </div>
              <div class="row">
                <label>Media RPC <input type="text" id="rpcMedia" size="7"></label>
                <label>Credits RPC <input type="text" id="rpcCredits" size="7"></label>
              </div>
              <div class="row">
                <label>Upscale RPC ids <input type="text" id="rpcUpscale" class="wide" placeholder="comma-separated"></label>
              </div>
              <div class="row">
                <label>Download menu label <input type="text" id="downloadLabel" size="10"></label>
                <label>Upscale label contains <input type="text" id="upscaleLabel" size="8"></label>
              </div>
              <div class="row">
                <label>Options button label (regex) <input type="text" id="optionsLabel" class="wide"></label>
                <label>Upscale timeout <input type="number" id="upscaleTimeout" min="10" step="10"> s</label>
              </div>
              <div class="note">Google renames these with frontend builds. Use Learn mode to discover the current values, or send a Diagnose file.</div>
            </details>
          </section>
        </div>
      </div>
      <div class="mini" id="mini">
        <div class="miniHead" id="dragMini" title="Drag to move · double-click to put it back in the corner">
          <div class="title">⬇ Flow Export <span class="ver" id="mCount"></span></div>
          <button class="icon" id="expand" title="Open the full panel">⤢</button>
          <button class="btn danger sm" id="mStop">■ Stop</button>
        </div>
        <div class="miniBar"><div class="bar"><div id="mBar"></div></div><span class="pct" id="mPct"></span></div>
        <div class="lines" id="mLines"></div>
      </div>
      <button class="fab on" id="fab" title="Flow Bulk Downloader · drag to move">⬇ Flow Export <span class="badge" id="fabBadge" hidden></span></button>
    `);

    const $ = (id) => root.getElementById(id);
    const panel = $('panel');
    let settings = loadSettings();
    if (!settings.sinceLocal) settings.sinceLocal = msToLocalInput(Date.now() - 7 * 86400000);

    const logEl = $('log');
    const logBox = $('logBox');
    let unseenLog = 0;
    const log = (msg) => {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
      logEl.textContent += (logEl.textContent ? '\n' : '') + line;
      logEl.scrollTop = logEl.scrollHeight;
      if (/^\s*(✘|⏭|⚠|Error)/.test(msg)) logBox.open = true; // problems open the log on their own
      if (!logBox.open) { unseenLog++; $('logBadge').textContent = unseenLog > 99 ? '99+' : String(unseenLog); $('logBadge').hidden = false; }
      try { console.log('[FlowBulk]', msg); } catch (e) { /* ignore */ }
    };
    logBox.addEventListener('toggle', () => { if (logBox.open) { unseenLog = 0; $('logBadge').hidden = true; logEl.scrollTop = logEl.scrollHeight; } });

    const FIELDS = {
      sinceLocal: 'since', untilLocal: 'until', images: 'images', videos: 'videos', includeUndated: 'undated', skipDone: 'skipDone',
      keywordInclude: 'kwInc', keywordExclude: 'kwExc', modelFilter: 'modelFilter', excludeUploads: 'excludeUploads', includeNotInGrid: 'includeNotInGrid',
      imageUpscale: 'imageUpscale', videoUpscale: 'videoUpscale', upscaleLabel: 'upscaleLabel', upscaleTimeoutSec: 'upscaleTimeout', fallbackOriginal: 'fallbackOriginal',
      upscalePauseSec: 'upscalePause', maxUpscalesPerRun: 'maxUpscales', dailyUpscaleCap: 'dailyCap', onLimit: 'onLimit', limitPauseHours: 'limitPause',
      extraProjects: 'extra', downloadMode: 'mode', subfolder: 'subfolder', folderByProject: 'folderByProject', folderByMonth: 'folderByMonth', namePattern: 'namePattern',
      sidecar: 'sidecar', manifestPerRun: 'manifestPerRun', allowPosterFallback: 'poster', delayMs: 'delay',
      autoMinutes: 'auto', runOnLoadHours: 'runOnLoad', autoProjectId: 'autoProject', notify: 'notify', showFab: 'showFab', learnMode: 'learnMode',
      rpcListing: 'rpcListing', rpcListingAlt: 'rpcListingAlt', rpcMedia: 'rpcMedia', rpcCredits: 'rpcCredits', rpcUpscaleIds: 'rpcUpscale', downloadLabel: 'downloadLabel', optionsLabel: 'optionsLabel',
    };
    const NUMERIC = { upscaleTimeoutSec: [10, 120], upscalePauseSec: [0, 8], maxUpscalesPerRun: [0, 0], dailyUpscaleCap: [0, 0], limitPauseHours: [1, 24], delayMs: [0, 400], autoMinutes: [0, 0], runOnLoadHours: [0, 0] };

    function readForm() {
      for (const [key, id] of Object.entries(FIELDS)) {
        const el = $(id);
        if (el.type === 'checkbox') settings[key] = el.checked;
        else if (NUMERIC[key]) { const [min, dflt] = NUMERIC[key]; const v = parseInt(el.value, 10); settings[key] = isNaN(v) ? dflt : Math.max(min, v); }
        else settings[key] = el.value;
      }
      settings.scope = $('scopeSelected').checked ? 'selected' : 'current';
      settings.selectedProjects = Array.from(root.querySelectorAll('.projects input:checked')).map((i) => i.value);
      settings.quality = $('qUpscaled').checked ? 'upscaled' : 'original';
      settings.videoQuality = $('vqUpscaled').checked ? 'upscaled' : 'original';
      settings.imageUpscale = (settings.imageUpscale || '2K').trim() || '2K';
      settings.videoUpscale = (settings.videoUpscale || '1080p').trim() || '1080p';
      settings.upscaleLabel = settings.upscaleLabel || 'Upscal';
      settings.rpcListing = (settings.rpcListing || 'Zzl0ze').trim();
      settings.rpcMedia = (settings.rpcMedia || 'as29s').trim();
      const m = String(settings.autoProjectId || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      settings.autoProjectId = m ? m[0].toLowerCase() : '';
      saveSettings(settings);
      $('download').textContent = 'Download'; // a scan's count no longer applies
      if (excluded.size) $('download').textContent = `Download (${excluded.size} unticked left out)`;
      if (settings.learnMode) installLearnHooks();
      scheduleAuto();
      renderStatus();
      return settings;
    }
    function writeForm() {
      for (const [key, id] of Object.entries(FIELDS)) {
        const el = $(id);
        if (el.type === 'checkbox') el.checked = !!settings[key];
        else el.value = settings[key] == null ? '' : settings[key];
      }
      ($('scope' + (settings.scope === 'selected' ? 'Selected' : 'Current'))).checked = true;
      ($('q' + (settings.quality === 'upscaled' ? 'Upscaled' : 'Original'))).checked = true;
      ($('vq' + (settings.videoQuality === 'upscaled' ? 'Upscaled' : 'Original'))).checked = true;
      renderProjects(); renderLearned(); renderStatus();
    }
    let locked = false; // settings are locked while a run goes
    function renderProjects() {
      const projects = discoverProjectsFromDom();
      const el = $('projects');
      const list = Object.values(projects).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      if (!list.length) { setHTML(el, '<span class="muted">No projects discovered yet. Visit the Flow home page, then click "Refresh list".</span>'); return; }
      const sel = new Set((settings.selectedProjects || []).map((s) => s.toLowerCase()));
      setHTML(el, list.map((p) => `<label><input type="checkbox" value="${p.id}" ${sel.has(p.id) ? 'checked' : ''}${locked ? ' disabled' : ''}> <span>${escapeHtml(p.title || '(untitled)')} <span class="muted">${p.id.slice(0, 8)}</span></span></label>`).join(''));
    }
    let creditsText = '';
    function chip(text, kind) {
      const el = document.createElement('span');
      el.className = 'chip' + (kind ? ' ' + kind : '');
      el.textContent = el.title = text;
      return el;
    }
    function renderStatus() {
      const wiz = getWiz();
      const cur = currentProjectId();
      const up = anyUpscale(settings);
      const doneN = Object.keys(loadDone()).length;
      const lastRun = store.get('fbd.lastRun', null);
      const chips = [
        wiz.at ? chip('● Signed in', 'ok') : chip('○ Not signed in (or still loading)', 'warn'),
        cur ? chip(`Project: ${projectTitleFor(cur) || cur.slice(0, 8)}`) : chip('No project open', up ? 'warn' : ''),
        chip(`${doneN.toLocaleString()} in history`),
      ];
      if (up) chips.push(chip(`Upscales 24 h: ${upscalesLast24h()}${settings.dailyUpscaleCap > 0 ? ` / ${settings.dailyUpscaleCap}` : ''}`));
      if (creditsText) chips.push(chip(creditsText));
      if (lastRun) chips.push(chip(`Last run ${fmtHuman(lastRun)}`));
      $('status').replaceChildren(...chips);
      const limitAt = store.get('fbd.upscaleLimitAt', 0);
      const pauseMs = Math.max(1, settings.limitPauseHours || 24) * 3600000;
      const warn = $('statusWarn');
      warn.hidden = !(limitAt && Date.now() - limitAt < pauseMs);
      if (!warn.hidden) warn.textContent = `⏸ Flow's upscale limit was hit ${fmtHuman(limitAt)}. Upscaling is paused until ${fmtHuman(limitAt + pauseMs)} (Options → Upscaling → Reset limit pause).`;
      renderSummaries();
    }
    function renderSummaries() {
      $('qUpLabel').textContent = `Upscaled ${settings.imageUpscale || '2K'}`;
      $('vqUpLabel').textContent = `Upscaled ${settings.videoUpscale || '1080p'}`;
      $('qPicRow').hidden = !settings.images;
      $('qVidRow').hidden = !settings.videos;
      const secs = (key, dflt) => Math.round((store.get(key, 0) || dflt) / 1000 + (settings.upscalePauseSec || 0));
      const upPics = settings.images && settings.quality === 'upscaled', upVids = settings.videos && settings.videoQuality === 'upscaled';
      const each = [upPics && `about ${secs(AVG_UP_KEY, 12000)} s per picture`, upVids && `about ${secs(AVG_UP_VIDEO_KEY, 45000)} s per video`].filter(Boolean).join(', ');
      $('qualityHint').textContent = upPics || upVids
        ? `Flow upscales each ${upPics && upVids ? 'picture and video' : upPics ? 'picture' : 'video'} one at a time (${each}). Keep this project open and the tab visible; the run pauses while the tab is hidden.`
        : 'Saves the files Flow already stores, straight away.';
      const f = [];
      if (settings.includeUndated) f.push('undated included');
      if (settings.keywordInclude) f.push(`prompt has "${settings.keywordInclude}"`);
      if (settings.keywordExclude) f.push(`not "${settings.keywordExclude}"`);
      if (settings.modelFilter) f.push(`model "${settings.modelFilter}"`);
      if (settings.excludeUploads) f.push('no uploads');
      if (settings.includeNotInGrid) f.push('hidden pictures included');
      $('sumFilters').textContent = f.join(' · ') || 'none';
      $('sumUpscale').textContent = `${settings.imageUpscale || '2K'} pictures, ${settings.videoUpscale || '1080p'} videos, ${settings.upscalePauseSec || 0} s apart` +
        (settings.maxUpscalesPerRun > 0 ? `, ${settings.maxUpscalesPerRun} per run` : '') + (settings.dailyUpscaleCap > 0 ? `, ${settings.dailyUpscaleCap} per day` : '');
      $('sumProjects').textContent = settings.scope === 'selected' ? `${(settings.selectedProjects || []).length} selected` : 'this project only';
      $('sumSaving').textContent = settings.downloadMode === 'tampermonkey' ? `Downloads/${settings.subfolder || ''}${settings.folderByProject ? '/project' : ''}${settings.folderByMonth ? '/month' : ''}` : 'Downloads folder, no subfolders';
      const a = [];
      if (settings.autoMinutes > 0) a.push(`every ${settings.autoMinutes} min`);
      if (settings.runOnLoadHours > 0) a.push(`on load after ${settings.runOnLoadHours} h`);
      $('sumAuto').textContent = a.join(' · ') || 'off';
      $('sumPanel').textContent = settings.showFab === false ? 'button hidden · Alt+Shift+F' : 'button shown · Alt+Shift+F';
    }
    function renderLearned() {
      const l = loadLearned();
      const keys = Object.keys(l).filter((k) => k !== 'at');
      $('learnedBox').textContent = keys.length ? keys.map((k) => `${k}: ${Array.isArray(l[k]) ? l[k].join(', ') : l[k]}`).join('\n') + (l.at ? `\n(observed ${fmtHuman(l.at)})` : '') : (settings.learnMode ? 'Learning… open a project, hover a picture, open its menu and download it once by hand, then click "Refresh learned".' : 'Nothing learned yet. Turn on "Learn from my clicks" first.');
    }
    // Items unticked in the list after a Scan; the next Download or Test leaves them out.
    // They are not marked as done, so they show up again in the next scan.
    const excluded = new Set();
    let listed = [];
    const PICK_MAX = 5000;
    function renderItems(items, pickable) {
      const el = $('items');
      listed = items;
      el.classList.toggle('picking', !!pickable);
      if (!items.length) { $('itemsHead').textContent = 'Matching items (0)'; setHTML(el, '<span class="muted">No matching items.</span>'); return; }
      const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
      const kids = [];
      if (pickable) {
        const bar = mk('div', 'pickBar');
        for (const [id, t] of [['pickAll', 'Tick all'], ['pickNone', 'Untick all']]) { const b = mk('button', 'link', t); b.id = id; b.type = 'button'; bar.append(b); }
        bar.append(mk('span', 'muted', 'Untick what you don\'t want; Shift-click ticks or unticks a range.'));
        kids.push(bar);
      }
      items.slice(0, PICK_MAX).forEach((i, n) => {
        const row = mk(pickable ? 'label' : 'div', 'pick');
        if (pickable) {
          const cb = mk('input'); cb.type = 'checkbox'; cb.dataset.n = n; cb.checked = !excluded.has(i.mediaId); cb.disabled = locked;
          row.classList.toggle('off', !cb.checked);
          row.append(cb);
        }
        const src = thumbUrl(i);
        if (src) { const img = mk('img'); img.loading = 'lazy'; img.alt = ''; img.onerror = () => img.replaceWith(mk('span', 'noimg')); img.src = src; row.append(img); } else row.append(mk('span', 'noimg'));
        const txt = mk('span', '', `${fmtHuman(i.createdMs)} · ${i.kind}${i.model ? ' · ' + i.model : ''} · ${i.title || '(untitled)'} `);
        txt.append(mk('span', 'muted', `${i.mediaId.slice(0, 8)}${i.createdSource === 'guess' ? ' · date≈' : ''}${i.inGrid === false ? ' · not in the grid' : ''}`));
        row.append(txt);
        kids.push(row);
      });
      if (items.length > PICK_MAX) kids.push(mk('div', 'muted', `…and ${items.length - PICK_MAX} more${pickable ? ' (always included)' : ''}`));
      el.replaceChildren(...kids);
      renderPickCount(pickable);
    }
    function renderPickCount(pickable) {
      const n = listed.length, on = n - listed.filter((i) => excluded.has(i.mediaId)).length;
      $('itemsHead').textContent = pickable && on < n ? `Matching items (${on} of ${n} ticked)` : `Matching items (${n})`;
      if (pickable) $('download').textContent = on ? `Download ${on}` : 'Download';
    }
    let lastPick = -1;
    $('items').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (b && (b.id === 'pickAll' || b.id === 'pickNone')) {
        const on = b.id === 'pickAll';
        for (const i of listed) { if (on) excluded.delete(i.mediaId); else excluded.add(i.mediaId); }
        for (const cb of $('items').querySelectorAll('input[type=checkbox]')) { cb.checked = on; cb.closest('.pick').classList.toggle('off', !on); }
        renderPickCount(true);
        return;
      }
      const cb = ev.target.closest('input[type=checkbox]');
      if (!cb) return;
      const n = +cb.dataset.n, on = cb.checked;
      const from = ev.shiftKey && lastPick >= 0 ? Math.min(lastPick, n) : n, to = ev.shiftKey && lastPick >= 0 ? Math.max(lastPick, n) : n;
      const boxes = $('items').querySelectorAll('input[type=checkbox]');
      for (let k = from; k <= to; k++) {
        const it = listed[k], box = boxes[k];
        if (!it || !box) continue;
        box.checked = on; box.closest('.pick').classList.toggle('off', !on);
        if (on) excluded.delete(it.mediaId); else excluded.add(it.mediaId);
      }
      lastPick = n;
      renderPickCount(true);
    });
    let prog = null, act = null, actTimer = null, runStartAt = 0;
    function setLines(el, lines) {
      el.replaceChildren(...lines.map(([cls, text]) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }));
    }
    function setBar(frac) {
      const pct = frac == null ? '' : `${Math.round(frac * 100)}%`;
      $('barfill').style.width = $('mBar').style.width = pct || '0%';
      $('pPct').textContent = $('mPct').textContent = pct;
    }
    function renderProgress() {
      const full = [], mini = [];
      let count = '';
      if (prog && prog.item) {
        count = `${prog.i + 1} / ${prog.n}`;
        const what = `${prog.item.kind === 'video' ? 'Video' : 'Picture'} · ${prog.item.title || prog.item.mediaId.slice(0, 8)}`;
        full.push(['item', what]); mini.push(['item', what]);
      } else if (prog && prog.text) {
        full.push(['msg', prog.text]); mini.push(['msg', prog.text.split('\n')[0]]);
      } else {
        full.push(['msg', 'Ready. Scan lists what would be downloaded without saving anything; Download starts saving.']);
      }
      if (act) {
        const now = Date.now();
        const t = act.until ? ` ${Math.max(0, Math.ceil((act.until - now) / 1000))} s left` : (now - act.at >= 2000 ? ` ${Math.floor((now - act.at) / 1000)} s` : '');
        full.push(['step', `→ ${act.text}${t}`]); mini.push(['step', `→ ${act.text}${t}`]);
      }
      let eta = '', each = '';
      if (prog && prog.item && prog.n - prog.i > 1) {
        const d = fmtDuration(prog.perMs * (prog.n - prog.i) - (Date.now() - prog.at));
        eta = `${d === 'under a minute' ? 'Less than a minute' : 'About ' + d} left`;
        each = ` (≈${Math.round(prog.perMs / 1000)} s each)`;
      }
      const c = prog && prog.counts;
      const tally = c && (c.ok || c.fail || c.deferred) ? `✔ ${c.ok} saved${c.fail ? ` · ✘ ${c.fail} failed` : ''}${c.deferred ? ` · ⏭ ${c.deferred} deferred` : ''}` : '';
      if (eta || tally) {
        full.push(['eta', [eta && eta + each, tally].filter(Boolean).join(' · ')]);
        mini.push(['eta', [eta, tally].filter(Boolean).join(' · ')]);
      }
      setLines($('progress'), full); setLines($('mLines'), mini);
      $('card').classList.toggle('idle', !count && !$('pPct').textContent); // no bar for idle or scan text
      $('pCount').textContent = $('mCount').textContent = count;
      $('pCount').hidden = !count;
    }
    activity = (text, opts) => {
      act = text ? { text, at: Date.now(), until: opts && opts.untilMs ? Date.now() + opts.untilMs : 0 } : null;
      if (act && !actTimer) actTimer = setInterval(renderProgress, 1000);
      if (!act && actTimer) { clearInterval(actTimer); actTimer = null; }
      renderProgress();
    };
    function progress(i, n, item, counts) {
      setBar(n ? i / n : 0);
      if (i === 0 || !runStartAt) runStartAt = Date.now();
      const perMs = i > 0 ? (Date.now() - runStartAt) / i : estimateRunMs([item], settings, store.get(AVG_UP_KEY, 0), store.get(AVG_UP_VIDEO_KEY, 0));
      prog = item ? { i, n, item, perMs, at: Date.now(), counts } : null;
      renderProgress();
    }
    function finish(text, frac) {
      if (frac != null) setBar(frac);
      prog = { text }; runStartAt = 0;
      const m = /(\d+) saved, (\d+) failed/.exec(text);
      $('fabBadge').textContent = m ? `✔ ${m[1]}${m[2] !== '0' ? ` ✘ ${m[2]}` : ''}` : '!';
      $('fab').title = text;
      activity(null);
    }

    // Views: the round button, the full panel, or (during a run) a short card that sits
    // below Chrome's download pop-up, which covers the top-right of the page.
    const POS_KEY = 'fbd.uiPos';
    let view = 'closed', viewBeforeRun = 'open', compactRun = false;
    let pos = store.get(POS_KEY, null) || { right: 16, bottom: 16 };
    function fitToViewport(dragging) {
      const w = host.offsetWidth || 160, h = host.offsetHeight || 48;
      // Only a drag changes the saved spot; a wider view (the panel opened from a button dragged
      // to the left edge) is shifted to fit without moving the button.
      if (dragging) {
        pos.right = Math.max(0, Math.min(pos.right, innerWidth - w));
        pos.bottom = Math.max(0, Math.min(pos.bottom, innerHeight - h));
      }
      host.style.right = `${Math.max(0, Math.min(pos.right, innerWidth - w))}px`;
      host.style.bottom = `${Math.max(0, Math.min(pos.bottom, innerHeight - h - 8))}px`;
    }
    function setView(v) {
      view = v;
      panel.classList.toggle('on', v === 'open');
      $('mini').classList.toggle('on', v === 'mini');
      $('fab').classList.toggle('on', v === 'closed' && settings.showFab !== false);
      if (v === 'open') { $('fabBadge').hidden = true; renderProjects(); renderLearned(); renderStatus(); }
      fitToViewport();
    }
    /** isButton: the handle is itself a button (the round one), so a press that moves a few
     *  pixels is a drag and the click that follows it is ignored. */
    let dragEndedAt = 0;
    function makeDraggable(handle, isButton) {
      handle.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 || (!isButton && ev.target.closest('button'))) return;
        const r0 = host.getBoundingClientRect();
        const sx = ev.clientX, sy = ev.clientY, right0 = innerWidth - r0.right, bottom0 = innerHeight - r0.bottom;
        let moved = false;
        handle.setPointerCapture(ev.pointerId);
        const move = (e) => {
          if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
          moved = true;
          pos = { right: right0 - (e.clientX - sx), bottom: bottom0 - (e.clientY - sy) }; fitToViewport(true);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
          if (moved) { store.set(POS_KEY, pos); dragEndedAt = Date.now(); }
        };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
      });
      if (isButton) return; // a double-click on the round button would open the panel twice
      handle.addEventListener('dblclick', (ev) => {
        if (ev.target.closest('button')) return;
        pos = { right: 16, bottom: 16 }; store.set(POS_KEY, pos); fitToViewport();
      });
    }
    makeDraggable($('dragPanel')); makeDraggable($('dragMini')); makeDraggable($('fab'), true);
    window.addEventListener('resize', () => fitToViewport());

    function showTab(name) {
      if (!root.querySelector(`.pane[data-pane="${name}"]`)) name = 'main';
      for (const t of root.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.tab === name);
      for (const p of root.querySelectorAll('.pane')) p.classList.toggle('on', p.dataset.pane === name);
      store.set('fbd.tab', name);
    }
    for (const t of root.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
    showTab(store.get('fbd.tab', 'main'));
    renderProgress();

    /** compact: shrink to the run card while this run goes (downloads, not scans). */
    function setRunning(on, compact) {
      for (const id of ['scan', 'download', 'test1', 'markDone']) $(id).disabled = on;
      // Lock the settings too: the run uses what was set when it started, and buttons such as
      // Backup save the form, so a change made mid-run could apply partway through.
      locked = on;
      for (const el of root.querySelectorAll('.pane input, .pane select, .pane textarea')) el.disabled = on;
      for (const id of ['refreshProjects', 'resetLimit', 'refreshLearned', 'applyLearned', 'restore', 'clear']) $(id).disabled = on;
      $('lockNote').hidden = !on;
      $('stop').disabled = $('mStop').disabled = !on;
      $('stop').hidden = !on; $('download').hidden = on;
      if (on) { prog = { text: 'Starting…' }; setBar(0); renderProgress(); }
      if (on && compact) {
        compactRun = true; viewBeforeRun = view;
        showTab('main'); setView('mini');
      } else if (!on && compactRun) {
        compactRun = false;
        if (view === 'mini') setView(viewBeforeRun === 'closed' ? 'closed' : 'open');
        if (view === 'closed') $('fabBadge').hidden = false;
      }
      $('minimize').hidden = !(on && compactRun);
      renderStatus();
    }
    const ui = { log, renderItems, progress, setRunning, finish };
    function requestStop() { stopFlag = true; log('Stopping after the current file…'); activity('Stopping after the current file…'); }

    $('fab').addEventListener('click', () => {
      if (Date.now() - dragEndedAt < 400) return; // the end of a drag, not a click
      setView(running && compactRun ? 'mini' : 'open');
    });
    $('close').addEventListener('click', () => setView(running && compactRun ? 'mini' : 'closed'));
    $('minimize').addEventListener('click', () => setView('mini'));
    $('showFab').addEventListener('change', () => setView(view));
    function togglePanel() { setView(view === 'open' ? (running && compactRun ? 'mini' : 'closed') : 'open'); }
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyF') { e.preventDefault(); e.stopPropagation(); togglePanel(); }
    }, true);
    try { if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Open Flow Export', () => setView('open')); } catch (e) { /* ignore */ }
    $('expand').addEventListener('click', () => setView('open'));
    $('mStop').addEventListener('click', requestStop);
    $('popupTip').hidden = !!store.get('fbd.hidePopupTip', false);
    $('tipHide').addEventListener('click', () => { store.set('fbd.hidePopupTip', true); $('popupTip').hidden = true; });
    $('copyLog').addEventListener('click', (ev) => {
      ev.preventDefault(); // the button sits in the log's summary; do not fold it
      const btn = ev.currentTarget;
      const done = (t) => { btn.textContent = t; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); };
      try { navigator.clipboard.writeText(logEl.textContent).then(() => done('Copied'), () => done('Copy failed')); } catch (e) { done('Copy failed'); }
    });
    $('refreshProjects').addEventListener('click', () => { readForm(); renderProjects(); log('Project list refreshed from this page.'); });
    for (const id of Object.values(FIELDS).concat(['scopeCurrent', 'scopeSelected', 'qOriginal', 'qUpscaled', 'vqOriginal', 'vqUpscaled'])) $(id).addEventListener('change', readForm);
    $('projects').addEventListener('change', readForm);

    $('scan').addEventListener('click', async () => {
      if (running) return;
      readForm(); running = true; stopFlag = false; setRunning(true);
      try {
        const s = await scan(settings, log);
        const f = filterItems(s.items, settings);
        log(`Would download ${f.keep.length} item(s). Skipped: ${skipSummary(f)}.`);
        const est = f.keep.length ? ` (≈${fmtDuration(estimateRunMs(f.keep, settings, store.get(AVG_UP_KEY, 0), store.get(AVG_UP_VIDEO_KEY, 0)))} at the current pacing)` : '';
        setBar(null);
        finish(`Scan done, nothing downloaded:\n${describeMatches(f.keep, settings)}${est}.\n${skipSummaryShort(f).replace(/^s/, 'S')}.${f.keep.length ? '\n↓ The matching items are listed below.' : ''}`);
        excluded.clear(); lastPick = -1;
        renderItems(f.keep, true);
        $('itemsBox').open = f.keep.length > 0;
        try { $('itemsBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ }
      } catch (e) { log(`Error: ${e.message}`); finish(`Error: ${e.message}`); }
      finally { running = false; setRunning(false); }
    });
    // A run lists what it works on (without checkboxes), so the picks apply to this one run.
    const takePicks = () => { const ex = new Set(excluded); excluded.clear(); return ex; };
    $('download').addEventListener('click', () => { readForm(); const exclude = takePicks(); setRunning(true, true); runDownload(settings, ui, { exclude }); });
    $('test1').addEventListener('click', () => { readForm(); const exclude = takePicks(); setRunning(true, true); runDownload(settings, ui, { limit: 1, exclude }); });
    $('stop').addEventListener('click', requestStop);
    $('resetLimit').addEventListener('click', () => { store.set('fbd.upscaleLimitAt', 0); renderStatus(); log('Upscale limit pause reset.'); });
    $('refreshLearned').addEventListener('click', () => { if (!settings.learnMode) { log('Turn on "Learn from my clicks" first.'); return; } learnedNow(); renderLearned(); log('Learned values refreshed from what the page did since Learn mode was enabled.'); });
    $('applyLearned').addEventListener('click', () => {
      const l = loadLearned();
      const map = { rpcListing: 'rpcListing', rpcMedia: 'rpcMedia', rpcCredits: 'rpcCredits', downloadLabel: 'downloadLabel', upscaleLabel: 'upscaleLabel', imageUpscale: 'imageUpscale', optionsLabel: 'optionsLabel' };
      let n = 0;
      for (const [k, sk] of Object.entries(map)) if (l[k]) { settings[sk] = String(l[k]); n++; }
      if (Array.isArray(l.rpcUpscaleIds) && l.rpcUpscaleIds.length) { settings.rpcUpscaleIds = uniq(String(settings.rpcUpscaleIds || '').split(',').map((s) => s.trim()).filter(Boolean).concat(l.rpcUpscaleIds)).join(','); n++; }
      if (l.optionsLabel) settings.optionsLabel = escapeRe(l.optionsLabel);
      saveSettings(settings); writeForm();
      log(n ? `Applied ${n} learned value(s) to Advanced. Run "Test 1 picture" to verify.` : 'Nothing learned to apply yet.');
    });
    $('credits').addEventListener('click', async () => {
      readForm();
      try { const c = await fetchCredits(settings); creditsText = c.credits != null ? `credits: ${c.credits}${c.tier ? ' (' + c.tier + ')' : ''}` : 'credits: n/a'; renderStatus(); log(c.credits != null ? `Flow credits: ${c.credits}${c.tier ? ' · plan: ' + c.tier : ''}` : `Credits call answered, but the shape was unexpected: ${JSON.stringify(c.raw).slice(0, 200)}`); }
      catch (e) { log(`Credits lookup failed: ${e.message}`); }
    });
    $('diag').addEventListener('click', () => {
      readForm();
      saveViaAnchor(new Blob([JSON.stringify(buildDiagnostics(settings), null, 2)], { type: 'application/json' }), `flow-bulk-diagnose-${fmtStamp(Date.now())}.json`);
      log('Diagnostics JSON saved (signed URLs and tokens are redacted). Scan first to include response samples.');
    });
    $('exportCsv').addEventListener('click', () => { const m = loadManifest(); if (!m.length) { log('Manifest is empty.'); return; } saveViaAnchor(new Blob([toCsv(m, MANIFEST_COLUMNS)], { type: 'text/csv;charset=utf-8' }), `flow-manifest-full-${fmtStamp(Date.now())}.csv`); log(`Exported ${m.length} manifest row(s) as CSV.`); });
    $('exportJson').addEventListener('click', () => { const m = loadManifest(); if (!m.length) { log('Manifest is empty.'); return; } saveViaAnchor(new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' }), `flow-manifest-full-${fmtStamp(Date.now())}.json`); log(`Exported ${m.length} manifest row(s) as JSON.`); });
    $('backup').addEventListener('click', () => { readForm(); saveViaAnchor(new Blob([JSON.stringify(buildBackup(settings), null, 2)], { type: 'application/json' }), `flow-bulk-backup-${fmtStamp(Date.now())}.json`); log('Backup saved (settings, download history, projects, manifest, learned values).'); });
    $('restore').addEventListener('click', () => $('restoreFile').click());
    $('restoreFile').addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0]; ev.target.value = '';
      if (!file) return;
      try {
        const b = JSON.parse(await file.text());
        const n = b.done ? Object.keys(b.done).length : 0;
        if (!confirm(`Import backup from ${b.exportedAt || 'unknown date'}?\nSettings will be replaced; ${n} history entries and ${Array.isArray(b.manifest) ? b.manifest.length : 0} manifest rows will be merged.`)) return;
        restoreBackup(b); settings = loadSettings(); writeForm(); log('Backup imported.');
      } catch (e) { log(`Import failed: ${e.message}`); }
    });
    $('markDone').addEventListener('click', async () => {
      if (running) return;
      readForm();
      if (!confirm('Mark everything currently in the selected project(s) as already downloaded? Nothing is downloaded; future runs will only pick up newer items.')) return;
      running = true; stopFlag = false; setRunning(true);
      try { await markAllDone(settings, log); } catch (e) { log(`Error: ${e.message}`); }
      finally { running = false; setRunning(false); }
    });
    $('clear').addEventListener('click', () => {
      if (!confirm('Forget the list of already-downloaded files? Files on disk are not touched.')) return;
      saveDone({}); renderStatus(); log('Download history cleared.');
    });

    // Auto-check timer
    let autoTimer = null;
    function scheduleAuto() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      if (settings.autoMinutes > 0) {
        autoTimer = setInterval(() => {
          if (running) return;
          if (!getWiz().at) { log('Auto-check skipped: no session token (signed out?).'); return; }
          log(`Auto-check (every ${settings.autoMinutes} min)…`);
          setRunning(true, true); runDownload(settings, ui);
        }, settings.autoMinutes * 60000);
      }
    }

    writeForm();
    scheduleAuto();
    if (settings.learnMode) installLearnHooks();
    if (settings.autoMinutes > 0) log(`Auto-check armed: every ${settings.autoMinutes} min while this tab stays open.`);

    // Run on page load (for scheduled, unattended pulls)
    (function maybeRunOnLoad() {
      if (!(settings.runOnLoadHours > 0) || onLabs) return;
      const last = store.get('fbd.lastRun', 0) || 0;
      if (Date.now() - last < settings.runOnLoadHours * 3600000) return;
      const needProject = anyUpscale(settings) && !currentProjectId();
      if (needProject) {
        const target = settings.autoProjectId || (settings.selectedProjects || [])[0];
        const lastNav = store.get('fbd.autoNavAt', 0) || 0;
        if (target && Date.now() - lastNav > 10 * 60000) {
          store.set('fbd.autoNavAt', Date.now());
          log(`Run on load: opening project ${target.slice(0, 8)} for Upscaled mode…`);
          setTimeout(() => { location.assign(`${location.origin}/project/${target}`); }, 1500);
          return;
        }
        log('Run on load: Upscaled mode needs a project page; set an Auto project in Automation.');
        return;
      }
      setView('open');
      log(`Run on load: last run ${last ? fmtHuman(last) : 'never'} — starting in 8 s (press Stop to cancel)…`);
      let cancelled = false;
      const onStop = () => { cancelled = true; log('Run on load cancelled.'); setRunning(false); };
      $('stop').disabled = false; $('stop').hidden = false; $('download').hidden = true; $('stop').addEventListener('click', onStop, { once: true });
      setTimeout(async () => {
        $('stop').removeEventListener('click', onStop);
        if (cancelled || running) return;
        await waitUntil(() => getWiz().at, 20000, 500);
        if (!getWiz().at) { log('Run on load: no session token; skipping.'); setRunning(false); return; }
        setRunning(true, true); runDownload(settings, ui);
      }, 8000);
    })();

    // Keep the project list fresh as the SPA navigates.
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) { lastPath = location.pathname; discoverProjectsFromDom(); if (view === 'open') { renderProjects(); renderStatus(); } }
    }, 1500);
    setTimeout(discoverProjectsFromDom, 4000);
  }

  // Mount the panel; never fail silently, and re-mount if the page ever removes it.
  let mountErrors = 0;
  function safeMount() {
    if (document.getElementById('fbd-host')) return;
    try { mountUI(); }
    catch (e) {
      mountErrors++;
      const host = document.getElementById('fbd-host'); if (host) host.remove();
      console.error('[Flow Bulk Downloader] could not build its panel:', e);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeMount);
  else safeMount();
  setInterval(() => { if (mountErrors < 3) safeMount(); }, 3000);
})();
