// Unit tests for the pure helpers in flow-bulk-downloader.user.js.
// Run:  node test/parse.test.cjs   (or: npm test)
// Fixtures mirror the response shapes documented by the open-source Flow clients
// (flowkit flow_batch.py, gflow-cli spikes, flow-google-api-kit PROTOCOL.md).

const assert = require('node:assert/strict');
const path = require('node:path');
const H = require(path.join(__dirname, '..', 'flow-bulk-downloader.user.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  -', name); }
  catch (e) { console.log('FAIL-', name); console.log('     ', e && e.stack || e); process.exitCode = 1; }
}

const U = (n) => `${String(n).padStart(8, '0')}-1111-4222-8333-444455556666`;
const SEC_A = 1759000000; // 2025-09-27T..Z
const SEC_B = 1759600000; // 2025-10-04T..Z

// --- Shape A: asset entry (flowkit) -----------------------------------------
const assetEntryImage = [U(1), U(99), null, ['Sunset over harbor', [SEC_A, 123456789], false, null, U(10), U(20), true], U(7)];
const assetEntryVideo = [U(2), U(99), null, ['Drone shot', [SEC_B, 5], true, null, U(11), U(21), true], U(7)];
const assetEntryUpload = [U(3), U(99), null, ['my-upload.png', [SEC_B, 0], false, null, U(13), null, true], U(7)];

// --- Shape B: generation record (gflow / api-kit) ----------------------------
function detailsWith(extra) {
  const d = new Array(14).fill(null);
  d[5] = 'https://lh3.googleusercontent.com/asb/TOKEN123=s256';
  d[8] = [3];
  d[10] = 'https://lh3.googleusercontent.com/asb/TOKEN123';
  d[13] = 2410295;
  Object.assign(d, extra || {});
  return d;
}
const recordVideo = [U(21), U(7), U(11), null, null, detailsWith(), null,
  [[null, null, null, null, null, null, null, null, 'https://flow-content.google/video/' + U(21) + '?Expires=1&KeyName=k&Signature=s', null, null, null, 'abra_r2v_8s']]];
const recordImage = [U(20), U(7), U(10), null, null, detailsWith({ 5: 'https://flow-content.google/image/' + U(10) + '?Expires=1&Signature=s', 6: [null, [['NARWHAL']]] }), null];
const recordImageUndatedEntry = [U(30), U(7), U(12), null, null, detailsWith({ 2: [1760000000, 0] }), null];

const listingPayload = [[assetEntryImage, assetEntryVideo, assetEntryUpload], [recordVideo, recordImage, recordImageUndatedEntry], 'opaque-token'];

function envelope(frames) {
  let out = ")]}'\n\n";
  for (const [rpcid, payload, err] of frames) {
    const entry = err ? ['wrb.fr', rpcid, null, null, null, err, 'generic'] : ['wrb.fr', rpcid, JSON.stringify(payload), null, null, null, 'generic'];
    const json = JSON.stringify([entry]);
    out += `${json.length + 1}\n${json}\n`;
  }
  const tail = JSON.stringify([['di', 42], ['af.httprm', 42, '-123456789', 7]]);
  out += `${tail.length + 1}\n${tail}\n`;
  return out;
}

test('parseBatchResponse decodes sentinel + length-prefixed chunks', () => {
  const frames = H.parseBatchResponse(envelope([['Zzl0ze', listingPayload]]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].rpcid, 'Zzl0ze');
  assert.deepEqual(frames[0].payload[2], 'opaque-token');
  assert.equal(frames[0].error, null);
});

test('parseBatchResponse surfaces error frames and keeps going', () => {
  const frames = H.parseBatchResponse(envelope([['as29s', null, [5, 'NOT_FOUND']], ['Zzl0ze', [[assetEntryImage]]]]));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].error, [5, 'NOT_FOUND']);
  assert.equal(frames[1].payload[0][0][0], U(1));
});

test('parseBatchResponse tolerates strings containing brackets and escaped quotes', () => {
  const payload = [['title with ] and [ and \\" quote', [SEC_A, 0]]];
  const frames = H.parseBatchResponse(envelope([['Zzl0ze', payload]]));
  assert.equal(frames[0].payload[0][0], 'title with ] and [ and \\" quote');
});

test('tsPairMs / epochMs handle s, ms, us, ns', () => {
  assert.equal(H.tsPairMs([SEC_A, 500000000]), SEC_A * 1000 + 500);
  assert.equal(H.tsPairMs([SEC_A]), SEC_A * 1000);
  assert.equal(H.epochMs(SEC_A * 1000), SEC_A * 1000);
  assert.equal(H.epochMs(SEC_A * 1e6), SEC_A * 1000);
  assert.equal(H.epochMs(SEC_A * 1e9), SEC_A * 1000);
  assert.equal(H.epochMs(2410295), null, 'a byte size is not a timestamp');
  assert.equal(H.tsPairMs([SEC_A, 1e9]), null, 'nanos must be < 1e9');
});

test('readAssetEntry reads title, time, kind and media id', () => {
  const a = H.readAssetEntry(assetEntryImage);
  assert.equal(a.mediaId, U(10));
  assert.equal(a.title, 'Sunset over harbor');
  assert.equal(a.kind, 'image');
  assert.equal(a.createdMs, SEC_A * 1000 + 123);
  assert.equal(a.projectId, U(7));
  assert.equal(H.readAssetEntry(assetEntryVideo).kind, 'video');
  assert.equal(H.readAssetEntry(recordVideo), null, 'a record is not an asset entry');
});

test('readRecord reads kind, size, status, model and signed URLs', () => {
  const v = H.readRecord(recordVideo);
  assert.deepEqual([v.mediaId, v.altId], [U(21), U(11)], 'raw slots: id0 first, id2 as alternative');
  assert.equal(v.kind, 'video');
  assert.equal(v.sizeBytes, 2410295);
  assert.equal(v.status, 3);
  assert.equal(v.model, 'abra_r2v_8s');
  assert.ok(v.urls.content[0].includes('/video/'));
  assert.equal(v.urls.poster.length, 2);
  const i = H.readRecord(recordImage);
  assert.equal(i.kind, 'image');
  assert.equal(i.model, 'NARWHAL');
  assert.ok(i.urls.content[0].includes('/image/'));
  assert.equal(H.readRecord(assetEntryImage), null, 'an asset entry is not a record');
});

test('extractItems merges entries and records by media id and flags uploads', () => {
  const { items, stats } = H.extractItems(listingPayload);
  assert.equal(stats.assetEntries, 3);
  assert.equal(stats.records, 3);
  assert.equal(items.length, 4);
  const img = items.find((i) => i.mediaId === U(10));
  assert.equal(img.title, 'Sunset over harbor');
  assert.equal(img.kind, 'image');
  assert.equal(img.createdMs, SEC_A * 1000 + 123, 'entry timestamp wins');
  assert.equal(img.createdSource, 'entry');
  assert.equal(img.sizeBytes, 2410295, 'record fields merged in');
  assert.equal(img.model, 'NARWHAL');
  assert.equal(img.hasRecord, true);
  const upload = items.find((i) => i.mediaId === U(13));
  assert.equal(upload.hasRecord, false, 'entry without a generation record looks like an upload');
  const undated = items.find((i) => i.mediaId === U(12));
  assert.equal(undated.createdSource, 'guess');
  assert.equal(undated.createdMs, 1760000000 * 1000);
  assert.equal(stats.recordIdSlot, 2, 'older layout: records link through id2');
  assert.equal(undated.inGrid, false, 'a record with no grid entry is flagged');
  assert.equal(img.inGrid, true);
});

// Layout seen on live flow.google.com (2026-10-23): entries carry no image/video flag, the
// record's FIRST id is the media id (= entry d[4], accepted by as29s) and its third id equals
// the entry's own id. Extra records without an entry are reference images, not grid results.
test('extractItems handles the live 2026-10 layout without duplicating items', () => {
  const SEC = 1787767332; // 2026-08-26
  const entry = (asset, media, op, title, flag = null) => [asset, null, null, [title, [SEC, 181952000], flag, null, media, op, [SEC + 20, 0]], U(7)];
  const rec = (media, asset, dims) => [media, U(7), asset, null, null,
    [[SEC, 0], null, null, null, null, 'https://lh3.googleusercontent.com/asb/T' + media.slice(0, 4), [null, null, [['x', null, [[1]]]], [], 1], null, null, 1, 'https://lh3.googleusercontent.com/asb/T', null, null, 974606],
    [[null, 904663, null, null, null, null, null, 'x', 29, '', null, asset, null, 'https://lh3.googleusercontent.com/asb/T', 3], null, dims, null, null, ['https://lh3.googleusercontent.com/asb/T']]];
  const payload = [null,
    [entry(U(101), U(201), U(301), 'A cozy kitchen'), entry(U(102), U(202), U(302), 'A harbor', true), entry(U(104), U(204), U(304), 'A clip')],
    [rec(U(201), U(101), [1376, 768]), rec(U(202), U(102), [1376, 768]), rec(U(203), U(101), [896, 1200]),
      rec(U(204), U(104), null).concat([['https://lh3.googleusercontent.com/asb/V']])],
    [[U(400), 1, 'library item', [U(401), 'x'.repeat(40), U(402), null, null, [[1757385964, 0]]]]],
    null, null, null, [null, null, [[null, 3, 2, null, 'x']]]];
  const { items, stats } = H.extractItems(payload);
  assert.equal(stats.recordIdSlot, 0);
  assert.equal(items.length, 4, 'two grid pictures + one video + one reference image, no duplicates');
  const a = items.find((i) => i.mediaId === U(201));
  assert.equal(a.title, 'A cozy kitchen');
  assert.equal(a.kind, 'image', 'kind comes from the record when the entry has no flag');
  assert.equal(a.createdMs, SEC * 1000 + 181);
  assert.equal(a.inGrid, true);
  assert.equal(a.hasRecord, true);
  assert.equal(items.find((i) => i.mediaId === U(202)).kind, 'image', 'a true entry flag does not make a picture a video');
  assert.equal(items.find((i) => i.mediaId === U(204)).kind, 'video');
  const ref = items.find((i) => i.mediaId === U(203));
  assert.equal(ref.inGrid, false);
  assert.equal(stats.notInGrid, 1);
});

test('guessCreatedMs prefers [sec,nanos] pairs and ignores pre-2025 noise and byte sizes', () => {
  assert.equal(H.guessCreatedMs([2410295, [1700000000, 0], [1761000000, 10], 1762000000000]), 1761000000 * 1000);
  assert.equal(H.guessCreatedMs([2410295, 3, 'abra_r2v_8s']), null);
  assert.equal(H.guessCreatedMs(['2025-10-01T12:00:00Z']), Date.parse('2025-10-01T12:00:00Z'));
});

test('pickContentUrl prefers the right path per kind and never returns the thumbnail for a video', () => {
  const urls = ['https://flow-content.google/image/thumb?x', 'https://flow-content.google/video/wf?x'];
  assert.equal(H.pickContentUrl(urls, 'video'), urls[1]);
  assert.equal(H.pickContentUrl(urls, 'image'), urls[0]);
  assert.equal(H.pickContentUrl(['https://flow-content.google/image/a'], 'video'), null);
  assert.equal(H.pickContentUrl([], 'image'), null);
});

test('buildFileName supports both patterns, tags and is filesystem-safe', () => {
  const item = { createdMs: Date.UTC(2025, 9, 4, 15, 30, 0), title: 'A/B: "quoted" <title>?', mediaId: U(10) };
  const a = H.buildFileName(item, 'jpg', 'date-title-id', '');
  assert.ok(!/[\\/:*?"<>|]/.test(a), a);
  assert.ok(a.endsWith(' - 00000010.jpg'), a);
  assert.ok(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2} - A B quoted title/.test(a), a);
  const b = H.buildFileName(item, 'jpg', 'title-date-id', '2K Upscaled');
  assert.ok(/^A B quoted title - \d{4}-\d{2}-\d{2}_/.test(b), b);
  assert.ok(b.endsWith(' - 00000010 [2K Upscaled].jpg'), b);
  const c = H.buildFileName({ createdMs: null, title: '', mediaId: U(10) }, 'png', 'date-title-id', '');
  assert.equal(c, 'nodate - 00000010.png');
});

test('buildRelPath builds project/month folders only when asked', () => {
  const item = { createdMs: Date.UTC(2025, 9, 4), projectId: U(7) };
  assert.equal(H.buildRelPath(item, 'f.jpg', { subfolder: 'Flow Export', folderByProject: true, folderByMonth: true, projectTitle: 'My/Proj: One' }), 'Flow Export/My Proj One/2025-10/f.jpg');
  assert.equal(H.buildRelPath(item, 'f.jpg', { subfolder: 'Flow Export', folderByProject: false, folderByMonth: false }), 'Flow Export/f.jpg');
  assert.equal(H.buildRelPath(item, 'f.jpg', { subfolder: '', folderByProject: true, folderByMonth: false, projectTitle: '' }), '00000007/f.jpg');
  assert.equal(H.buildRelPath({ createdMs: null }, 'f.jpg', { subfolder: 'X', folderByMonth: true }), 'X/undated/f.jpg');
});

test('keyword filters: comma-separated terms, exclusions and /regex/ terms', () => {
  const inc = H.compileTerms('cat, dog');
  const exc = H.compileTerms('draft');
  assert.equal(H.matchesKeywords('A Dog on a beach', inc, exc), true);
  assert.equal(H.matchesKeywords('A cat draft', inc, exc), false);
  assert.equal(H.matchesKeywords('Sunset', inc, exc), false);
  assert.equal(H.matchesKeywords('anything', [], []), true);
  const re = H.compileTerms('/^sun/');
  assert.equal(H.matchesKeywords('Sunset', re, []), true);
  assert.equal(H.matchesKeywords('a sunset', re, []), false);
  assert.equal(H.compileTerms('').length, 0);
});

test('detectModel finds Flow model keys and ignores other strings', () => {
  assert.equal(H.detectModel(['x', ['abra_r2v_8s']]), 'abra_r2v_8s');
  assert.equal(H.detectModel([['GEM_PIX_2']]), 'GEM_PIX_2');
  assert.equal(H.detectModel(['https://flow-content.google/image/a', 'Sunset over harbor', 3]), null);
});

test('toCsv escapes quotes, commas and newlines and keeps column order', () => {
  const csv = H.toCsv([{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2', d: null }], ['a', 'b', 'c', 'd']);
  assert.equal(csv, 'a,b,c,d\r\n"x,y","he said ""hi""","line1\nline2",\r\n');
  assert.equal(H.csvEscape(42), '42');
});

test('countSince counts timestamps in a window', () => {
  const now = 1_800_000_000_000;
  assert.equal(H.countSince([now - 1000, now - 90_000_000, now - 5], now - 86_400_000), 2);
  assert.equal(H.countSince([], 0), 0);
});

test('inferLearned proposes RPC ids and menu labels from observed traffic and clicks', () => {
  const net = [
    { rpcid: 'AAA111', items: 50, size: 1e6 }, { rpcid: 'AAA111', items: 48, size: 9e5 },
    { rpcid: 'BBB222', items: 1, hasContent: true, size: 3000 },
    { rpcid: 'CCC333', hasBig: true, size: 200000 },
    { rpcid: 'DDD444', numbersOnly: true, size: 10 },
  ];
  const clicks = [
    { kind: 'button', inTile: true, ariaLabel: 'More options', text: '⋮', visibleBefore: [], visibleAfter: ['Download ▸', 'Delete'] },
    { kind: 'menuitem', text: 'Download ▸', visibleBefore: ['Download ▸', 'Delete'], visibleAfter: ['Download ▸', 'Delete', '1K Original', '2K Upscaled', '4K Upscaled'] },
    { kind: 'menuitem', text: '4K Upscaled', visibleBefore: ['Download ▸', 'Delete', '1K Original', '2K Upscaled', '4K Upscaled'], visibleAfter: [] },
  ];
  const l = H.inferLearned(net, clicks);
  assert.equal(l.rpcListing, 'AAA111');
  assert.equal(l.rpcMedia, 'BBB222');
  assert.deepEqual(l.rpcUpscaleIds, ['CCC333']);
  assert.equal(l.rpcCredits, 'DDD444');
  assert.equal(l.downloadLabel, 'Download');
  assert.equal(l.imageUpscale, '4K');
  assert.equal(l.upscaleLabel, 'Upscaled');
  assert.equal(l.optionsLabel, 'More options');
  assert.deepEqual(H.inferLearned([], []), {});
});

test('extFromMime and sniffExt agree on common types', () => {
  assert.equal(H.extFromMime('image/jpeg; charset=binary', 'image'), 'jpg');
  assert.equal(H.extFromMime('video/mp4', 'video'), 'mp4');
  assert.equal(H.extFromMime('application/octet-stream', 'video'), 'mp4');
  assert.equal(H.extFromMime('', 'image'), 'jpg');
  assert.equal(H.sniffExt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
  assert.equal(H.sniffExt(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])), 'mp4');
  assert.equal(H.sniffExt(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'webp');
});

test('redact strips signatures and ids from URLs', () => {
  const r = H.redact(['https://flow-content.google/video/' + U(21) + '?Expires=1&Signature=SECRET', 'https://lh3.googleusercontent.com/asb/TOKEN123=s256']);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.ok(!JSON.stringify(r).includes('TOKEN123'));
  assert.ok(!JSON.stringify(r).includes(U(21)));
});

test('a multi-megabyte listing parses in reasonable time', () => {
  const big = [];
  for (let i = 0; i < 4000; i++) {
    big.push([U(1000 + i), U(99), null, [`Prompt number ${i} with some descriptive text`, [SEC_A + i, 0], i % 3 === 0, null, U(5000 + i), U(9000 + i), true], U(7)]);
    big.push([U(9000 + i), U(7), U(5000 + i), null, null, detailsWith({ 5: 'https://flow-content.google/image/' + U(5000 + i) + '?Expires=1&Signature=' + 'x'.repeat(300) }), null]);
  }
  const text = envelope([['Zzl0ze', [big]]]);
  const t0 = Date.now();
  const frames = H.parseBatchResponse(text);
  const { items } = H.extractItems(frames[0].payload);
  const dt = Date.now() - t0;
  assert.equal(items.length, 4000);
  console.log(`      (${(text.length / 1048576).toFixed(1)} MB parsed + extracted in ${dt} ms)`);
  assert.ok(dt < 15000, `too slow: ${dt} ms`);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures' : ''}.`);
