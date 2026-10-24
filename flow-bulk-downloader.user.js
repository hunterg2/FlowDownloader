// ==UserScript==
// @name         Flow Bulk Downloader
// @namespace    https://github.com/hunterg2/FlowDownloader
// @version      0.3.4
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
  tile in the project grid, opens the tile's Download menu and picks the
  upscaled entry. Flow performs the upscale and the download; the script paces
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
  const VERSION = '0.3.0';

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

  const helpers = {
    isUuid, epochMs, tsPairMs, guessCreatedMs, parseBatchResponse, extractItems, readAssetEntry, readRecord,
    pickContentUrl, buildFileName, buildRelPath, safeName, extFromMime, sniffExt, collectUrls, splitUrls, redact, scanJsonEnd,
    detectModel, compileTerms, matchesKeywords, csvEscape, toCsv, countSince, inferLearned, fmtMonth,
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
    quality: 'original', imageUpscale: '2K', upscaleLabel: 'Upscal', fallbackOriginal: true, upscaleTimeoutSec: 120,
    upscalePauseSec: 8, maxUpscalesPerRun: 0, dailyUpscaleCap: 0, onLimit: 'stop', limitPauseHours: 24,
    // projects
    scope: 'current', selectedProjects: [], extraProjects: '',
    // saving
    downloadMode: 'browser', subfolder: 'Flow Export', folderByProject: true, folderByMonth: false, namePattern: 'date-title-id',
    sidecar: 'none', manifestPerRun: true, allowPosterFallback: false, delayMs: 400,
    // automation
    autoMinutes: 0, runOnLoadHours: 0, autoProjectId: '', notify: true,
    // learn / advanced
    learnMode: false, rpcListing: 'Zzl0ze', rpcListingAlt: 'ngNC2', rpcMedia: 'as29s', rpcCredits: 'nzlxg',
    rpcUpscaleIds: 'SPrCad,p0UkFb', downloadLabel: 'Download', optionsLabel: 'option|more|menu|opcion|más|mehr|plus|autres|altro|mais',
  };

  function doneKey(mediaId, upscaled) { return upscaled ? `${mediaId}|up` : mediaId; }
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
  async function pacedSleep(ms) { const end = Date.now() + ms; while (Date.now() < end && !stopFlag) await sleep(Math.min(250, end - Date.now())); }

  // Flow only draws its grid while the tab is visible and Chrome throttles hidden tabs, so an
  // upscaled run waits for the tab to come back instead of deferring every picture.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hiddenAt = Date.now(); });
  const tabHidden = () => document.visibilityState === 'hidden';
  async function waitForVisibleTab(log) {
    if (!tabHidden() || stopFlag) return;
    log('⏸ Paused: the Flow tab is hidden. Switch back to it and the run carries on.');
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
  class UpscaleLimitError extends Error { constructor(toast) { super(`Flow reports the upscale limit: "${toast}"`); this.limit = true; this.toast = toast; } }
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
  async function findTile(item) {
    let tile = findTileNow(item);
    if (tile) return tile;
    const anyTile = document.querySelector('img[src*="/asb/"]') || document.querySelector(TILE_SELECTOR);
    if (!anyTile) throw new UpscaleDeferError('no project grid is visible in this tab (open the project and keep the tab in the foreground)', true);
    const sc = scrollContainerOf(anyTile);
    const startTop = sc.scrollTop;
    const nudge = () => { try { sc.dispatchEvent(new PAGE.Event('scroll', { bubbles: false })); } catch (e) { /* ignore */ } };
    sc.scrollTop = 0; nudge(); await sleep(350);
    let lastTop = -1, stalls = 0;
    for (let i = 0; i < 400; i++) {
      tile = findTileNow(item);
      if (tile) return tile;
      sc.scrollTop += Math.max(200, sc.clientHeight * 0.7);
      nudge();
      await sleep(300);
      if (Math.abs(sc.scrollTop - lastTop) < 2) { if (++stalls >= 3) break; } else stalls = 0;
      lastTop = sc.scrollTop;
    }
    sc.scrollTop = startTop; nudge();
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
  function pickResolutionItem(items, settings) {
    const wantRes = String(settings.imageUpscale || '2K');
    const labelRe = new RegExp(escapeRe(settings.upscaleLabel || 'upscal'), 'i');
    const isDisabled = (el) => !!el.disabled || el.getAttribute('aria-disabled') === 'true';
    const notGif = items.filter((el) => !/gif/i.test(textOf(el)) && !isDisabled(el)); // e.g. 4K locked behind "Upgrade"
    const up = notGif.filter((el) => labelRe.test(textOf(el)));
    const resRe = new RegExp(wantRes.replace(/\s+/g, '').replace(/(\d)([kp])$/i, '$1\\s*$2'), 'i');
    return up.find((el) => resRe.test(textOf(el))) || up.slice().sort((a, b) => resRank(textOf(b)) - resRank(textOf(a)))[0] || null;
  }
  function armDownloadCapture() {
    const W = PAGE;
    const state = { blob: null, blobUrl: null, anchor: null, waiters: [] };
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
        } catch (e) { /* ignore */ }
        return origClick.apply(this, arguments);
      };
    } catch (e) { origClick = null; }
    return {
      canSuppress: !!origClick, state,
      wait(ms) {
        return new Promise((res) => {
          if (state.anchor) return res(state);
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

  async function uiDownloadUpscaled(item, settings) {
    if (!currentProjectId()) throw new UpscaleDeferError('upscaled mode needs a project page open in this tab', true);
    if (item.projectId && item.projectId.toLowerCase() !== currentProjectId()) throw new UpscaleDeferError('belongs to another project; only the open project\'s grid can be driven');
    const tile = await findTile(item);
    if (!tile) throw new UpscaleDeferError('tile not found in the grid (grid not fully loaded, or thumbnail did not match)');
    try { tile.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
    await sleep(250);
    hoverEl(tile);
    const img = tile.querySelector('img'); if (img) hoverEl(img);
    const btn = await waitUntil(() => optionsButtonIn(tile, settings), 2500);
    if (!btn) throw new UpscaleDeferError('no options button appeared on the tile after hover');
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
        const chosen = pickResolutionItem(sub, settings);
        if (!chosen) { pressEscape(); throw new Error('no upscaled entry found in: ' + lastMenuTexts.join(' | ')); }
        chosenText = textOf(chosen); upscaled = true;
        hoverEl(chosen); clickEl(chosen);
      }
      const timeoutMs = Math.max(10, settings.upscaleTimeoutSec || 120) * 1000;
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
        if (st.anchor || st.blob) { signal = 'file'; break; }
        if (upscaleCallsSince(t0, settings).length) { signal = 'rpc'; await capture.wait(5000); checkToasts(); break; }
      }
      pressEscape();
      if (!signal) throw new UpscaleDeferError(`no completion signal within ${timeoutMs / 1000}s after choosing "${chosenText}" (Flow may still be working; the picture stays queued)`);
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
        return { name, path: saved.path, bytes: blob.size, how: saved.how, viaPoster: false, upscaled, qualityLabel };
      }
      await pacedSleep(Math.min(15000, 1500 + (st.blob ? st.blob.size / 2e6 * 1000 : 3000)));
      return { name: `${chosenText} — saved by Flow under its own filename`, path: '', bytes: st.blob ? st.blob.size : 0, how: 'flow-ui', viaPoster: false, upscaled, qualityLabel, flowNamed: true };
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
        const wantUp = settings.quality === 'upscaled' && kind === 'image';
        const orig = done[doneKey(it.mediaId, false)];
        if (done[doneKey(it.mediaId, wantUp)] || (wantUp && orig && orig.upscaleFailed)) { out.skippedDone++; continue; }
      }
      out.keep.push(it);
    }
    out.keep.sort((a, b) => (a.createdMs || 0) - (b.createdMs || 0));
    return out;
  }
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
      if (opts.limit) keep = keep.slice(-opts.limit); // newest first for a test run
      log(`${opts.limit ? 'TEST RUN — ' : ''}Matched ${f.keep.length} item(s)${opts.limit ? `, processing ${keep.length}` : ''}. Skipped: ${skipSummary(f)}.`);
      ui.renderItems(keep);
      if (!keep.length) return;
      const upMode = settings.quality === 'upscaled';
      let upAllowed = upMode;
      const limitPauseMs = Math.max(1, settings.limitPauseHours || 24) * 3600000;
      if (upMode) {
        const cur = currentProjectId();
        if (!cur) log('Upscaled mode needs a project page open in this tab; pictures will be deferred.');
        else if (keep.some((i) => i.kind === 'image' && i.projectId && i.projectId.toLowerCase() !== cur)) log('Upscaled mode can only drive the grid of the project open in this tab; pictures from other projects are deferred.');
        log(`Upscaled mode: Flow will upscale each picture (preferring ${settings.imageUpscale}, else the best size your plan allows) one at a time (pause ${settings.upscalePauseSec}s between). Videos are saved at original quality.`);
        const limitAt = store.get('fbd.upscaleLimitAt', 0);
        if (limitAt && Date.now() - limitAt < limitPauseMs) {
          log(`⏸ Flow's upscale limit was hit at ${fmtHuman(limitAt)}; upscaling is paused until ${fmtHuman(limitAt + limitPauseMs)} (${settings.onLimit === 'originals' ? 'saving originals meanwhile' : 'those pictures are deferred'}). Use "Reset limit pause" to override.`);
          upAllowed = false;
        }
        if (upAllowed && settings.dailyUpscaleCap > 0) log(`Upscales in the last 24 h: ${upscalesLast24h()} / ${settings.dailyUpscaleCap}`);
      }
      const done = loadDone();
      let ok = 0, fail = 0, upscalesDone = 0, deferred = 0, failStreak = 0, noGridStreak = 0, gridMissing = false;
      let retryIdx = -1, hiddenRetries = 0;
      const hitLimit = (reason) => {
        store.set('fbd.upscaleLimitAt', Date.now());
        upAllowed = false;
        log(`⚠ ${reason}`);
        notifyUser(settings, 'Flow Bulk Downloader', 'Upscale limit reached — upscaling paused.');
      };
      for (let i = 0; i < keep.length; i++) {
        if (stopFlag) { log('Stopped.'); break; }
        const it = keep[i];
        const needsUp = upMode && it.kind === 'image';
        if (needsUp && gridMissing) { deferred++; continue; }
        if (needsUp && upAllowed && settings.dailyUpscaleCap > 0 && upscalesLast24h() >= settings.dailyUpscaleCap) {
          const oldest = Math.min(...loadUpscaleLog().filter((t) => Date.now() - t < 86400000));
          store.set('fbd.upscaleLimitAt', isFinite(oldest) ? oldest : Date.now());
          upAllowed = false;
          log(`⏸ Daily upscale cap of ${settings.dailyUpscaleCap} reached (counted locally); upscaling pauses until ${fmtHuman((isFinite(oldest) ? oldest : Date.now()) + limitPauseMs)}.`);
          if (settings.onLimit !== 'originals') { deferred += keep.length - i; log('Remaining pictures are deferred to a later run.'); break; }
        }
        if (needsUp && !upAllowed && settings.onLimit !== 'originals') { deferred++; continue; }
        if (needsUp && upAllowed && settings.maxUpscalesPerRun > 0 && upscalesDone >= settings.maxUpscalesPerRun) {
          if (deferred === 0) log(`Per-run upscale budget of ${settings.maxUpscalesPerRun} reached; remaining pictures are deferred to the next run.`);
          deferred++; continue;
        }
        ui.progress(i, keep.length, it);
        try {
          let r, upscaleFailed = false;
          if (needsUp && upAllowed) {
            await waitForVisibleTab(log);
            if (stopFlag) continue;
            if (retryIdx !== i) { retryIdx = i; hiddenRetries = 0; }
            const attemptAt = Date.now();
            try {
              r = await uiDownloadUpscaled(it, settings);
              if (r.upscaled) { upscalesDone++; recordUpscale(); await pacedSleep(Math.max(0, settings.upscalePauseSec || 0) * 1000); }
            } catch (e) {
              if (e && e.limit) {
                hitLimit(e.message);
                if (settings.onLimit === 'originals') { log('Continuing with original quality for the remaining pictures; they stay queued for upscaling after the pause.'); r = await downloadItem(it, settings, log); }
                else { log(`Stopping this run. Run again after ${fmtHuman(Date.now() + limitPauseMs)}; nothing was marked as done, so these pictures will be retried.`); deferred++; break; }
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
              } else {
                log(`  upscale failed for ${it.mediaId.slice(0, 8)}: ${e.message} → saving original instead`);
                r = await downloadItem(it, settings, log); upscaleFailed = true;
              }
            }
          } else {
            r = await downloadItem(it, settings, log);
          }
          try { await writeSidecar(it, r, settings); } catch (e) { log(`  sidecar failed: ${e.message}`); }
          ok++; failStreak = 0;
          done[doneKey(it.mediaId, !!r.upscaled)] = { name: r.path || r.name, at: Date.now(), project: it.projectId, bytes: r.bytes, upscaled: !!r.upscaled, upscaleFailed };
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
          if (failStreak >= 3) { log('3 failures in a row — pausing 2 minutes before continuing.'); await pacedSleep(120000); }
        }
        await pacedSleep(settings.delayMs);
      }
      ui.progress(keep.length, keep.length, null);
      if (!opts.limit) store.set('fbd.lastRun', Date.now());
      if (rows.length) {
        const m = loadManifest(); m.push(...rows); saveManifest(m);
        if (settings.manifestPerRun && ok > 0) {
          const name = `manifest-${fmtStamp(runStamp)}.csv`;
          const rel = (settings.subfolder ? safeName(settings.subfolder, 80) + '/' : '') + name;
          try { await saveText(toCsv(rows, MANIFEST_COLUMNS), rel, settings, 'text/csv;charset=utf-8'); log(`Manifest saved: ${name}`); } catch (e) { log(`Manifest failed: ${e.message}`); }
        }
      }
      log(`Done: ${ok} saved, ${fail} failed${upscalesDone ? `, ${upscalesDone} upscaled` : ''}${deferred ? `, ${deferred} deferred` : ''}.`);
      if (!opts.limit && (ok || fail)) notifyUser(settings, 'Flow Bulk Downloader', `Done: ${ok} saved, ${fail} failed${deferred ? `, ${deferred} deferred` : ''}.`);
    } catch (e) {
      log(`Error: ${e.message}`);
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
      const k = doneKey(it.mediaId, settings.quality === 'upscaled' && it.kind === 'image');
      if (!done[k]) { done[k] = { name: '(marked as done manually)', at: Date.now(), project: it.projectId, bytes: 0, upscaled: settings.quality === 'upscaled' && it.kind === 'image', upscaleFailed: false, manual: true }; n++; }
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
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; font-size: 13px; color: #e8eaed; }
        .fab { background:#1a73e8; color:#fff; border:none; border-radius:999px; padding:10px 14px; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,.4); font-weight:600; }
        .panel { display:none; width: 470px; max-height: 88vh; overflow:auto; background:#202124; border:1px solid #3c4043; border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,.6); padding:12px; }
        .panel.open { display:block; }
        h3 { margin:0 0 8px; font-size:15px; display:flex; justify-content:space-between; align-items:center; }
        h3 button { background:none; border:none; color:#9aa0a6; cursor:pointer; font-size:16px; }
        details { border:1px solid #3c4043; border-radius:8px; padding:6px 10px; margin:0 0 8px; }
        summary { color:#c4c7c5; cursor:pointer; font-weight:600; padding:2px 0; }
        label { display:inline-flex; align-items:center; gap:6px; margin:3px 10px 3px 0; }
        input[type=text], input[type=number], input[type=datetime-local], select, textarea { background:#303134; color:#e8eaed; border:1px solid #5f6368; border-radius:6px; padding:5px 7px; }
        input[type=number] { width:70px; }
        input[type=text].wide { width: 200px; }
        textarea { width:100%; min-height:44px; resize:vertical; }
        .row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:4px 0; }
        .btns { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0; }
        .btn { background:#303134; border:1px solid #5f6368; color:#e8eaed; border-radius:6px; padding:6px 10px; cursor:pointer; }
        .btn.primary { background:#1a73e8; border-color:#1a73e8; color:#fff; }
        .btn.danger { border-color:#d93025; color:#f28b82; }
        .btn:disabled { opacity:.5; cursor:not-allowed; }
        .status { color:#9aa0a6; margin:4px 0; white-space:pre-wrap; }
        .log { background:#111; border:1px solid #3c4043; border-radius:6px; padding:6px; height:150px; overflow:auto; font-family: ui-monospace, Consolas, monospace; font-size:11.5px; white-space:pre-wrap; }
        .items { max-height:150px; overflow:auto; border:1px solid #3c4043; border-radius:6px; padding:4px 6px; font-size:12px; }
        .items div { padding:2px 0; border-bottom:1px solid #2a2b2e; }
        .projects { max-height:120px; overflow:auto; }
        .projects label { display:flex; }
        .bar { height:6px; background:#3c4043; border-radius:3px; overflow:hidden; margin:6px 0; }
        .bar > div { height:100%; background:#1a73e8; width:0; transition:width .2s; }
        .muted { color:#9aa0a6; }
        .warn { color:#fdd663; }
        .learned { background:#1b1f24; border:1px dashed #5f6368; border-radius:6px; padding:6px; font-family: ui-monospace, Consolas, monospace; font-size:11.5px; white-space:pre-wrap; }
      </style>
      <div class="panel" id="panel">
        <h3>Flow Bulk Downloader <span class="muted" style="font-weight:400;font-size:11px">v${VERSION}</span> <button id="close" title="Close">✕</button></h3>
        <div class="status" id="status"></div>
        ${onLabs ? '<div class="warn">This page is the old labs.google Flow. Open <b>https://flow.google.com</b> and use the tool there.</div>' : ''}
        <div class="btns">
          <button class="btn" id="scan">Scan (dry run)</button>
          <button class="btn primary" id="download">Download</button>
          <button class="btn" id="test1" title="Download only the newest matching picture, to check everything works">Test 1 picture</button>
          <button class="btn danger" id="stop" disabled>Stop</button>
        </div>
        <div class="bar"><div id="barfill"></div></div>
        <div class="status" id="progress"></div>

        <details open>
          <summary>What to download</summary>
          <div class="row">
            <label>Since <input type="datetime-local" id="since"></label>
            <label>Until <input type="datetime-local" id="until" title="optional"></label>
          </div>
          <div class="row">
            <label><input type="checkbox" id="images"> Images</label>
            <label><input type="checkbox" id="videos"> Videos</label>
            <label><input type="checkbox" id="undated"> Include items with no date</label>
            <label><input type="checkbox" id="skipDone"> Skip already downloaded</label>
          </div>
          <div class="row">
            <label>Prompt contains <input type="text" id="kwInc" class="wide" placeholder="cat, sunset, /regex/"></label>
            <label>but not <input type="text" id="kwExc" class="wide" placeholder="test, draft"></label>
          </div>
          <div class="row">
            <label>Model contains <input type="text" id="modelFilter" placeholder="e.g. NARWHAL"></label>
            <label><input type="checkbox" id="excludeUploads"> Exclude my uploaded reference images (experimental)</label>
            <label><input type="checkbox" id="includeNotInGrid"> Include pictures not shown in the project grid (e.g. reference images used in prompts)</label>
          </div>
        </details>

        <details open>
          <summary>Picture quality</summary>
          <div class="row">
            <label><input type="radio" name="quality" value="original" id="qOriginal"> Original (direct, fast)</label>
            <label><input type="radio" name="quality" value="upscaled" id="qUpscaled"> Upscaled, via Flow's own Download menu</label>
          </div>
          <div class="row">
            <label>Prefer <input type="text" id="imageUpscale" list="fbd-res" size="5"><datalist id="fbd-res"><option value="2K"><option value="4K"><option value="1K"></datalist></label>
            <label>Menu label contains <input type="text" id="upscaleLabel" size="8"></label>
            <label>Timeout <input type="number" id="upscaleTimeout" min="10" step="10"> s</label>
          </div>
          <div class="row">
            <label><input type="checkbox" id="fallbackOriginal"> If Flow says the upscale failed, save the original instead (not retried)</label>
          </div>
          <div class="row">
            <label>Pause between upscales <input type="number" id="upscalePause" min="0" step="1"> s</label>
            <label>Max per run <input type="number" id="maxUpscales" min="0" step="1" title="0 = no cap"></label>
            <label>Daily cap <input type="number" id="dailyCap" min="0" step="1" title="0 = unknown; otherwise stop before Flow refuses"></label>
          </div>
          <div class="row">
            <label>On daily limit <select id="onLimit"><option value="stop">stop the run</option><option value="originals">continue with originals</option></select></label>
            <label>pause upscaling for <input type="number" id="limitPause" min="1" step="1"> h</label>
            <button class="btn" id="resetLimit" title="Forget that the daily limit was hit">Reset limit pause</button>
          </div>
          <div class="muted">Upscaled mode operates Flow's menu one tile at a time, waits for each file to finish, and watches Flow's messages for "upscale failed" or the daily limit. Keep this project's grid open and the tab in the foreground. Pictures whose tile or menu cannot be reached are deferred and retried next run. Videos are always saved at original quality.</div>
        </details>

        <details>
          <summary>Which projects</summary>
          <div class="row">
            <label><input type="radio" name="scope" value="current" id="scopeCurrent"> This project only</label>
            <label><input type="radio" name="scope" value="selected" id="scopeSelected"> Selected projects</label>
            <button class="btn" id="refreshProjects" title="Re-read project links from this page">Refresh list</button>
          </div>
          <div class="projects" id="projects"></div>
          <div class="muted">Projects are discovered from links on the Flow home page and from project pages you visit. You can also paste project URLs or IDs:</div>
          <textarea id="extra" placeholder="https://flow.google.com/project/xxxxxxxx-xxxx-…  (one per line)"></textarea>
        </details>

        <details>
          <summary>Saving &amp; folders</summary>
          <div class="row">
            <label>Mode <select id="mode"><option value="browser">Browser download (simple)</option><option value="tampermonkey">Tampermonkey (folders, completion signal)</option></select></label>
            <label>Base folder <input type="text" id="subfolder" size="14"></label>
          </div>
          <div class="row">
            <label><input type="checkbox" id="folderByProject"> Folder per project</label>
            <label><input type="checkbox" id="folderByMonth"> Folder per month</label>
            <label>Name <select id="namePattern"><option value="date-title-id">date - prompt - id</option><option value="title-date-id">prompt - date - id</option></select></label>
          </div>
          <div class="row">
            <label>Prompt sidecar <select id="sidecar"><option value="none">none</option><option value="txt">.txt next to each file</option><option value="json">.json next to each file</option></select></label>
            <label><input type="checkbox" id="manifestPerRun"> CSV manifest after each run</label>
          </div>
          <div class="row">
            <label><input type="checkbox" id="poster"> Preview-quality fallback if no original URL</label>
            <label>Delay between items <input type="number" id="delay" min="0" step="100"> ms</label>
          </div>
          <div class="muted">Folders and sidecars next to files need Tampermonkey mode (Tampermonkey → Settings → Downloads: whitelist jpg png webp mp4 txt json csv). In browser mode everything lands flat in Downloads.</div>
        </details>

        <details>
          <summary>Automation</summary>
          <div class="row">
            <label>Auto-check every <input type="number" id="auto" min="0" step="1"> min while this tab is open (0 = off)</label>
          </div>
          <div class="row">
            <label>Run on page load if last run older than <input type="number" id="runOnLoad" min="0" step="1"> h (0 = off)</label>
          </div>
          <div class="row">
            <label>Auto project (for Upscaled mode) <input type="text" id="autoProject" class="wide" placeholder="project URL or id"></label>
            <label><input type="checkbox" id="notify"> Desktop notifications</label>
          </div>
          <div class="muted">For unattended daily runs, schedule Chrome to open Flow each morning (see <code>schedule/Register-FlowTask.ps1</code> in the repo) and set "Run on page load". On the home page the auto project is opened first so Upscaled mode has a grid to work with.</div>
        </details>

        <details>
          <summary>Learn &amp; tools</summary>
          <div class="row">
            <label><input type="checkbox" id="learnMode"> Learn from my clicks (watch Flow's traffic and menus while I download one picture by hand)</label>
          </div>
          <div class="learned" id="learnedBox">Nothing learned yet.</div>
          <div class="btns">
            <button class="btn" id="refreshLearned">Refresh learned</button>
            <button class="btn" id="applyLearned">Apply learned to Advanced</button>
            <button class="btn" id="credits" title="Ask Flow for your credit balance">Refresh credits</button>
          </div>
          <div class="btns">
            <button class="btn" id="diag" title="Export a redacted JSON of what Flow returned, for troubleshooting">Diagnose</button>
            <button class="btn" id="exportCsv">Export full manifest (CSV)</button>
            <button class="btn" id="exportJson">Export full manifest (JSON)</button>
          </div>
          <div class="btns">
            <button class="btn" id="backup">Export backup (settings + history)</button>
            <button class="btn" id="restore">Import backup…</button>
            <input type="file" id="restoreFile" accept=".json,application/json" style="display:none">
          </div>
          <div class="btns">
            <button class="btn" id="markDone" title="Mark everything currently in the selected projects as downloaded, so future runs only pick up new items">Mark all current as done</button>
            <button class="btn" id="clear" title="Forget which files were already downloaded">Clear history</button>
          </div>
        </details>

        <details>
          <summary>Advanced (RPC ids &amp; labels)</summary>
          <div class="row">
            <label>Listing RPC <input type="text" id="rpcListing" size="7"></label>
            <label>Alt listing <input type="text" id="rpcListingAlt" size="7"></label>
            <label>Media RPC <input type="text" id="rpcMedia" size="7"></label>
            <label>Credits RPC <input type="text" id="rpcCredits" size="7"></label>
          </div>
          <div class="row">
            <label>Upscale RPC ids <input type="text" id="rpcUpscale" class="wide" placeholder="comma-separated"></label>
          </div>
          <div class="row">
            <label>Download menu label <input type="text" id="downloadLabel" size="10"></label>
            <label>Options button label (regex) <input type="text" id="optionsLabel" class="wide"></label>
          </div>
          <div class="muted">Google renames these with frontend builds. Use Learn mode to discover the current values, or send a Diagnose file.</div>
        </details>

        <div class="items" id="items"><span class="muted">Scan to see matching items here.</span></div>
        <div class="log" id="log"></div>
      </div>
      <button class="fab" id="fab" title="Flow Bulk Downloader">⬇ Flow Export</button>
    `);

    const $ = (id) => root.getElementById(id);
    const panel = $('panel');
    let settings = loadSettings();
    if (!settings.sinceLocal) settings.sinceLocal = msToLocalInput(Date.now() - 7 * 86400000);

    const logEl = $('log');
    const log = (msg) => {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
      logEl.textContent += (logEl.textContent ? '\n' : '') + line;
      logEl.scrollTop = logEl.scrollHeight;
      try { console.log('[FlowBulk]', msg); } catch (e) { /* ignore */ }
    };

    const FIELDS = {
      sinceLocal: 'since', untilLocal: 'until', images: 'images', videos: 'videos', includeUndated: 'undated', skipDone: 'skipDone',
      keywordInclude: 'kwInc', keywordExclude: 'kwExc', modelFilter: 'modelFilter', excludeUploads: 'excludeUploads', includeNotInGrid: 'includeNotInGrid',
      imageUpscale: 'imageUpscale', upscaleLabel: 'upscaleLabel', upscaleTimeoutSec: 'upscaleTimeout', fallbackOriginal: 'fallbackOriginal',
      upscalePauseSec: 'upscalePause', maxUpscalesPerRun: 'maxUpscales', dailyUpscaleCap: 'dailyCap', onLimit: 'onLimit', limitPauseHours: 'limitPause',
      extraProjects: 'extra', downloadMode: 'mode', subfolder: 'subfolder', folderByProject: 'folderByProject', folderByMonth: 'folderByMonth', namePattern: 'namePattern',
      sidecar: 'sidecar', manifestPerRun: 'manifestPerRun', allowPosterFallback: 'poster', delayMs: 'delay',
      autoMinutes: 'auto', runOnLoadHours: 'runOnLoad', autoProjectId: 'autoProject', notify: 'notify', learnMode: 'learnMode',
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
      settings.imageUpscale = (settings.imageUpscale || '2K').trim() || '2K';
      settings.upscaleLabel = settings.upscaleLabel || 'Upscal';
      settings.rpcListing = (settings.rpcListing || 'Zzl0ze').trim();
      settings.rpcMedia = (settings.rpcMedia || 'as29s').trim();
      const m = String(settings.autoProjectId || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      settings.autoProjectId = m ? m[0].toLowerCase() : '';
      saveSettings(settings);
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
      renderProjects(); renderLearned(); renderStatus();
    }
    function renderProjects() {
      const projects = discoverProjectsFromDom();
      const el = $('projects');
      const list = Object.values(projects).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      if (!list.length) { setHTML(el, '<span class="muted">No projects discovered yet. Visit the Flow home page, then click "Refresh list".</span>'); return; }
      const sel = new Set((settings.selectedProjects || []).map((s) => s.toLowerCase()));
      setHTML(el, list.map((p) => `<label><input type="checkbox" value="${p.id}" ${sel.has(p.id) ? 'checked' : ''}> <span>${escapeHtml(p.title || '(untitled)')} <span class="muted">${p.id.slice(0, 8)}</span></span></label>`).join(''));
    }
    let creditsText = '';
    function renderStatus() {
      const wiz = getWiz();
      const cur = currentProjectId();
      const doneN = Object.keys(loadDone()).length;
      const lastRun = store.get('fbd.lastRun', null);
      let s = `${wiz.at ? 'Signed-in session detected' : 'No session token found (signed out or page still loading)'}` +
        `${cur ? ` · project ${projectTitleFor(cur)}` : ' · not on a project page'}` +
        ` · ${doneN} file(s) in history` +
        ` · quality: ${settings.quality === 'upscaled' ? 'upscaled ' + settings.imageUpscale : 'original'}` +
        `${lastRun ? ` · last run ${fmtHuman(lastRun)}` : ''}${creditsText ? ` · ${creditsText}` : ''}`;
      const limitAt = store.get('fbd.upscaleLimitAt', 0);
      const pauseMs = Math.max(1, settings.limitPauseHours || 24) * 3600000;
      if (settings.quality === 'upscaled') s += `\nUpscales in last 24 h: ${upscalesLast24h()}${settings.dailyUpscaleCap > 0 ? ` / ${settings.dailyUpscaleCap}` : ''}`;
      if (limitAt && Date.now() - limitAt < pauseMs) s += `\n⏸ Upscale limit hit ${fmtHuman(limitAt)} — upscaling paused until ${fmtHuman(limitAt + pauseMs)}`;
      $('status').textContent = s;
    }
    function renderLearned() {
      const l = loadLearned();
      const keys = Object.keys(l).filter((k) => k !== 'at');
      $('learnedBox').textContent = keys.length ? keys.map((k) => `${k}: ${Array.isArray(l[k]) ? l[k].join(', ') : l[k]}`).join('\n') + (l.at ? `\n(observed ${fmtHuman(l.at)})` : '') : (settings.learnMode ? 'Learning… open a project, hover a picture, open its menu and download it once by hand, then click "Refresh learned".' : 'Nothing learned yet. Turn on "Learn from my clicks" first.');
    }
    function renderItems(items) {
      const el = $('items');
      if (!items.length) { setHTML(el, '<span class="muted">No matching items.</span>'); return; }
      setHTML(el, items.slice(0, 300).map((i) => `<div>${fmtHuman(i.createdMs)} · ${i.kind}${i.model ? ' · ' + escapeHtml(i.model) : ''} · ${escapeHtml(i.title || '(untitled)')} <span class="muted">${i.mediaId.slice(0, 8)}${i.createdSource === 'guess' ? ' · date≈' : ''}</span></div>`).join('') +
        (items.length > 300 ? `<div class="muted">…and ${items.length - 300} more</div>` : ''));
    }
    function progress(i, n, item) {
      $('barfill').style.width = n ? `${Math.round((i / n) * 100)}%` : '0%';
      $('progress').textContent = item ? `Downloading ${i + 1} / ${n}: ${fmtHuman(item.createdMs)} ${item.title || item.mediaId.slice(0, 8)}` : (n ? `Finished ${i} / ${n}` : '');
    }
    function setRunning(on) {
      for (const id of ['scan', 'download', 'test1', 'markDone']) $(id).disabled = on;
      $('stop').disabled = !on;
      renderStatus();
    }
    const ui = { log, renderItems, progress, setRunning };

    $('fab').addEventListener('click', () => { panel.classList.toggle('open'); if (panel.classList.contains('open')) { renderProjects(); renderLearned(); renderStatus(); } });
    $('close').addEventListener('click', () => panel.classList.remove('open'));
    $('refreshProjects').addEventListener('click', () => { readForm(); renderProjects(); log('Project list refreshed from this page.'); });
    for (const id of Object.values(FIELDS).concat(['scopeCurrent', 'scopeSelected', 'qOriginal', 'qUpscaled'])) $(id).addEventListener('change', readForm);
    $('projects').addEventListener('change', readForm);

    $('scan').addEventListener('click', async () => {
      if (running) return;
      readForm(); running = true; stopFlag = false; setRunning(true);
      try {
        const s = await scan(settings, log);
        const f = filterItems(s.items, settings);
        log(`Would download ${f.keep.length} item(s). Skipped: ${skipSummary(f)}.`);
        renderItems(f.keep);
      } catch (e) { log(`Error: ${e.message}`); }
      finally { running = false; setRunning(false); }
    });
    $('download').addEventListener('click', () => { readForm(); setRunning(true); runDownload(settings, ui); });
    $('test1').addEventListener('click', () => { readForm(); setRunning(true); runDownload(settings, ui, { limit: 1 }); });
    $('stop').addEventListener('click', () => { stopFlag = true; log('Stopping after the current file…'); });
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
          setRunning(true); runDownload(settings, ui);
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
      const needProject = settings.quality === 'upscaled' && !currentProjectId();
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
      panel.classList.add('open');
      log(`Run on load: last run ${last ? fmtHuman(last) : 'never'} — starting in 8 s (press Stop to cancel)…`);
      let cancelled = false;
      const onStop = () => { cancelled = true; log('Run on load cancelled.'); };
      $('stop').disabled = false; $('stop').addEventListener('click', onStop, { once: true });
      setTimeout(async () => {
        $('stop').removeEventListener('click', onStop);
        if (cancelled || running) return;
        await waitUntil(() => getWiz().at, 20000, 500);
        if (!getWiz().at) { log('Run on load: no session token; skipping.'); $('stop').disabled = true; return; }
        setRunning(true); runDownload(settings, ui);
      }, 8000);
    })();

    // Keep the project list fresh as the SPA navigates.
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) { lastPath = location.pathname; discoverProjectsFromDom(); if (panel.classList.contains('open')) { renderProjects(); renderStatus(); } }
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
