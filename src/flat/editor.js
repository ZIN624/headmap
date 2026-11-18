// SPDX-License-Identifier: AGPL-3.0-only
// 2D 頭圖的編輯器：五個視圖（左側、右側、頂視、正面、背面）的平面圖，底圖是從頭模畫出來的線稿。
// 兩種版面：總覽（五個視圖一起看，點一個進去）與單一視圖（在這裡畫）。
// 工具：選取、線（直線、箭頭、曲線、曲線箭頭、折線）、手畫、點（四種記號）、形狀（圓、橢圓、圈出一塊面、點連成面、點一下填滿、角度）、
//       文字、工具圖示（剪刀、打薄剪、剃刀、電剪…）、橡皮擦（整筆、局部）。
// 輔助：磁吸（點位、線端、頭的外框；方向轉正；對齊輔助線）、鏡像（對稱視圖左右、左側↔右側）、完善線條、放大鏡、格線、分區樣板、整側鏡像。
// 預覽：一筆一筆畫出來的動畫（速度三段、平行的線自動同時畫）。輸出：PNG（一個視圖、五視圖總表）、PDF、動畫影片、社群輪播圖。
// 資料：每個步驟一組筆（library.js 的 2D 步驟）；這個檔只管畫面與操作，格式在 shapes.js。
import * as S from './shapes.js';
import { VIEWS, VIEW_IDS, viewById, isSymmetric, mirrorView, pageBox, PAGE } from './views.js';
import { templatesFor } from './template.js';
import { shapeSvg, backgroundSvg, drawView, drawShape, ICON_PATHS } from './render.js';
import * as SN from './snap.js';
import * as AN from './anim.js';
import { media, buildPdf, buildZip, loadImage } from './media.js';
import * as L from '../library.js';
import * as TPL from '../templates.js';
import * as SEC from '../section.js';
import { fitWarp } from '../transfer.js';

const UI_KEY = 'head3d.flat';
const SEL = '#CD7158';
const LINE_VARIANTS = [['line', '直線'], ['arrow', '矢印'], ['curve', '曲線'], ['carrow', '曲線矢印'], ['poly', '折れ線']];
const SHAPE_VARIANTS = [['circle', '円'], ['ellipse', '楕円'], ['lasso', '囲んで面'], ['polyfill', '点をつないで面'], ['fill', 'タップで塗る'], ['angle', '角度']];
const MARK_VARIANTS = [['fill', '塗り'], ['ring', '白抜き'], ['cross', '十字'], ['x', 'バツ']];
const ERASE_VARIANTS = [['whole', '1本ごと消す'], ['part', '一部だけ消す']];
const SMOOTH_VARIANTS = [[0, 'そのまま'], [1, '少しなめらか'], [2, 'なめらか'], [3, 'とてもなめらか']];
const TOOL_TIPS = {
  select: '線をタップして選択。空いている所をドラッグで画面移動、2本指で拡大縮小。',
  line: { line: '押したままドラッグで直線。水平・垂直・45° に近いと自動でそろいます。', arrow: '押したままドラッグで矢印（終点に矢印）。', curve: 'まず直線を引き、真ん中の四角をドラッグして曲げます。', carrow: 'まず直線の矢印を引き、真ん中の四角をドラッグして曲げます。', poly: '曲がり角を1つずつタップし、「完了」で終わります。' },
  free: '押したまま自由に描きます。指を離すと「なめらかさ」の設定で整えます。',
  dot: 'タップして点を置きます。',
  shape: { circle: '押したままドラッグで円。', ellipse: '押したままドラッグで楕円の外枠。', lasso: '押したまま1周なぞって面を作ります。', polyfill: '面の角を1つずつタップし、「完了」で閉じます。', fill: '線で囲まれた所をタップすると塗りつぶします（境目＝線と頭の外枠）。', angle: '角の頂点から片側へドラッグし、離したらもう片側の端をドラッグして角度を決めます。' },
  text: 'タップして文字を置きます。',
  icon: 'タップして道具アイコンを置きます。選択すると向きと大きさを変えられます。',
  erase: { whole: 'なぞった線を1本まるごと消します。', part: 'なぞった部分だけ消します（線は2本に分かれます）。' },
};
const FAMILY = { line: 'line', free: 'free', dot: 'dot', shape: 'shape', text: 'text', icon: 'icon' };
const defaultStyles = () => ({
  line: { color: '#236B91', width: S.WIDTHS[1], dash: 'solid', ends: { a: 'none', b: 'none' } },
  free: { color: '#1B1B1B', width: S.WIDTHS[1], dash: 'solid', ends: { a: 'none', b: 'none' } },
  dot: { color: '#D86735', r: 2.4 },
  shape: { color: '#0C8F91', width: S.WIDTHS[1], dash: 'solid', opacity: 0.35 },
  text: { color: '#363B49', size: 9, bold: false, box: false },
  icon: { color: '#363B49', size: 22 },
});
const TAP_PX = 6, HANDLE_PX = 15, HIT_PX = 11, ERASE_PX = 10, LONG_MS = 480;

export function createFlat(app) {
  const $ = s => document.querySelector(s);
  const root = $('#flat'), grid = $('#fl-grid'), one = $('#fl-one'), svg = $('#fl-svg');
  const gBg = $('#fl-bg'), gBelow = $('#fl-below'), gShapes = $('#fl-shapes'), gLive = $('#fl-live'), gUi = $('#fl-ui');
  const loupe = $('#fl-loupe'), loupeSvg = $('#fl-loupe-svg'), canvas = $('#fl-canvas');
  const toast = app.toast;

  // ---------------------------------------------------------------- 狀態
  let drawing = null, head = null, tpls = null, stepIdx = 0;
  let shapes = [], below = [];             // 這一步的筆（可以改）、前面步驟的筆（只看）
  let layout = 'one', view = 'front', mode = 'draw';
  let tool = 'select', selId = null;
  const variant = { line: 'line', shape: 'circle', dot: 'fill', erase: 'whole', icon: 'scissors' };
  let styles = defaultStyles();
  const history = [], future = [];
  const vbs = {};                          // 每個視圖的可視範圍（公釐）
  let backs = {};                          // 視圖 → 自己的底圖 { url, img }
  loadUI();

  function loadUI() {
    try {
      const u = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
      if (u.tool && (u.tool === 'select' || TOOL_TIPS[u.tool])) tool = u.tool;
      if (u.variant) for (const k of Object.keys(variant)) if (typeof u.variant[k] === 'string') variant[k] = u.variant[k];
      if (u.styles) for (const k of Object.keys(styles)) if (u.styles[k] && typeof u.styles[k] === 'object') styles[k] = { ...styles[k], ...u.styles[k] };
      if (u.layout === 'all' || u.layout === 'one') layout = u.layout;
    } catch { /* 沒記過 */ }
  }
  function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify({ tool, variant, styles, layout })); } catch { /* 存不下就不記 */ } }
  const settings = () => app.lib().settings;
  const step = () => drawing.steps[stepIdx];
  const byId = id => shapes.find(s => s.id === id) || null;
  const sel = () => (selId ? byId(selId) : null);
  const inView = v => shapes.filter(s => s.view === v);
  const belowIn = v => below.filter(s => s.view === v);

  // ---------------------------------------------------------------- 打開、關掉、換步驟
  async function open(d, h, lastView) {
    drawing = d; head = h; history.length = 0; future.length = 0; selId = null;
    if (lastView && VIEW_IDS.includes(lastView)) view = lastView;
    for (const v of VIEW_IDS) vbs[v] = fitBox(v);
    root.classList.add('loading');
    try { tpls = await templatesFor(app.THREE, app.renderer, h); }
    finally { root.classList.remove('loading'); }
    await loadBacks();
    buildGrid(); syncTools(); syncEye(); syncLayout();
  }
  function close() { stopPlay(); cancelDraft(); closePops(); drawing = null; shapes = []; below = []; for (const b of Object.values(backs)) URL.revokeObjectURL(b.url); backs = {}; }
  function openStep(i) {
    stopPlay(); cancelDraft();
    stepIdx = i; selId = null; history.length = 0; future.length = 0;
    try { shapes = L.stepShapes(step()); } catch (e) { toast('このステップの図が読み込めません：' + e.message, 4000); shapes = []; }
    below = [];
    for (let j = 0; j < stepIdx; j++) { try { below.push(...L.stepShapes(drawing.steps[j])); } catch { /* 讀不進來的步驟略過 */ } }
    renderAll(); syncSel(); app.changed();
    if (mode === 'preview') playStep();
  }
  async function loadBacks() {
    for (const b of Object.values(backs)) URL.revokeObjectURL(b.url);
    backs = {};
    for (const [v, id] of Object.entries(drawing.backs || {})) {
      const blob = await media.get(id).catch(() => null); if (!blob) continue;
      backs[v] = { url: URL.createObjectURL(blob), img: await loadImage(blob).catch(() => null) };
    }
  }
  function setMode(m) {
    mode = m; closePops(); cancelDraft();
    if (m !== 'draw') select(null);
    root.dataset.mode = m;
    syncLayout();
    if (m === 'preview') playStep(); else stopPlay();
  }

  // ---------------------------------------------------------------- 存檔與復原
  const snap = () => JSON.stringify(shapes);
  function pushHistory() { history.push(snap()); if (history.length > 80) history.shift(); future.length = 0; }
  function commit() { L.storeStepShapes(step(), shapes); app.saved(); renderShapes(); syncSel(); }
  function restore(json) { shapes = JSON.parse(json); if (selId && !byId(selId)) selId = null; commit(); }
  function undo() { if (!history.length) return; cancelDraft(); future.push(snap()); restore(history.pop()); app.changed(); }
  function redo() { if (!future.length) return; cancelDraft(); history.push(snap()); restore(future.pop()); app.changed(); }
  function clearStep() { if (!shapes.length) return; pushHistory(); shapes = []; selId = null; commit(); }

  // ---------------------------------------------------------------- 鏡像
  // 對稱的視圖（頂、正、背）：對 x＝0 翻、留在同一個視圖；左側、右側：翻到另一個視圖
  function mirroredOf(s) {
    const m = S.mirrorX(S.clone(s));
    m.view = mirrorView(s.view);
    return m;
  }
  function samePlace(a, b) { // 鏡像後幾乎疊在原本那一筆上（畫在正中線上）：不另外畫一筆
    if (a.view !== b.view || a.pts.length !== b.pts.length) return false;
    const fw = a.pts.every((p, i) => S.dist(p, b.pts[i]) < 2), bw = a.pts.every((p, i) => S.dist(p, b.pts[b.pts.length - 1 - i]) < 2);
    return fw || bw;
  }
  function addShape(s, mirror = settings().mirror) {
    shapes.push(s);
    if (!mirror) return s;
    const m = mirroredOf(s);
    if (samePlace(s, m)) return s;
    m.id = S.newId(); s.mirrorPairId = m.id; m.mirrorPairId = s.id;
    shapes.push(m);
    return s;
  }
  // 改了一筆：鏡像的另一筆跟著改（位置與樣式）
  function syncPartner(s) {
    if (!s.mirrorPairId) return;
    const p = byId(s.mirrorPairId); if (!p) { delete s.mirrorPairId; return; }
    const m = mirroredOf(s);
    for (const k of Object.keys(p)) if (!['id', 'mirrorPairId', 'view', 'origin'].includes(k)) delete p[k];
    for (const [k, v] of Object.entries(m)) if (!['id', 'mirrorPairId', 'view', 'origin'].includes(k)) p[k] = v;
  }
  function removeShape(s, withPartner = true) {
    const ids = new Set([s.id]); if (withPartner && s.mirrorPairId) ids.add(s.mirrorPairId);
    shapes = shapes.filter(x => !ids.has(x.id));
    for (const x of shapes) if (x.mirrorPairId && ids.has(x.mirrorPairId)) delete x.mirrorPairId;
    if (ids.has(selId)) selId = null;
  }

  // ---------------------------------------------------------------- 版面：總覽／單一視圖
  function fitBox(v) { const b = pageBox(v); return { x: b.x, y: b.y, w: b.w, h: b.h }; }
  function buildGrid() {
    grid.innerHTML = VIEWS.map(v => `<button type="button" class="fl-cell" data-view="${v.id}" aria-label="${v.label}"><svg viewBox="${(() => { const b = pageBox(v.id); return [b.x, b.y, b.w, b.h].join(' '); })()}" preserveAspectRatio="xMidYMid meet"><g class="bg"></g><g class="below"></g><g class="sh"></g></svg><span class="fl-cell-k">${v.label}<b class="n"></b></span></button>`).join('');
  }
  function syncLayout() {
    const all = layout === 'all';
    grid.hidden = !all || mode === 'preview'; one.hidden = all || mode === 'preview';
    canvas.hidden = mode !== 'preview';
    root.dataset.layout = all ? 'all' : 'one'; // 總覽時結構線鈕移到右下角的空位（不蓋到「右側」）
    $('#fl-layout').setAttribute('aria-pressed', String(all));
    $('#fl-layout span').textContent = all ? '1方向' : '一覧';
    $('#fl-layout').setAttribute('aria-label', all ? '1方向に戻る' : '5方向の一覧');
    $('#fl-tabs').hidden = false;
    document.querySelectorAll('#fl-tabs [data-view]').forEach(b => { b.classList.toggle('on', !all && b.dataset.view === view); b.setAttribute('aria-pressed', String(!all && b.dataset.view === view)); });
    $('#fl-more').hidden = all || mode !== 'draw';
    $('#fl-fit').hidden = all || mode !== 'draw';
    document.body.classList.toggle('fl-all', all && mode === 'draw');
    if (mode === 'preview') { resizeCanvas(); drawFrame(); }
    else renderAll();
    syncTools();
  }
  function setLayout(l) { layout = l; saveUI(); syncLayout(); }
  function setView(v) { if (!VIEW_IDS.includes(v)) return; cancelDraft(); if (view !== v) select(null); view = v; if (app.lib().current) app.lib().current.view = v; layout = 'one'; saveUI(); syncLayout(); }

  // ---------------------------------------------------------------- 畫出來
  function bgOpt(v) {
    const st = settings();
    return { grid: st.grid, shade: st.shade, hairline: st.hairline, structure: st.structure, points: st.structure, names: st.labels, back: backs[v] ? backs[v].url : null }; // 十五點跟著結構線一起開關
  }
  function renderAll() {
    if (!drawing || !tpls) return;
    if (layout === 'all') { renderGrid(); return; }
    svg.setAttribute('viewBox', vbStr(vbs[view]));
    gBg.innerHTML = backgroundSvg(tpls[view], bgOpt(view), 'fl-pat-main');
    renderShapes();
  }
  const vbStr = b => [b.x, b.y, b.w, b.h].map(x => Math.round(x * 100) / 100).join(' ');
  function renderShapes() {
    if (!drawing || !tpls) return;
    if (layout === 'all') { renderGrid(); return; }
    const ghost = settings().ghost;
    gBelow.innerHTML = belowIn(view).map(s => shapeSvg(s, { ghost })).join('');
    gShapes.innerHTML = inView(view).map(s => shapeSvg(s)).join('');
    updateUi();
  }
  function renderGrid() {
    const ghost = settings().ghost;
    for (const cell of grid.querySelectorAll('.fl-cell')) {
      const v = cell.dataset.view;
      cell.querySelector('.bg').innerHTML = backgroundSvg(tpls[v], { ...bgOpt(v), points: false, names: false }, 'fl-pat-' + v);
      cell.querySelector('.below').innerHTML = belowIn(v).map(s => shapeSvg(s, { ghost })).join('');
      cell.querySelector('.sh').innerHTML = inView(v).map(s => shapeSvg(s)).join('');
      const n = inView(v).length;
      cell.querySelector('.n').textContent = n ? n + ' 個' : '';
    }
  }
  // 選取框、把手、吸附點、輔助線（大小照螢幕像素，換算成公釐）
  let liveGuides = [], liveSnap = null;
  function updateUi() {
    if (layout === 'all' || !drawing) { gUi.innerHTML = ''; return; }
    const px = pxMm(); let h = '';
    const s = sel();
    if (s && s.view === view) {
      const g = S.geom(s);
      h += `<path d="${g.d}" fill="none" stroke="${SEL}" stroke-opacity=".35" stroke-width="${s.style.width + 5 * px}" stroke-linecap="round" stroke-linejoin="round"/>`;
      if (s.type === 'text' || s.type === 'icon') { const c = S.boxOf(s); h += `<polygon points="${c.map(p => p.join(',')).join(' ')}" fill="none" stroke="${SEL}" stroke-width="${px * 1.2}" stroke-dasharray="${px * 4} ${px * 3}"/>`; }
      for (const hd of handlesOf(s)) {
        const r = (hd.kind === 'mid' || hd.kind === 'm' ? 5 : 5.5) * px;
        if (hd.kind === 'rot') h += `<line x1="${hd.from[0]}" y1="${hd.from[1]}" x2="${hd.p[0]}" y2="${hd.p[1]}" stroke="${SEL}" stroke-width="${px}"/>`;
        h += hd.kind === 'mid' || hd.kind === 'm' || hd.kind === 'scale'
          ? `<rect x="${hd.p[0] - r}" y="${hd.p[1] - r}" width="${2 * r}" height="${2 * r}" rx="${px * 1.5}" fill="#fff" stroke="${SEL}" stroke-width="${px * 1.6}"/>`
          : `<circle cx="${hd.p[0]}" cy="${hd.p[1]}" r="${r}" fill="${hd.kind === 'rot' ? SEL : '#fff'}" stroke="${hd.kind === 'rot' ? '#fff' : '#2B3744'}" stroke-width="${px * 1.5}"/>`;
      }
    }
    for (const gd of liveGuides) {
      const b = vbs[view];
      h += gd.axis === 'x' ? `<line x1="${gd.v}" y1="${b.y}" x2="${gd.v}" y2="${b.y + b.h}" stroke="#1B64FF" stroke-width="${px}" stroke-dasharray="${px * 5} ${px * 4}"/>` : `<line x1="${b.x}" y1="${gd.v}" x2="${b.x + b.w}" y2="${gd.v}" stroke="#1B64FF" stroke-width="${px}" stroke-dasharray="${px * 5} ${px * 4}"/>`;
    }
    if (liveSnap) h += `<circle cx="${liveSnap[0]}" cy="${liveSnap[1]}" r="${px * 10}" fill="rgba(205,113,88,.14)" stroke="${SEL}" stroke-width="${px * 2}"/>`;
    if (eraserAt && tool === 'erase') h += `<circle cx="${eraserAt[0]}" cy="${eraserAt[1]}" r="${ERASE_PX * px}" fill="rgba(198,59,50,.08)" stroke="#C63B32" stroke-width="${px * 1.4}"/>`;
    gUi.innerHTML = h;
  }
  // 一筆的把手：{ kind, i?, p, from? }
  function handlesOf(s) {
    const out = [], px = pxMm();
    switch (s.type) {
      case 'line': out.push({ kind: 'pt', i: 0, p: s.pts[0] }, { kind: 'pt', i: 1, p: s.pts[1] }, { kind: 'mid', p: S.mid(s.pts[0], s.pts[1]) }); break;
      case 'curve': out.push({ kind: 'pt', i: 0, p: s.pts[0] }, { kind: 'pt', i: 1, p: s.pts[1] }, { kind: 'm', p: s.m }); break;
      case 'poly': s.pts.forEach((p, i) => out.push({ kind: 'pt', i, p })); break;
      case 'free': out.push({ kind: 'pt', i: 0, p: s.pts[0] }, { kind: 'pt', i: s.pts.length - 1, p: s.pts[s.pts.length - 1] }); break;
      case 'region': if (!s.smooth) s.pts.forEach((p, i) => out.push({ kind: 'pt', i, p })); break;
      case 'angle': s.pts.forEach((p, i) => out.push({ kind: 'pt', i, p })); break;
      case 'ellipse': {
        const c = s.pts[0], r = s.rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
        out.push({ kind: 'rx', p: [c[0] + s.rx * cs, c[1] + s.rx * sn] }, { kind: 'ry', p: [c[0] - s.ry * sn, c[1] + s.ry * cs] });
        const rp = [c[0] + (s.rx + 14 * px) * cs, c[1] + (s.rx + 14 * px) * sn];
        out.push({ kind: 'rot', p: rp, from: [c[0] + s.rx * cs, c[1] + s.rx * sn] });
        break;
      }
      case 'text': case 'icon': {
        const box = S.boxOf(s), c = s.pts[0];
        out.push({ kind: 'scale', p: box[2] });
        const top = S.mid(box[0], box[1]), dx = top[0] - c[0], dy = top[1] - c[1], L = Math.hypot(dx, dy) || 1;
        out.push({ kind: 'rot', p: [top[0] + dx / L * 16 * px, top[1] + dy / L * 16 * px], from: top });
        break;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 座標、縮放
  function toMm(e) {
    const m = svg.getScreenCTM(); if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }
  function pxMm() { const m = svg.getScreenCTM(); return m && m.a ? 1 / m.a : 0.3; }
  function zoomAt(mm, k) { // k>1＝放大
    const b = vbs[view], w = Math.min(PAGE.w * 1.25, Math.max(PAGE.w / 10, b.w / k)), kk = b.w / w, h = b.h / kk;
    vbs[view] = { x: mm[0] - (mm[0] - b.x) / kk, y: mm[1] - (mm[1] - b.y) / kk, w, h };
    svg.setAttribute('viewBox', vbStr(vbs[view])); updateUi();
    $('#fl-fit').classList.toggle('zoomed', Math.abs(vbs[view].w - PAGE.w) > 1);
  }
  function panBy(dx, dy) { const b = vbs[view]; vbs[view] = { ...b, x: b.x - dx, y: b.y - dy }; svg.setAttribute('viewBox', vbStr(vbs[view])); updateUi(); }
  function fit() { vbs[view] = fitBox(view); svg.setAttribute('viewBox', vbStr(vbs[view])); updateUi(); $('#fl-fit').classList.remove('zoomed'); }

  // ---------------------------------------------------------------- 吸附
  let snapLock = null;
  function snapCands(excludeIds = []) {
    const ex = new Set(excludeIds), out = [];
    const t = tpls[view];
    for (const p of t.points) out.push({ id: 'lm:' + p.id + p.side, p: p.p, kind: 'point' }); // 十五點不管看不看得到都吸得到（和 3D 一樣）
    for (const s of [...inView(view), ...belowIn(view)]) {
      if (ex.has(s.id)) continue;
      if (S.PATH_TYPES.includes(s.type)) { out.push({ id: s.id + ':a', p: s.pts[0], kind: 'end' }, { id: s.id + ':b', p: s.pts[s.pts.length - 1], kind: 'end' }); }
      else if (s.type === 'dot') out.push({ id: s.id, p: s.pts[0], kind: 'end' });
      else if (s.type === 'angle') out.push({ id: s.id, p: s.pts[0], kind: 'end' });
    }
    return out;
  }
  function refPaths() {
    const t = tpls[view], out = [{ id: 'outline', pts: t.outline.concat([t.outline[0]]) }];
    t.hairline.forEach((r, i) => out.push({ id: 'hair' + i, pts: r }));
    return out;
  }
  // p 吸到點位／線端／頭的外框；from＝線的起點（給方向磁吸、對齊輔助線）
  function snapAt(p, { exclude = [], from = null, dir = true } = {}) {
    liveGuides = []; liveSnap = null;
    if (!settings().snap) { snapLock = null; return p; }
    const px = pxMm(), cands = snapCands(exclude);
    let hit = SN.snapPoint(p, cands, px, snapLock);
    if (!hit) { const pp = SN.nearestPathPoint(p, refPaths(), px); if (pp) hit = pp; }
    if (hit) { snapLock = hit.id; liveSnap = hit.p; return hit.p.slice(); }
    snapLock = null;
    let q = p;
    if (from && dir) { const d = SN.snapDirection(from, q, px); if (d) q = d.p; }
    if (settings().guides) {
      const others = cands.filter(c => c.kind !== 'path').map(c => c.p);
      const g = SN.alignGuides(q, others, px);
      if (g.guides.length && !(from && dir && SN.snapDirection(from, p, px))) { q = g.p; liveGuides = g.guides; }
    }
    return q;
  }
  function clearSnap() { liveGuides = []; liveSnap = null; snapLock = null; }

  // ---------------------------------------------------------------- 選取
  function select(id) {
    selId = id;
    if (id) { const s = byId(id); if (s && s.view !== view && layout === 'one') view = s.view; }
    closePops(); syncSel(); updateUi();
  }
  function hitShape(p, prefer = selId) {
    const px = pxMm(), tol = HIT_PX * px, list = inView(view);
    if (prefer) { const s = byId(prefer); if (s && s.view === view && S.hitDistance(s, p) <= tol) return s; }
    for (let i = list.length - 1; i >= 0; i--) if (S.hitDistance(list[i], p) <= tol) return list[i];
    return null;
  }
  function hitHandle(p) {
    const s = sel(); if (!s || s.view !== view) return null;
    const px = pxMm(); let best = null, bd = HANDLE_PX * px;
    for (const h of handlesOf(s)) { const d = S.dist(p, h.p); if (d <= bd) { bd = d; best = h; } }
    return best;
  }

  // ---------------------------------------------------------------- 畫到一半（折線、點連成面）
  let draft = null; // { kind:'poly'|'polyfill', pts }
  function cancelDraft() { if (!draft && !gesture) return; draft = null; gesture = null; gLive.innerHTML = ''; clearSnap(); hideLoupe(); syncDraftBar(); updateUi(); }
  function syncDraftBar() {
    const bar = $('#fl-draftbar');
    bar.hidden = !draft;
    if (!draft) return;
    $('#fl-draft-text').textContent = draft.kind === 'poly' ? '折れ線：' + draft.pts.length + ' 点タップ済み' : '面：' + draft.pts.length + ' 個の角をタップ済み';
    $('#fl-draft-done').disabled = draft.pts.length < (draft.kind === 'poly' ? 2 : 3);
  }
  function finishDraft() {
    if (!draft) return;
    const d = draft; draft = null; gLive.innerHTML = ''; syncDraftBar();
    if (d.kind === 'poly' && d.pts.length >= 2) create(S.newShape({ type: 'poly', view, pts: d.pts, style: lineStyle(), ends: styles.line.ends }));
    else if (d.kind === 'polyfill' && d.pts.length >= 3) create(S.newShape({ type: 'region', view, pts: d.pts, smooth: false, style: shapeStyle() }));
    clearSnap(); updateUi();
  }
  function renderDraft(extra = null) {
    if (!draft) { gLive.innerHTML = ''; return; }
    const pts = extra ? draft.pts.concat([extra]) : draft.pts, px = pxMm();
    const st = draft.kind === 'poly' ? lineStyle() : shapeStyle();
    gLive.innerHTML = `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="${draft.kind === 'polyfill' ? st.color : 'none'}" fill-opacity=".2" stroke="${st.color}" stroke-width="${st.width}" stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>`
      + draft.pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="${px * 4.5}" fill="${SEL}" stroke="#fff" stroke-width="${px * 1.3}"/>`).join('');
  }

  // 新的一筆：放進這一步、鏡像、存檔；線、曲線、圖示畫完先選取它（可以馬上調）
  function create(s, { selectIt = false } = {}) {
    pushHistory();
    addShape(s);
    commit();
    if (selectIt || ['curve', 'icon', 'text', 'angle'].includes(s.type)) select(s.id); else if (selId) select(null); else syncSel();
    app.changed();
    return s;
  }
  const lineStyle = () => ({ color: styles.line.color, width: styles.line.width, dash: styles.line.dash });
  const shapeStyle = () => ({ color: styles.shape.color, width: styles.shape.width, dash: styles.shape.dash, opacity: styles.shape.opacity });

  // ---------------------------------------------------------------- 手勢
  // gesture：一指＝這個工具的動作；兩指＝縮放＋移動；滾輪縮放；右鍵或中鍵拖＝移動畫面
  const pointers = new Map();
  let gesture = null, pinch = null, eraserAt = null, longTimer = 0;
  svg.addEventListener('contextmenu', e => e.preventDefault());
  svg.addEventListener('pointerdown', e => {
    if (mode !== 'draw' || layout !== 'one' || !tpls) return;
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    closePops();
    if (pointers.size === 2) { // 第二指：取消畫到一半的那一筆，改成縮放
      if (gesture && gesture.kind !== 'pan') { if (gesture.pushed) { shapes = JSON.parse(history.pop()); commit(); } gesture = null; gLive.innerHTML = ''; clearSnap(); hideLoupe(); }
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), c: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
      return;
    }
    if (pointers.size > 2) return;
    const p = toMm(e);
    if (e.button === 1 || e.button === 2) { gesture = { kind: 'pan', last: [e.clientX, e.clientY] }; return; }
    begin(p, e);
  });
  svg.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) { if (tool === 'erase' && mode === 'draw' && e.pointerType === 'mouse') { eraserAt = toMm(e); updateUi(); } return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), c = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const px = pxMm();
      panBy((c[0] - pinch.c[0]) * px, (c[1] - pinch.c[1]) * px);
      zoomAt(toMm({ clientX: c[0], clientY: c[1] }), d / (pinch.d || d));
      pinch = { d, c };
      return;
    }
    if (!gesture) return;
    if (gesture.kind === 'pan') { const px = pxMm(); panBy((e.clientX - gesture.last[0]) * px, (e.clientY - gesture.last[1]) * px); gesture.last = [e.clientX, e.clientY]; return; }
    move(toMm(e), e);
  });
  const endPointer = (e, cancel) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    clearTimeout(longTimer);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (!gesture) return;
    if (gesture.kind === 'pan') { gesture = null; return; }
    if (cancel) { if (gesture.pushed) { shapes = JSON.parse(history.pop()); commit(); } gesture = null; gLive.innerHTML = ''; clearSnap(); hideLoupe(); updateUi(); return; }
    end(toMm(e), e);
  };
  svg.addEventListener('pointerup', e => endPointer(e, false));
  svg.addEventListener('pointercancel', e => endPointer(e, true));
  svg.addEventListener('pointerleave', () => { if (tool === 'erase' && !gesture) { eraserAt = null; updateUi(); } });
  svg.addEventListener('wheel', e => {
    if (mode !== 'draw' || layout !== 'one') return;
    e.preventDefault();
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(toMm(e), Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    else panBy(e.deltaX * pxMm(), 0);
  }, { passive: false });

  function begin(p, e) {
    const sx = e.clientX, sy = e.clientY, touch = e.pointerType !== 'mouse';
    const base = { sx, sy, touch, moved: false, start: p };
    // 選到一筆時，任何工具都可以拖它的把手
    const hd = hitHandle(p);
    if (hd) { gesture = { ...base, kind: 'handle', h: hd, orig: S.clone(sel()) }; showLoupe(p, touch); return; }
    switch (tool) {
      case 'select': {
        const s = hitShape(p);
        if (s) {
          if (s.id !== selId) select(s.id);
          gesture = { ...base, kind: 'body', orig: S.clone(s), last: p };
          longTimer = setTimeout(() => { if (gesture && !gesture.moved) { gesture = null; openSelMenu(); } }, LONG_MS);
        } else { if (selId) select(null); gesture = { ...base, kind: 'pan', last: [sx, sy] }; }
        return;
      }
      case 'line': {
        if (variant.line === 'poly') { gesture = { ...base, kind: 'tap-add' }; showLoupe(p, touch); return; }
        const a = snapAt(p);
        gesture = { ...base, kind: 'line', a }; showLoupe(a, touch); return;
      }
      case 'free': gesture = { ...base, kind: 'free', raw: [p] }; return;
      case 'dot': gesture = { ...base, kind: 'tap' }; showLoupe(snapAt(p), touch); return;
      case 'shape': {
        const v = variant.shape;
        if (v === 'polyfill') { gesture = { ...base, kind: 'tap-add' }; showLoupe(p, touch); return; }
        if (v === 'fill') { gesture = { ...base, kind: 'tap' }; return; }
        if (v === 'lasso') { gesture = { ...base, kind: 'lasso', raw: [p] }; return; }
        if (v === 'angle') { const a = snapAt(p); gesture = { ...base, kind: 'angle', a }; showLoupe(a, touch); return; }
        gesture = { ...base, kind: 'box', a: p }; return;
      }
      case 'text': case 'icon': gesture = { ...base, kind: 'tap' }; return;
      case 'erase': pushHistory(); gesture = { ...base, kind: 'erase', pushed: true, hits: 0 }; eraseAt(p); return;
    }
  }
  function move(p, e) {
    const g = gesture;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > TAP_PX) { g.moved = true; clearTimeout(longTimer); }
    switch (g.kind) {
      case 'handle': {
        if (!g.moved) return;
        if (!g.pushed) { pushHistory(); g.pushed = true; }
        const s = sel(); dragHandle(s, g, p); syncPartner(s); renderShapes(); moveLoupe(liveSnap || p);
        return;
      }
      case 'body': {
        if (!g.moved) return;
        if (!g.pushed) { pushHistory(); g.pushed = true; }
        const s = sel(); const o = g.orig;
        const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
        s.pts = o.pts.map(q => [q[0] + dx, q[1] + dy]); if (o.m) s.m = [o.m[0] + dx, o.m[1] + dy];
        syncPartner(s); renderShapes(); return;
      }
      case 'line': {
        const b = snapAt(p, { from: g.a });
        g.b = b;
        const st = lineStyle(), ends = { a: styles.line.ends.a, b: variant.line === 'arrow' || variant.line === 'carrow' ? 'arrow' : styles.line.ends.b };
        gLive.innerHTML = S.dist(g.a, b) > 0.2 ? shapeSvg(S.newShape({ type: 'line', view, pts: [g.a, b], style: st, ends })) : '';
        gLive.firstChild && gLive.firstChild.setAttribute('opacity', '.8');
        moveLoupe(b); updateUi(); return;
      }
      case 'angle': {
        const b = snapAt(p, { from: g.a }); g.b = b;
        gLive.innerHTML = `<line x1="${g.a[0]}" y1="${g.a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${styles.line.color}" stroke-width="${styles.line.width}" stroke-linecap="round" opacity=".8"/>`;
        moveLoupe(b); updateUi(); return;
      }
      case 'free': case 'lasso': {
        g.raw.push(p);
        const st = g.kind === 'free' ? styles.free : styles.shape;
        gLive.innerHTML = `<polyline points="${g.raw.map(q => q[0].toFixed(2) + ',' + q[1].toFixed(2)).join(' ')}" fill="${g.kind === 'lasso' ? st.color : 'none'}" fill-opacity=".18" stroke="${st.color}" stroke-width="${st.width}" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>`;
        return;
      }
      case 'box': {
        const a = g.a, v = variant.shape; let rx = Math.abs(p[0] - a[0]) / 2, ry = Math.abs(p[1] - a[1]) / 2, c = S.mid(a, p);
        if (v === 'circle') { const r = Math.max(rx, ry); rx = ry = r; c = [a[0] + Math.sign(p[0] - a[0] || 1) * r, a[1] + Math.sign(p[1] - a[1] || 1) * r]; }
        g.ell = { c, rx, ry };
        gLive.innerHTML = rx > 0.3 ? shapeSvg(S.newShape({ type: 'ellipse', view, pts: [c], rx, ry, style: { ...shapeStyle(), fill: false } })) : '';
        return;
      }
      case 'tap': case 'tap-add': { const q = snapAt(p); moveLoupe(q); if (g.kind === 'tap-add' && draft) renderDraft(q); updateUi(); return; }
      case 'erase': eraseAt(p); return;
    }
  }
  function end(p, e) {
    const g = gesture; gesture = null; hideLoupe();
    const tap = !g.moved;
    switch (g.kind) {
      case 'handle': if (g.pushed) commit(); break;
      case 'body': if (g.pushed) commit(); break;
      case 'line': {
        gLive.innerHTML = '';
        const b = g.b || g.a;
        if (S.dist(g.a, b) < TAP_PX * pxMm()) { const s = hitShape(p); if (s) { setTool('select'); select(s.id); } break; }
        const v = variant.line, ends = { a: styles.line.ends.a, b: v === 'arrow' || v === 'carrow' ? 'arrow' : styles.line.ends.b };
        if (v === 'curve' || v === 'carrow') create(S.newShape({ type: 'curve', view, pts: [g.a, b], style: lineStyle(), ends }));
        else create(S.newShape({ type: 'line', view, pts: [g.a, b], style: lineStyle(), ends }));
        break;
      }
      case 'angle': {
        gLive.innerHTML = '';
        const b = g.b || g.a, L = S.dist(g.a, b);
        if (L < TAP_PX * pxMm()) break;
        const ang = Math.atan2(b[1] - g.a[1], b[0] - g.a[0]) - Math.PI / 4;
        create(S.newShape({ type: 'angle', view, pts: [g.a, b, [g.a[0] + L * Math.cos(ang), g.a[1] + L * Math.sin(ang)]], style: { color: styles.line.color, width: styles.line.width, dash: styles.line.dash } }));
        break;
      }
      case 'free': {
        gLive.innerHTML = '';
        const pts = S.tidyFree(g.raw, settings().smooth);
        if (pts.length < 2 || S.pathLength(pts) < TAP_PX * pxMm()) { if (tap) { const s = hitShape(p); if (s) { setTool('select'); select(s.id); } } break; }
        create(S.newShape({ type: 'free', view, pts, style: { color: styles.free.color, width: styles.free.width, dash: styles.free.dash }, ends: styles.free.ends }));
        break;
      }
      case 'lasso': {
        gLive.innerHTML = '';
        const pts = S.tidyFree(g.raw, 2);
        if (pts.length < 3 || S.pathLength(pts) < 12 * pxMm()) break;
        create(S.newShape({ type: 'region', view, pts, smooth: true, style: shapeStyle() }));
        break;
      }
      case 'box': {
        gLive.innerHTML = '';
        if (!g.ell || Math.max(g.ell.rx, g.ell.ry) < 2 * pxMm() * 3) break;
        create(S.newShape({ type: 'ellipse', view, pts: [g.ell.c], rx: g.ell.rx, ry: g.ell.ry, style: { ...shapeStyle(), fill: false } }));
        break;
      }
      case 'tap': {
        if (!tap && tool !== 'dot') break;
        const q = snapAt(p); clearSnap();
        if (tool === 'dot') create(S.newShape({ type: 'dot', view, pts: [q], r: styles.dot.r, mark: variant.dot, style: { color: styles.dot.color } }));
        else if (tool === 'text') askText(null, q);
        else if (tool === 'icon') create(S.newShape({ type: 'icon', view, pts: [q], icon: variant.icon, size: styles.icon.size, style: { color: styles.icon.color } }));
        else if (tool === 'shape' && variant.shape === 'fill') fillAt(p);
        break;
      }
      case 'tap-add': {
        const q = snapAt(p); clearSnap();
        const kind = tool === 'line' ? 'poly' : 'polyfill';
        if (!draft || draft.kind !== kind) draft = { kind, pts: [] };
        const last = draft.pts[draft.pts.length - 1];
        if (last && S.dist(last, q) < TAP_PX * pxMm()) { finishDraft(); break; } // 點在上一點上＝完成
        draft.pts.push(q); renderDraft(); syncDraftBar();
        break;
      }
      case 'erase': {
        eraserAt = e.pointerType === 'mouse' ? p : null;
        if (g.hits) commit(); else history.pop();
        app.changed();
        break;
      }
    }
    clearSnap(); updateUi();
  }
  // 拖把手
  function dragHandle(s, g, p) {
    const h = g.h, o = g.orig;
    switch (h.kind) {
      case 'pt': {
        const other = s.type === 'line' || s.type === 'curve' ? s.pts[h.i === 0 ? 1 : 0] : (s.type === 'angle' && h.i > 0 ? s.pts[0] : null);
        const q = snapAt(p, { exclude: [s.id, s.mirrorPairId], from: other });
        if (s.type === 'curve') { // 端點動，中間點跟著移一半，形狀比較不會跑掉
          const od = o.pts[h.i]; s.pts[h.i] = q; s.m = [o.m[0] + (q[0] - od[0]) / 2, o.m[1] + (q[1] - od[1]) / 2];
        } else s.pts[h.i] = q;
        moveLoupe(q); break;
      }
      case 'mid': { s.type = 'curve'; s.m = p; break; } // 直線拉中間＝變成曲線
      case 'm': s.m = p; break;
      case 'rx': case 'ry': {
        const c = s.pts[0], r = s.rot * Math.PI / 180, dx = p[0] - c[0], dy = p[1] - c[1];
        if (h.kind === 'rx') s.rx = Math.max(0.5, Math.abs(dx * Math.cos(r) + dy * Math.sin(r)));
        else s.ry = Math.max(0.5, Math.abs(-dx * Math.sin(r) + dy * Math.cos(r)));
        break;
      }
      case 'rot': {
        const c = s.pts[0]; let deg = Math.atan2(p[1] - c[1], p[0] - c[0]) * 180 / Math.PI;
        deg = s.type === 'ellipse' ? deg : deg + 90;
        if (settings().snap) { const k = Math.round(deg / 15) * 15; if (Math.abs(deg - k) < 4) deg = k; } // 每 15° 吸一下
        s.rot = ((deg + 540) % 360) - 180; break;
      }
      case 'scale': {
        const c = s.pts[0], d0 = S.dist(c, h.p) || 1, k = S.dist(c, p) / d0;
        if (s.type === 'text') s.size = Math.max(2, Math.min(120, o.size * k)); else s.size = Math.max(4, Math.min(200, o.size * k));
        break;
      }
    }
  }
  // 橡皮擦
  function eraseAt(p) {
    eraserAt = p;
    const r = ERASE_PX * pxMm();
    for (const s of inView(view).slice()) {
      if (S.hitDistance(s, p) > r) continue;
      if (variant.erase === 'part' && S.PATH_TYPES.includes(s.type)) {
        const runs = SN.eraseSplit(s, p, r); if (!runs) continue;
        const idx = shapes.indexOf(s); removeShape(s, false);
        const pieces = runs.map((run, i) => S.newShape({ type: 'poly', view, pts: S.simplify(run, 0.08), style: s.style, ends: { a: i === 0 ? s.ends.a : 'none', b: i === runs.length - 1 ? s.ends.b : 'none' }, label: i === 0 ? s.label : undefined }));
        shapes.splice(idx, 0, ...pieces);
      } else removeShape(s, false);
      gesture.hits++;
    }
    renderShapes();
  }
  // 點一下填滿：把這個視圖的線、頭的外框畫到格子上，從點的地方往外填
  function fillAt(p) {
    const G = 2, b = pageBox(view), W = Math.ceil(b.w * G), H = Math.ceil(b.h * G);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.setTransform(G, 0, 0, G, -b.x * G, -b.y * G);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 0.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const t = tpls[view];
    const poly = pts => { ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke(); };
    poly(t.outline.concat([t.outline[0]]));
    if (settings().hairline) for (const r of t.hairline) poly(r);
    for (const s of [...inView(view), ...belowIn(view)]) {
      if (!['line', 'curve', 'poly', 'free', 'region', 'ellipse', 'angle'].includes(s.type)) continue;
      ctx.lineWidth = Math.max(0.6, s.style.width); ctx.stroke(new Path2D(S.geom(s).d));
    }
    const data = ctx.getImageData(0, 0, W, H).data, wall = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) wall[i] = data[i * 4 + 3] > 60 ? 1 : 0;
    const x = Math.round((p[0] - b.x) * G), y = Math.round((p[1] - b.y) * G);
    const f = SN.flood(wall, W, H, x, y);
    if (!f.count) { toast('線の上をタップしました：線で囲まれた内側をタップしてください', 2000); return; }
    if (f.touchesEdge) { toast('ここは囲まれていません（紙全体が塗られます）：先に線で囲んでください', 2600); return; }
    const pts = SN.traceMask(SN.grow(f.mask, W, H, 1), W, H, 0.9).map(q => [b.x + q[0] / G, b.y + q[1] / G]);
    if (pts.length < 3) return;
    create(S.newShape({ type: 'region', view, pts, smooth: false, style: shapeStyle() }));
  }

  // ---------------------------------------------------------------- 放大鏡（手指按著時，在手指上方看放大的那一塊）
  function showLoupe(p, touch) { if (!touch || !settings().magnifier) return; loupe.hidden = false; moveLoupe(p); }
  function hideLoupe() { loupe.hidden = true; }
  function moveLoupe(p) {
    if (loupe.hidden) return;
    const m = svg.getScreenCTM(); if (!m) return;
    const r = one.getBoundingClientRect(), sp = new DOMPoint(p[0], p[1]).matrixTransform(m);
    const size = 120, k = 2.6, w = size * pxMm() / k;
    loupe.style.transform = `translate(${Math.round(sp.x - r.left - size / 2)}px, ${Math.round(Math.max(4, sp.y - r.top - size - 46))}px)`;
    loupeSvg.setAttribute('viewBox', [p[0] - w / 2, p[1] - w / 2, w, w].map(x => x.toFixed(2)).join(' '));
  }

  // ---------------------------------------------------------------- 工具列、樣式列、選取列
  function setTool(t) {
    if (t !== tool) cancelDraft();
    tool = t; if (t !== 'select' && selId) select(null);
    eraserAt = null; saveUI(); syncTools(); updateUi();
  }
  const familyOf = s => (s ? { line: 'line', curve: 'line', poly: 'line', angle: 'line', free: 'free', dot: 'dot', region: 'shape', ellipse: 'shape', text: 'text', icon: 'icon' }[s.type] : FAMILY[tool] || null);
  function syncTools() {
    document.querySelectorAll('#fl-tools [data-ftool]').forEach(b => b.classList.toggle('on', b.dataset.ftool === tool));
    svg.dataset.tool = tool;
    // 選項列：照工具換
    const box = $('#fl-variants');
    let list = null, cur = null, key = null;
    if (tool === 'line') { list = LINE_VARIANTS; cur = variant.line; key = 'line'; }
    else if (tool === 'shape') { list = SHAPE_VARIANTS; cur = variant.shape; key = 'shape'; }
    else if (tool === 'dot') { list = MARK_VARIANTS; cur = variant.dot; key = 'dot'; }
    else if (tool === 'erase') { list = ERASE_VARIANTS; cur = variant.erase; key = 'erase'; }
    else if (tool === 'free') { list = SMOOTH_VARIANTS; cur = settings().smooth; key = 'smooth'; }
    else if (tool === 'icon') { list = S.ICONS.map(i => [i, S.ICON_LABELS[i]]); cur = variant.icon; key = 'icon'; }
    box.innerHTML = list ? list.map(([v, label]) => `<button type="button" data-var="${key}:${v}" class="${String(v) === String(cur) ? 'on' : ''}">${key === 'icon' ? iconSvg(v) : variantIcon(key, v)}<span>${label}</span></button>`).join('') : '';
    box.classList.toggle('icons', key === 'icon');
    box.hidden = !list;
    const tip = tool === 'select' ? TOOL_TIPS.select : typeof TOOL_TIPS[tool] === 'string' ? TOOL_TIPS[tool] : (TOOL_TIPS[tool] || {})[cur];
    $('#fl-tip').textContent = layout === 'all' ? '一覧：描きたい方向をタップしてください。' : tip || '';
    $('#fl-snap').setAttribute('aria-pressed', String(!!settings().snap));
    $('#fl-mirror').setAttribute('aria-pressed', String(!!settings().mirror));
    syncStyleRow();
  }
  const iconSvg = id => `<svg viewBox="0 0 24 24" class="ico">${(ICON_PATHS[id] || []).map(([d, m]) => m === 'fill' ? `<path d="${d}" fill="currentColor" stroke="none"/>` : `<path d="${d}" fill="none"/>`).join('')}</svg>`;
  function variantIcon(key, v) {
    const p = {
      'line:line': 'M4 16L16 4', 'line:arrow': 'M4 16L15 5M9 5h6v6', 'line:curve': 'M4 16C5 8 10 5 16 4', 'line:carrow': 'M4 16C5 9 9 6 15 5M11 3.5L15.5 5 12 8.5', 'line:poly': 'M3 15l5-8 4 6 5-9',
      'shape:circle': 'M10 3.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13', 'shape:ellipse': 'M10 6c4.4 0 8 1.8 8 4s-3.6 4-8 4-8-1.8-8-4 3.6-4 8-4', 'shape:lasso': 'M5 6c3-3 9-3 11 0s0 8-4 9-8 0-9-3 0-4 2-6', 'shape:polyfill': 'M4 6l10-2 3 9-9 3z', 'shape:fill': 'M10 3v14M3 10h14M11 11h5v5h-5z', 'shape:angle': 'M4 16h12M4 16L13 6M8.5 16a4.5 4.5 0 0 0-1.3-3.2',
      'dot:fill': 'M10 6.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7', 'dot:ring': 'M10 6.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7', 'dot:cross': 'M10 5v10M5 10h10', 'dot:x': 'M6 6l8 8M14 6l-8 8',
      'erase:whole': 'M4 14l6-6 5 5-3 3H7zM9 16h8', 'erase:part': 'M3 10h4M13 10h4M8 7l4 6',
      'smooth:0': 'M3 13l3-5 2 4 3-6 2 5 4-4', 'smooth:1': 'M3 13c2-5 3-5 5-1s3-6 5-1 3-3 4-4', 'smooth:2': 'M3 13c3-6 5-6 7-2s4-5 7-3', 'smooth:3': 'M3 12c4-5 10-5 14 0',
    }[key + ':' + v] || '';
    return `<svg viewBox="0 0 20 20"><path d="${p}"${key === 'dot' && v === 'fill' ? ' fill="currentColor"' : ''}/></svg>`;
  }
  // 樣式列：顏色、實線／虛線／點線、粗細；選到一筆時改那一筆，沒選時改這個工具之後畫的樣式
  function activeStyle() {
    const s = sel(); if (s) return { from: 'shape', s, fam: familyOf(s) };
    const fam = familyOf(null); return fam ? { from: 'tool', fam, st: styles[fam] } : null;
  }
  function syncStyleRow() {
    const a = activeStyle(), row = $('#fl-stylerow');
    row.hidden = !a || mode !== 'draw' || layout === 'all';
    if (!a) return;
    const st = a.from === 'shape' ? { ...a.s.style, ends: a.s.ends, r: a.s.r, size: a.s.size } : a.st;
    $('#fl-color-btn').style.setProperty('--c', st.color);
    const lineish = ['line', 'free', 'shape'].includes(a.fam) && !(a.s && ['text', 'icon', 'dot'].includes(a.s.type));
    $('#fl-dash').hidden = !lineish; $('#fl-width').hidden = !lineish;
    document.querySelectorAll('#fl-dash [data-dash]').forEach(b => b.classList.toggle('on', b.dataset.dash === st.dash));
    document.querySelectorAll('#fl-width [data-w]').forEach(b => b.classList.toggle('on', Math.abs(+b.dataset.w - st.width) < 0.01));
    $('#fl-size').hidden = !['dot', 'text', 'icon'].includes(a.fam);
    $('#fl-size-v').textContent = a.fam === 'dot' ? (st.r * 2).toFixed(1) + ' mm' : a.fam ? Math.round(st.size) + ' mm' : '';
  }
  function applyStyle(patch) {
    const a = activeStyle(); if (!a) return;
    if (a.from === 'shape') {
      pushHistory();
      const s = a.s, st = { ...s.style, ...(patch.style || {}) };
      const o = { ...s, style: st };
      if (patch.ends) o.ends = { ...s.ends, ...patch.ends };
      for (const k of ['r', 'size', 'mark', 'bold', 'box', 'smooth']) if (patch[k] !== undefined) o[k] = patch[k];
      Object.assign(s, S.newShape(o));
      syncPartner(s); commit(); app.changed();
    } else {
      const st = styles[a.fam];
      Object.assign(st, patch.style || {});
      if (patch.ends) st.ends = { ...st.ends, ...patch.ends };
      for (const k of ['r', 'size', 'bold', 'box']) if (patch[k] !== undefined) st[k] = patch[k];
      saveUI();
    }
    syncStyleRow(); syncStylePop();
  }
  function stepSize(dir) {
    const a = activeStyle(); if (!a) return;
    const st = a.from === 'shape' ? a.s : a.st;
    if (a.fam === 'dot') { const r = Math.max(0.6, Math.min(12, (st.r || 2.4) * (dir > 0 ? 1.25 : 0.8))); applyStyle({ r }); }
    else if (a.fam === 'text') applyStyle({ size: Math.max(3, Math.min(60, Math.round((st.size || 9) + dir * (st.size >= 14 ? 2 : 1)))) });
    else if (a.fam === 'icon') applyStyle({ size: Math.max(6, Math.min(120, Math.round((st.size || 22) * (dir > 0 ? 1.2 : 1 / 1.2)))) });
  }
  function syncSel() {
    const s = sel(), bar = $('#fl-selbar');
    bar.hidden = !s || mode !== 'draw';
    $('#fl-optrow').hidden = !!s || mode !== 'draw';
    if (s) {
      $('#fl-sel-label').textContent = S.TYPE_LABELS[s.type] + (s.mirrorPairId ? '・ミラー' : '');
      $('#fl-sel-edit').hidden = s.type !== 'text';
      $('#fl-sel-reverse').hidden = !S.PATH_TYPES.includes(s.type) && s.type !== 'angle';
      $('#fl-sel-label-btn').classList.toggle('has', !!s.label);
      $('#fl-sel-unpair').hidden = !s.mirrorPairId;
    }
    syncStyleRow();
  }
  function openSelMenu() { const s = sel(); if (!s) return; togglePop('fl-selmore-pop', 'fl-sel-more'); }

  // 選取列的動作
  function duplicateSel() {
    const s = sel(); if (!s) return;
    pushHistory();
    const c = S.clone(s); c.id = S.newId(); delete c.mirrorPairId; delete c.origin;
    S.translate(c, 6, 6); shapes.push(c); commit(); select(c.id); app.changed();
  }
  function deleteSel() { const s = sel(); if (!s) return; pushHistory(); removeShape(s); commit(); syncSel(); app.changed(); }
  function transformSel(fn) { const s = sel(); if (!s) return; pushHistory(); fn(s); syncPartner(s); commit(); app.changed(); }
  // 同類樣式：這個視圖裡同一種的筆都換成選到這一筆的顏色（線類也換粗細與虛實）
  function styleAll() {
    const s = sel(); if (!s) return;
    const same = inView(view).filter(x => x.type === s.type && x !== s);
    if (!same.length) { toast('この方向にはほかの' + S.TYPE_LABELS[s.type] + 'がありません'); return; }
    pushHistory();
    for (const x of same) { x.style = { ...x.style, color: s.style.color, ...(S.PATH_TYPES.includes(s.type) || ['ellipse', 'region', 'angle'].includes(s.type) ? { width: s.style.width, dash: s.style.dash } : {}) }; if (s.type === 'dot') x.r = s.r; syncPartner(x); }
    commit(); app.changed(); toast('この方向の' + S.TYPE_LABELS[s.type] + '（' + (same.length + 1) + ' 個）をすべてこのスタイルにしました');
  }
  function zOrder(dir) {
    const s = sel(); if (!s) return;
    const i = shapes.indexOf(s), j = dir === 'top' ? shapes.length - 1 : dir === 'bottom' ? 0 : i + dir;
    if (j < 0 || j >= shapes.length || j === i) return;
    pushHistory(); shapes.splice(i, 1); shapes.splice(j, 0, s); commit(); app.changed();
  }
  function unpair() { const s = sel(); if (!s || !s.mirrorPairId) return; pushHistory(); const p = byId(s.mirrorPairId); if (p) delete p.mirrorPairId; delete s.mirrorPairId; commit(); toast('ミラーを解除：これからは左右を別々に変えます'); }

  // 完善線條：線端很近的接起來、靠近頭的外框或別的線的延長／縮短到剛好碰到
  function magic() {
    const s = sel();
    const targets = s ? [s] : inView(view).filter(x => S.PATH_TYPES.includes(x.type));
    if (!targets.length) { toast('この方向にはまだ線がありません'); return; }
    const before = snap();
    const n = SN.magicAlign(targets, inView(view).concat(belowIn(view)), refPaths(), pxMm());
    if (!n) { toast('近くに整えられる線の端がありません'); return; }
    history.push(before); future.length = 0;
    for (const x of targets) syncPartner(x);
    commit(); app.changed(); toast(n + ' か所の線の端を整えました');
  }
  // 整側鏡像：左側 → 右側（或反過來）；對稱的視圖：左半 → 右半
  function mirrorSide(dir) {
    pushHistory();
    let n = 0;
    if (view === 'left' || view === 'right') {
      const from = dir === 'to-other' ? view : mirrorView(view), to = mirrorView(from);
      shapes = shapes.filter(s => s.view !== to || false);
      for (const s of shapes.filter(x => x.view === from)) { const m = mirroredOf(s); m.id = S.newId(); s.mirrorPairId = m.id; m.mirrorPairId = s.id; shapes.push(m); n++; }
      for (const s of shapes) if (s.mirrorPairId && !byId(s.mirrorPairId)) delete s.mirrorPairId;
      toast(viewById(from).label + 'の ' + n + ' 個を' + viewById(to).label + 'にミラーしました（' + viewById(to).label + 'の元の線は置き換えました）', 3200);
    } else {
      const keepLeft = dir === 'l2r', side = s => S.center(s)[0];
      // 畫面左半邊＝x<0
      shapes = shapes.filter(s => s.view !== view || (keepLeft ? side(s) <= 0.5 : side(s) >= -0.5));
      for (const s of shapes.filter(x => x.view === view && (keepLeft ? side(x) < -0.5 : side(x) > 0.5))) { const m = mirroredOf(s); m.id = S.newId(); s.mirrorPairId = m.id; m.mirrorPairId = s.id; shapes.push(m); n++; }
      for (const s of shapes) if (s.mirrorPairId && !byId(s.mirrorPairId)) delete s.mirrorPairId;
      toast((keepLeft ? '左半分' : '右半分') + 'の ' + n + ' 個をもう半分へミラーしました（もう半分の元の線は置き換えました）', 3200);
    }
    selId = null; commit(); app.changed();
  }
  // 分區樣板：照頭模的點位畫出分線（和 3D 同一套），投影到這個視圖（只留看得到的段）
  function addTemplate(key, everyView) {
    const sc = head.scalp, lms = head.landmarks;
    let specs;
    try { specs = TPL.templateLines(sc, lms, key, null); } catch (e) { toast(TPL.TEMPLATE_LABELS[key] + 'が描けません：' + e.message); return; }
    const dense3 = specs.map(sp => {
      if (sp.shape === 'line' && sp.section) return SEC.sectionDense(sc, sp.section, sp.points[0], sp.points[1]) || SEC.sectionBridged(sc, sp.section, sp.points[0], sp.points[1]) || sc.line(sp.points[0], sp.points[1]);
      if (sp.shape === 'curve') return sc.curveWithBends(sp.points, []);
      return sc.line(sp.points[0], sp.points[1]);
    });
    const views = everyView ? VIEW_IDS : [view];
    pushHistory();
    let n = 0;
    for (const v of views) for (const d of dense3) for (const run of tpls[v].runs(d)) {
      const pts = S.simplify(run, 0.25); if (pts.length < 2 || S.pathLength(pts) < 4) continue;
      shapes.push(S.newShape({ type: pts.length === 2 ? 'line' : 'poly', view: v, pts, style: { color: styles.line.color, width: styles.line.width, dash: styles.line.dash } })); n++;
    }
    if (!n) { history.pop(); toast(TPL.TEMPLATE_LABELS[key] + 'はこの方向からは見えません'); return; }
    commit(); app.changed(); toast(TPL.TEMPLATE_LABELS[key] + 'を描きました（' + n + ' 本。直すときは「選択」）', 2600);
  }

  // ---------------------------------------------------------------- 文字、標字
  let textTarget = null; // { id }（改字）或 { at }（新的）
  function askText(id, at) {
    textTarget = id ? { id } : { at };
    const s = id ? byId(id) : null;
    $('#fl-text-input').value = s ? s.text : '';
    $('#fl-text-bold').setAttribute('aria-pressed', String(s ? s.bold : styles.text.bold));
    $('#fl-text-box').setAttribute('aria-pressed', String(s ? s.box : styles.text.box));
    openPop('fl-text-pop');
    setTimeout(() => $('#fl-text-input').focus(), 30);
  }
  function textDone() {
    const t = S.cleanText($('#fl-text-input').value, S.TEXT_MAX).trim();
    const bold = $('#fl-text-bold').getAttribute('aria-pressed') === 'true', box = $('#fl-text-box').getAttribute('aria-pressed') === 'true';
    closePops();
    if (!textTarget) return;
    if (textTarget.id) {
      const s = byId(textTarget.id); if (!s) return;
      pushHistory();
      if (!t) { removeShape(s); commit(); syncSel(); return; }
      s.text = t; s.bold = bold; s.box = box; syncPartner(s); commit();
    } else if (t) {
      styles.text.bold = bold; styles.text.box = box; saveUI();
      create(S.newShape({ type: 'text', view, pts: [textTarget.at], text: t, size: styles.text.size, bold, box, style: { color: styles.text.color } }));
    }
    textTarget = null;
  }
  function setLabel(t) {
    const s = sel(); if (!s) return;
    const v = S.cleanLabel(t); if ((s.label || '') === v) return;
    pushHistory(); if (v) s.label = v; else delete s.label;
    syncPartner(s); commit();
  }

  // ---------------------------------------------------------------- 浮動選單
  const POPS = ['fl-style-pop', 'fl-text-pop', 'fl-label-pop', 'fl-view-pop', 'fl-eye-pop', 'fl-selmore-pop'];
  const POP_BTN = { 'fl-style-pop': 'fl-color-btn', 'fl-view-pop': 'fl-more', 'fl-eye-pop': 'eye-btn', 'fl-label-pop': 'fl-sel-label-btn', 'fl-selmore-pop': 'fl-sel-more' };
  function closePops() {
    for (const id of POPS) { const el = document.getElementById(id); if (el) el.hidden = true; }
    for (const b of Object.values(POP_BTN)) { const el = document.getElementById(b); if (el) el.setAttribute('aria-expanded', 'false'); }
  }
  function openPop(id) { closePops(); document.getElementById(id).hidden = false; const b = POP_BTN[id] && document.getElementById(POP_BTN[id]); if (b) b.setAttribute('aria-expanded', 'true'); }
  function togglePop(id) { const open = document.getElementById(id).hidden; closePops(); if (open) { openPop(id); if (id === 'fl-style-pop') syncStylePop(); if (id === 'fl-eye-pop') syncEye(); if (id === 'fl-view-pop') syncViewPop(); } }
  document.addEventListener('pointerdown', e => {
    if (!drawing || e.target.closest('.pop') || e.target.closest('#eye-btn, #fl-color-btn, #fl-more, #fl-sel-label-btn, #fl-sel-more')) return;
    if (POPS.some(id => !document.getElementById(id).hidden)) closePops();
  }, true);
  function syncStylePop() {
    const a = activeStyle(); if (!a) return;
    const st = a.from === 'shape' ? { ...a.s.style, ends: a.s.ends } : a.st;
    document.querySelectorAll('#fl-swatches [data-color]').forEach(b => b.classList.toggle('on', b.dataset.color.toLowerCase() === st.color.toLowerCase()));
    const pathy = a.fam === 'line' || a.fam === 'free';
    $('#fl-ends').hidden = !(pathy && (!a.s || S.PATH_TYPES.includes(a.s.type)));
    if (st.ends) for (const k of ['a', 'b']) document.querySelectorAll(`#fl-end-${k} [data-end]`).forEach(b => b.classList.toggle('on', b.dataset.end === st.ends[k]));
    $('#fl-opacity-row').hidden = a.fam !== 'shape';
    if (a.fam === 'shape') { $('#fl-opacity').value = Math.round((st.opacity ?? 0.35) * 100); $('#fl-opacity-v').textContent = Math.round((st.opacity ?? 0.35) * 100) + '%'; }
    $('#fl-fill-row').hidden = !(a.s && a.s.type === 'ellipse');
    if (a.s && a.s.type === 'ellipse') $('#fl-fill-row').setAttribute('aria-pressed', String(!!a.s.style.fill));
  }
  function syncEye() {
    const st = settings();
    for (const [id, k] of [['fl-tgl-hairline', 'hairline'], ['fl-tgl-names', 'labels'], ['fl-tgl-structure', 'structure'], ['fl-tgl-shade', 'shade'], ['fl-tgl-ghost', 'ghost'], ['fl-tgl-guides', 'guides'], ['fl-tgl-magnifier', 'magnifier']]) $('#' + id).setAttribute('aria-pressed', String(!!st[k]));
    document.querySelectorAll('#fl-grid-seg [data-grid]').forEach(b => b.classList.toggle('on', b.dataset.grid === st.grid));
    $('#fl-struct').setAttribute('aria-pressed', String(!!st.structure));
  }
  function setSetting(k, v) { settings()[k] = v; app.saved(); syncEye(); syncTools(); renderAll(); if (mode === 'preview') drawFrame(); }
  function syncViewPop() {
    const side = view === 'left' || view === 'right';
    $('#fl-ms-a').textContent = side ? viewById(view).label + ' → ' + viewById(mirrorView(view)).label : '左半分 → 右半分';
    $('#fl-ms-b').textContent = side ? viewById(mirrorView(view)).label + ' → ' + viewById(view).label : '右半分 → 左半分';
    $('#fl-vnote').value = (drawing.viewNotes || {})[view] || '';
    $('#fl-back-clear').hidden = !backs[view];
    $('#fl-vp-title').textContent = viewById(view).label;
  }

  // ---------------------------------------------------------------- 預覽：動畫
  let play = null; // { tl, frame, raf, playing, scope }
  function resizeCanvas() {
    const r = root.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round((r.height - ($('#fl-player').offsetHeight || 0)) * dpr));
    canvas.style.height = (canvas.height / dpr) + 'px';
  }
  function stepShapesAt(j) { try { return L.stepShapes(drawing.steps[j]); } catch { return []; } }
  const visibleViews = () => (layout === 'all' ? VIEW_IDS : [view]);
  // 這一步的動畫（前面的步驟直接畫好）；scope＝'all' 從第一步播到最後
  function makePlay(scope) {
    const vs = new Set(visibleViews()), stepsList = [];
    const from = scope === 'all' ? 0 : stepIdx, to = scope === 'all' ? drawing.steps.length - 1 : stepIdx;
    for (let j = from; j <= to; j++) stepsList.push(stepShapesAt(j).filter(s => vs.has(s.view)));
    const tl = AN.timeline(stepsList, settings().speed);
    const done = []; for (let j = 0; j < from; j++) done.push(...stepShapesAt(j));
    return { tl, done, anim: stepsList.flat(), frame: 0, playing: true, scope };
  }
  function playStep(scope = 'step') {
    stopPlay(); if (!drawing || mode !== 'preview') return;
    resizeCanvas();
    play = makePlay(scope);
    syncPlayer();
    let last = performance.now();
    const tick = now => {
      if (!play || !play.playing) return;
      play.frame += (now - last) / (1000 / AN.FPS); last = now;
      if (play.frame >= play.tl.frames) { play.frame = play.tl.frames; play.playing = false; syncPlayer(); }
      drawFrame();
      if (play.playing) play.raf = requestAnimationFrame(tick);
    };
    play.raf = requestAnimationFrame(tick);
  }
  function stopPlay() { if (play && play.raf) cancelAnimationFrame(play.raf); if (play) play.playing = false; syncPlayer(); }
  function syncPlayer() {
    const p = $('#fl-play');
    if (!p) return;
    p.setAttribute('aria-label', play && play.playing ? '一時停止' : '再生');
    p.querySelector('use').setAttribute('href', play && play.playing ? '#i-pause' : '#i-play');
    document.querySelectorAll('#fl-speed [data-speed]').forEach(b => b.classList.toggle('on', b.dataset.speed === settings().speed));
  }
  // 版面：單一視圖整張；總覽＝五個視圖排兩列（上：左、頂、右；下：正、背）
  function sheetCells(W, H, pad) {
    const k = Math.min((W - pad * 4) / (PAGE.w * 3), (H - pad * 3) / (PAGE.h * 2));
    const cw = PAGE.w * k, ch = PAGE.h * k, ox = (W - (cw * 3 + pad * 2)) / 2, oy = (H - (ch * 2 + pad)) / 2;
    const at = (c, r) => ({ x: ox + c * (cw + pad), y: oy + r * (ch + pad), w: cw, h: ch, k });
    return { left: at(0, 0), top: at(1, 0), right: at(2, 0), front: at(0.5, 1), back: at(1.5, 1), k };
  }
  function drawLayout(ctx, W, H, views, shapesFor, progress, opt = {}) {
    ctx.fillStyle = opt.bg || '#F4F5F7'; ctx.fillRect(0, 0, W, H);
    const cells = views.length === 1 ? { [views[0]]: (() => { const k = Math.min(W / PAGE.w, H / PAGE.h); return { x: (W - PAGE.w * k) / 2, y: (H - PAGE.h * k) / 2, w: PAGE.w * k, h: PAGE.h * k, k }; })() } : sheetCells(W, H, opt.pad || Math.round(W * 0.012));
    for (const v of views) {
      const c = cells[v], b = pageBox(v);
      ctx.save();
      ctx.beginPath(); ctx.rect(c.x, c.y, c.w, c.h); ctx.clip();
      ctx.setTransform(c.k * (opt.scale || 1), 0, 0, c.k * (opt.scale || 1), (c.x - b.x * c.k) * (opt.scale || 1), (c.y - b.y * c.k) * (opt.scale || 1));
      drawView(ctx, tpls[v], shapesFor(v), { ...bgOpt(v), points: false, names: false }, { progress, back: backs[v] ? backs[v].img : null });
      ctx.restore();
      if (views.length > 1 && opt.labels !== false) { ctx.save(); ctx.fillStyle = '#7A8089'; ctx.font = `600 ${Math.round(c.w * 0.045)}px system-ui, sans-serif`; ctx.fillText(viewById(v).label, c.x + c.w * 0.04, c.y + c.w * 0.07); ctx.restore(); }
    }
  }
  function drawFrame() {
    if (!drawing || !tpls || mode !== 'preview') return;
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const p = play || makePlay('step');
    if (!play) p.frame = p.tl.frames;
    const progress = AN.progressAt(p.tl, p.frame);
    for (const [k, v] of progress) progress.set(k, AN.ease(v));
    const list = p.done.concat(p.anim);
    drawLayout(ctx, W, H, visibleViews(), v => list.filter(s => s.view === v), progress, { pad: Math.round(W * 0.015) });
  }

  // ---------------------------------------------------------------- 輸出
  const allUpTo = j => { const out = []; for (let i = 0; i <= j; i++) out.push(...stepShapesAt(i)); return out; };
  const canvasBlob = (c, type = 'image/png', q) => new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('画像を作れません'))), type, q));
  function renderCanvas(W, H, views, list, opt = {}) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    drawLayout(c.getContext('2d'), W, H, views, v => list.filter(s => s.view === v), null, { bg: '#fff', ...opt });
    return c;
  }
  function title() { return drawing.title + '　' + L.stepLabel(stepIdx) + ' ' + L.stepName(drawing, stepIdx); }
  function stampTitle(c, text, sub = '') {
    const ctx = c.getContext('2d'), s = Math.round(c.width * 0.022);
    ctx.save(); ctx.fillStyle = '#363B49'; ctx.font = `650 ${s}px system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif`; ctx.fillText(text, s, s * 1.6);
    if (sub) { ctx.fillStyle = '#7A8089'; ctx.font = `500 ${Math.round(s * 0.72)}px system-ui, sans-serif`; ctx.fillText(sub, s, s * 2.7); }
    ctx.restore();
  }
  // 預覽的「儲存照片」：總覽＝五視圖總表，單一視圖＝這個視圖（都畫到這一步為止、白底）
  async function photo() {
    if (layout === 'all') return { blob: await canvasBlob(await sheetCanvas()), name: name('5方向', 'png') };
    return { blob: await viewPng(), name: name(viewById(view).label, 'png') };
  }
  async function viewPng(v = view, W = 1600) { const H = Math.round(W * PAGE.h / PAGE.w); return canvasBlob(renderCanvas(W, H, [v], allUpTo(stepIdx))); }
  async function sheetCanvas(W = 2400) {
    const H = Math.round(W * 0.84), c = renderCanvas(W, H, VIEW_IDS, allUpTo(stepIdx), { pad: Math.round(W * 0.012) });
    stampTitle(c, title(), headLine());
    return c;
  }
  const headLine = () => (head && head.model ? head.model.label + '（' + head.model.sub + '）' : '');
  const name = (suffix, ext) => 'カット図_' + app.fileSafe(drawing.title) + '_' + L.stepLabel(stepIdx) + (suffix ? '_' + suffix : '') + '_' + app.stamp() + '.' + ext;
  async function output(kind) {
    if (!drawing) return;
    try {
      if (kind === 'png-view') { app.downloadBlob(await viewPng(), name(viewById(view).label, 'png')); toast('「' + viewById(view).label + '」の PNG をダウンロードしました'); }
      else if (kind === 'share-view') app.shareBlob(await viewPng(), name(viewById(view).label, 'png'), drawing.title);
      else if (kind === 'png-sheet') { app.downloadBlob(await canvasBlob(await sheetCanvas()), name('5方向', 'png')); toast('5方向まとめ PNG を作りました'); }
      else if (kind === 'pdf') { toast('PDF を作成中…', 1500); app.downloadBlob(await makePdf(), name('', 'pdf')); toast('PDF を作りました'); }
      else if (kind === 'video') await recordVideo();
      else if (kind === 'carousel') { toast('カルーセル画像を作成中…', 1500); app.downloadBlob(await makeCarousel(), name('カルーセル', 'zip')); toast('SNS用カルーセル画像を作りました（ZIP・1080×1350）', 3000); }
    } catch (e) { toast('書き出しできませんでした：' + (e && e.message || e), 4000); }
  }
  async function jpegPage(c, pw) { const b = await canvasBlob(c, 'image/jpeg', 0.9); return { jpeg: new Uint8Array(await b.arrayBuffer()), w: c.width, h: c.height, pw, ph: Math.round(pw * c.height / c.width) }; }
  // 文字頁（筆記）：canvas 畫字，自動換行
  function notesCanvas(heading, lines, W = 1240, H = 1754) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    let y = 110; ctx.fillStyle = '#363B49'; ctx.font = '650 44px system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif'; ctx.fillText(heading, 90, y); y += 60;
    for (const [k, text] of lines) {
      if (!text) continue;
      y += 30; ctx.fillStyle = '#7A8089'; ctx.font = '600 28px system-ui, sans-serif'; ctx.fillText(k, 90, y); y += 44;
      ctx.fillStyle = '#363B49'; ctx.font = '400 30px system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif';
      for (const para of text.split('\n')) {
        let line = '';
        for (const ch of para) { if (ctx.measureText(line + ch).width > W - 180) { ctx.fillText(line, 90, y); y += 44; line = ''; } line += ch; }
        ctx.fillText(line, 90, y); y += 44;
        if (y > H - 80) return c;
      }
    }
    return c;
  }
  async function makePdf() {
    const pages = [await jpegPage(await sheetCanvas(2400), 842)];
    const list = allUpTo(stepIdx);
    for (const v of VIEW_IDS) {
      if (!list.some(s => s.view === v) && !(drawing.viewNotes || {})[v]) continue;
      const c = renderCanvas(1240, Math.round(1240 * PAGE.h / PAGE.w), [v], list);
      stampTitle(c, viewById(v).label, drawing.title);
      pages.push(await jpegPage(c, 595));
    }
    const notes = [['全体のメモ', drawing.note || ''], ...VIEW_IDS.map(v => [viewById(v).label, (drawing.viewNotes || {})[v] || ''])];
    const steps = drawing.steps.map((s, i) => L.stepLabel(i) + '　' + L.stepName(drawing, i)).join('\n');
    pages.push(await jpegPage(notesCanvas(drawing.title, [['ステップ', steps], ['ヘッド', headLine()], ...notes]), 595));
    // 照片：一頁最多四張
    const ids = drawing.photos || [];
    for (let i = 0; i < ids.length; i += 4) {
      const c = document.createElement('canvas'); c.width = 1240; c.height = 1754;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      const imgs = [];
      for (const id of ids.slice(i, i + 4)) { const b = await media.get(id).catch(() => null); if (b) imgs.push(await loadImage(b)); }
      imgs.forEach((img, k) => { const cx = 60 + (k % 2) * 580, cy = 80 + Math.floor(k / 2) * 820, s = Math.min(560 / img.width, 800 / img.height); ctx.drawImage(img, cx + (560 - img.width * s) / 2, cy + (800 - img.height * s) / 2, img.width * s, img.height * s); });
      pages.push(await jpegPage(c, 595));
    }
    return buildPdf(pages, drawing.title);
  }
  async function makeCarousel() {
    const files = [], W = 1080, H = 1350, enc = async c => new Uint8Array(await (await canvasBlob(c)).arrayBuffer());
    const list = allUpTo(drawing.steps.length - 1);
    { // 封面：標題＋五視圖
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      drawLayout(ctx, W, H * 0.8, VIEW_IDS, v => list.filter(s => s.view === v), null, { bg: '#fff' });
      ctx.fillStyle = '#363B49'; ctx.font = '700 64px system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif'; ctx.fillText(drawing.title, 60, H * 0.88);
      ctx.fillStyle = '#7A8089'; ctx.font = '500 34px system-ui, sans-serif'; ctx.fillText(drawing.steps.length + ' ステップ・' + headLine(), 60, H * 0.88 + 56);
      files.push({ name: '01_表紙.png', data: await enc(c) });
    }
    let n = 2;
    for (let j = 0; j < drawing.steps.length; j++) {
      const upTo = allUpTo(j), mine = stepShapesAt(j);
      for (const v of VIEW_IDS) {
        if (!mine.some(s => s.view === v)) continue;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        drawLayout(c.getContext('2d'), W, H, [v], vv => upTo.filter(s => s.view === vv), null, { bg: '#fff' });
        stampTitle(c, L.stepLabel(j) + ' ' + L.stepName(drawing, j), viewById(v).label);
        files.push({ name: String(n++).padStart(2, '0') + '_' + L.stepLabel(j) + '_' + viewById(v).label + '.png', data: await enc(c) });
      }
    }
    return buildZip(files);
  }
  // 動畫影片：照現在的版面（單一視圖或總覽），從第一步播到最後一步，錄成影片
  async function recordVideo() {
    if (!window.MediaRecorder) { toast('このブラウザでは動画を録画できません'); return; }
    const single = layout !== 'all', W = single ? 1080 : 1600, H = single ? Math.round(1080 * PAGE.h / PAGE.w / 2) * 2 : 1200;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d'), views = visibleViews();
    const p = makePlay('all');
    const types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    const type = types.find(t => MediaRecorder.isTypeSupported(t));
    if (!type) { toast('このブラウザでは動画を録画できません'); return; }
    const stream = c.captureStream(AN.FPS), rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12e6 }), chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise(res => { rec.onstop = res; });
    const list = p.done.concat(p.anim);
    const frame = f => { const pr = AN.progressAt(p.tl, f); for (const [k, v] of pr) pr.set(k, AN.ease(v)); drawLayout(ctx, W, H, views, v => list.filter(s => s.view === v), pr, { bg: '#fff' }); };
    frame(0);
    rec.start();
    toast('録画中（' + Math.ceil(p.tl.frames / AN.FPS) + ' 秒）…', p.tl.frames / AN.FPS * 1000);
    const t0 = performance.now();
    await new Promise(res => { const tick = () => { const f = (performance.now() - t0) / (1000 / AN.FPS); frame(Math.min(f, p.tl.frames)); if (f >= p.tl.frames + 4) res(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    rec.stop(); await done;
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    app.downloadBlob(new Blob(chunks, { type: type.split(';')[0] }), name('アニメーション', ext));
    toast('アニメーション動画を作りました（' + ext.toUpperCase() + '）');
  }
  // 首頁縮圖：五視圖總表的小圖
  async function thumbnail() {
    if (!drawing || !tpls) return null;
    const list = allUpTo(drawing.steps.length - 1);
    const c = document.createElement('canvas'); c.width = 240; c.height = 200;
    drawLayout(c.getContext('2d'), 240, 200, VIEW_IDS, v => list.filter(s => s.view === v), null, { bg: '#fff', pad: 4, labels: false });
    return canvasBlob(c, 'image/jpeg', 0.82);
  }

  // ---------------------------------------------------------------- 換頭模：每個視圖用兩顆頭的點位與外框對照，平面變形
  function correspondence(a, b) {
    const src = [], dst = [];
    for (const p of a.points) { const q = b.points.find(x => x.id === p.id && x.side === p.side); if (q) { src.push(p.p); dst.push(q.p); } }
    const ring = (t, ang) => { // 外框上，從頭心往 ang 方向最遠的交點
      const o = [0, viewById(t.view).cy]; // 頭（臉、後腦）中間附近，一定在外框裡面
      let best = null;
      for (let i = 0; i < t.outline.length; i++) {
        const p = t.outline[i], q = t.outline[(i + 1) % t.outline.length], dx = Math.cos(ang), dy = Math.sin(ang);
        const ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
        const tt = ((p[0] - o[0]) * ey - (p[1] - o[1]) * ex) / den, u = ((p[0] - o[0]) * dy - (p[1] - o[1]) * dx) / den;
        if (tt > 0 && u >= 0 && u <= 1 && (!best || tt > best)) best = tt;
      }
      return best ? [o[0] + Math.cos(ang) * best, o[1] + Math.sin(ang) * best] : null;
    };
    for (let k = 0; k < 36; k++) { const ang = k / 36 * Math.PI * 2, p = ring(a, ang), q = ring(b, ang); if (p && q) { src.push(p); dst.push(q); } }
    return { src, dst };
  }
  // 每一筆記得原本畫在哪顆頭上（origin）：永遠從原本那顆頭換算到新的頭，換來換去不會越換越歪
  async function switchHead(newHead, fromId) {
    const newT = await templatesFor(app.THREE, app.renderer, newHead);
    const tplOf = new Map([[fromId, tpls], [newHead.id, newT]]), warpsFrom = new Map();
    const warpsOf = async src => {
      if (warpsFrom.has(src)) return warpsFrom.get(src);
      let t = tplOf.get(src) || null;
      if (!t) { try { t = await templatesFor(app.THREE, app.renderer, await app.prepareHead(src)); } catch { t = null; } }
      const w = {};
      for (const v of VIEW_IDS) { const c = t ? correspondence(t[v], newT[v]) : null; w[v] = c && c.src.length >= 6 ? fitWarp(c.src, c.dst) : null; }
      warpsFrom.set(src, w);
      return w;
    };
    let n = 0;
    for (const st of drawing.steps) {
      const list = L.stepShapes(st);
      for (const s of list) {
        let keep = s.origin && s.origin.sig === S.shapeSig(s) ? s.origin : null;
        if (keep && keep.head === newHead.id) { s.pts = keep.pts.map(p => p.slice()); if (keep.m) s.m = keep.m.slice(); delete s.origin; n++; continue; }
        let w = keep ? (await warpsOf(keep.head))[s.view] : null;
        if (!w) { keep = null; w = (await warpsOf(fromId))[s.view]; } // 原本那顆頭的資料讀不到：照現在的位置搬
        if (!w) continue;
        const srcPts = keep ? keep.pts : s.pts, srcM = keep ? keep.m : s.m, srcHead = keep ? keep.head : fromId;
        s.pts = srcPts.map(p => w(p)); if (srcM) s.m = w(srcM);
        s.origin = { head: srcHead, pts: srcPts.map(p => p.slice()), ...(srcM ? { m: srcM.slice() } : {}), sig: '' };
        s.origin.sig = S.shapeSig({ pts: s.pts, m: s.m });
        n++;
      }
      L.storeStepShapes(st, list);
    }
    head = newHead; tpls = newT;
    return n;
  }

  // ---------------------------------------------------------------- 按鍵
  function keydown(e) {
    if (mode === 'preview') {
      if (e.key === ' ') { e.preventDefault(); if (play && play.playing) stopPlay(); else playStep(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); app.goStep(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); app.goStep(-1); }
      else if (e.key === 'Escape') document.getElementById('preview-edit').click();
      return;
    }
    if (mode !== 'draw') return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'd') { e.preventDefault(); duplicateSel(); return; }
    if (e.key === 'Escape') { if (POPS.some(id => !document.getElementById(id).hidden)) closePops(); else if (draft) cancelDraft(); else select(null); return; }
    if (e.key === 'Enter' && draft) { finishDraft(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel()) { e.preventDefault(); deleteSel(); return; }
    if (e.key.startsWith('Arrow') && sel()) {
      e.preventDefault(); const d = e.shiftKey ? 5 : 0.5;
      transformSel(s => S.translate(s, e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0));
      return;
    }
    const keys = { v: 'select', l: 'line', p: 'free', d: 'dot', s: 'shape', t: 'text', i: 'icon', e: 'erase' };
    if (!mod && keys[k]) setTool(keys[k]);
    else if (!mod && k >= '1' && k <= '5') setView(VIEW_IDS[+k - 1]);
    else if (!mod && k === '0') setLayout(layout === 'all' ? 'one' : 'all');
  }

  // ---------------------------------------------------------------- 介面接線
  document.querySelectorAll('#fl-tools [data-ftool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.ftool)));
  $('#fl-variants').addEventListener('click', e => {
    const b = e.target.closest('[data-var]'); if (!b) return;
    const [k, v] = b.dataset.var.split(':');
    if (k === 'smooth') { settings().smooth = +v; app.saved(); } else variant[k] = v;
    cancelDraft(); saveUI(); syncTools();
  });
  grid.addEventListener('click', e => { const c = e.target.closest('[data-view]'); if (c) setView(c.dataset.view); });
  $('#fl-tabs').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (!b) return; if (mode === 'preview') { view = b.dataset.view; layout = 'one'; saveUI(); syncLayout(); playStep(); } else setView(b.dataset.view); });
  $('#fl-layout').addEventListener('click', () => { setLayout(layout === 'all' ? 'one' : 'all'); if (mode === 'preview') playStep(); });
  $('#fl-fit').addEventListener('click', fit);
  $('#fl-more').addEventListener('click', () => togglePop('fl-view-pop'));
  $('#fl-snap').addEventListener('click', () => { setSetting('snap', !settings().snap); toast(settings().snap ? 'スナップオン：ポイント・線の端・頭の外枠・向き' : 'スナップオフ', 1500); });
  $('#fl-mirror').addEventListener('click', () => { setSetting('mirror', !settings().mirror); toast(settings().mirror ? 'ミラーオン：' + (isSymmetric(view) ? '片側に描くと反対側にも自動で描きます' : viewById(view).label + 'に描くと' + viewById(mirrorView(view)).label + 'にも自動で描きます') : 'ミラーオフ', 1800); });
  $('#fl-magic').addEventListener('click', magic);
  $('#fl-draft-done').addEventListener('click', finishDraft);
  $('#fl-draft-cancel').addEventListener('click', cancelDraft);
  // 樣式
  $('#fl-color-btn').addEventListener('click', () => togglePop('fl-style-pop'));
  document.querySelectorAll('#fl-dash [data-dash]').forEach(b => b.addEventListener('click', () => applyStyle({ style: { dash: b.dataset.dash } })));
  document.querySelectorAll('#fl-width [data-w]').forEach(b => b.addEventListener('click', () => applyStyle({ style: { width: +b.dataset.w } })));
  $('#fl-size-dec').addEventListener('click', () => stepSize(-1)); $('#fl-size-inc').addEventListener('click', () => stepSize(1));
  $('#fl-swatches').innerHTML = S.COLORS.map(c => `<button type="button" class="sw" data-color="${c}" style="--sw:${c}" aria-label="色 ${c}"></button>`).join('') + '<label class="sw custom" style="--sw:#7A8089"><svg aria-hidden="true"><use href="#i-plus"/></svg><input type="color" id="fl-color-input" value="#7A8089" aria-label="自分で色を選ぶ"></label>';
  $('#fl-swatches').addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (b) applyStyle({ style: { color: b.dataset.color } }); });
  $('#fl-color-input').addEventListener('change', e => applyStyle({ style: { color: e.target.value.toUpperCase() } }));
  for (const k of ['a', 'b']) document.querySelectorAll(`#fl-end-${k} [data-end]`).forEach(b => b.addEventListener('click', () => applyStyle({ ends: { [k]: b.dataset.end } })));
  $('#fl-opacity').addEventListener('change', e => applyStyle({ style: { opacity: +e.target.value / 100 } }));
  $('#fl-opacity').addEventListener('input', e => { $('#fl-opacity-v').textContent = e.target.value + '%'; });
  $('#fl-fill-row').addEventListener('click', () => { const s = sel(); if (s && s.type === 'ellipse') applyStyle({ style: { fill: !s.style.fill } }); });
  // 選取列
  $('#fl-sel-close').addEventListener('click', () => select(null));
  $('#fl-sel-delete').addEventListener('click', deleteSel);
  $('#fl-sel-dup').addEventListener('click', duplicateSel);
  $('#fl-sel-reverse').addEventListener('click', () => transformSel(S.reverse));
  $('#fl-sel-flip').addEventListener('click', () => transformSel(s => S.flipLocal(s, 'h')));
  $('#fl-sel-edit').addEventListener('click', () => { const s = sel(); if (s) askText(s.id); });
  $('#fl-sel-more').addEventListener('click', () => togglePop('fl-selmore-pop'));
  $('#fl-sm-flipv').addEventListener('click', () => { closePops(); transformSel(s => S.flipLocal(s, 'v')); });
  $('#fl-sm-rot').addEventListener('click', () => { closePops(); transformSel(s => S.rotate(s, 15)); });
  $('#fl-sm-rotb').addEventListener('click', () => { closePops(); transformSel(s => S.rotate(s, -15)); });
  $('#fl-sm-styleall').addEventListener('click', () => { closePops(); styleAll(); });
  $('#fl-sm-front').addEventListener('click', () => { closePops(); zOrder('top'); });
  $('#fl-sm-back').addEventListener('click', () => { closePops(); zOrder('bottom'); });
  $('#fl-sel-unpair').addEventListener('click', () => { closePops(); unpair(); });
  $('#fl-sm-tostep').addEventListener('click', () => { closePops(); moveToNextStep(); });
  $('#fl-sel-label-btn').addEventListener('click', () => { const s = sel(); if (!s) return; togglePop('fl-label-pop'); $('#fl-label-input').value = s.label || ''; });
  $('#fl-label-done').addEventListener('click', () => { setLabel($('#fl-label-input').value); closePops(); });
  $('#fl-label-clear').addEventListener('click', () => { setLabel(''); closePops(); });
  $('#fl-label-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setLabel(e.target.value); closePops(); } e.stopPropagation(); });
  document.querySelectorAll('#fl-label-chips [data-word]').forEach(b => b.addEventListener('click', () => { setLabel(b.dataset.word); closePops(); }));
  // 文字
  $('#fl-text-done').addEventListener('click', textDone);
  $('#fl-text-cancel').addEventListener('click', () => { textTarget = null; closePops(); });
  $('#fl-text-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textDone(); } e.stopPropagation(); });
  for (const id of ['fl-text-bold', 'fl-text-box']) $('#' + id).addEventListener('click', e => { const b = e.currentTarget; b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); });
  // 眼睛（要看到什麼）
  for (const [id, k] of [['fl-tgl-hairline', 'hairline'], ['fl-tgl-names', 'labels'], ['fl-tgl-structure', 'structure'], ['fl-tgl-shade', 'shade'], ['fl-tgl-ghost', 'ghost'], ['fl-tgl-guides', 'guides'], ['fl-tgl-magnifier', 'magnifier']]) $('#' + id).addEventListener('click', () => setSetting(k, !settings()[k]));
  document.querySelectorAll('#fl-grid-seg [data-grid]').forEach(b => b.addEventListener('click', () => setSetting('grid', b.dataset.grid)));
  $('#fl-struct').addEventListener('click', () => setSetting('structure', !settings().structure));
  // 這個視圖的 ⋯
  document.querySelectorAll('#fl-view-pop [data-tpl]').forEach(b => b.addEventListener('click', () => { closePops(); addTemplate(b.dataset.tpl, $('#fl-tpl-all').getAttribute('aria-pressed') === 'true'); }));
  $('#fl-tpl-all').addEventListener('click', e => { const b = e.currentTarget; b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); });
  $('#fl-ms-a').addEventListener('click', () => { closePops(); mirrorSide(view === 'left' || view === 'right' ? 'to-other' : 'l2r'); });
  $('#fl-ms-b').addEventListener('click', () => { closePops(); mirrorSide(view === 'left' || view === 'right' ? 'from-other' : 'r2l'); });
  $('#fl-view-clear').addEventListener('click', () => { closePops(); const n = inView(view).length; if (!n || !confirm('このステップの「' + viewById(view).label + '」の ' + n + ' 個を消しますか？（元に戻すで戻せます）')) return; pushHistory(); shapes = shapes.filter(s => s.view !== view); for (const s of shapes) if (s.mirrorPairId && !byId(s.mirrorPairId)) delete s.mirrorPairId; selId = null; commit(); app.changed(); });
  $('#fl-view-png').addEventListener('click', () => { closePops(); output('png-view'); });
  $('#fl-vnote').addEventListener('input', e => { const t = e.target.value.slice(0, L.NOTE_MAX); drawing.viewNotes = { ...(drawing.viewNotes || {}) }; if (t) drawing.viewNotes[view] = t; else delete drawing.viewNotes[view]; if (!Object.keys(drawing.viewNotes).length) delete drawing.viewNotes; app.saved(); });
  $('#fl-back-pick').addEventListener('click', () => $('#fl-back-input').click());
  $('#fl-back-input').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return; closePops();
    try {
      const old = (drawing.backs || {})[view];
      const id = await media.addImage(f, 2000);
      drawing.backs = { ...(drawing.backs || {}), [view]: id };
      if (old && !app.lib().drawings.some(d => Object.values(d.backs || {}).includes(old))) media.del(old).catch(() => {});
      app.saved(); await loadBacks(); renderAll(); toast('「' + viewById(view).label + '」の下絵を自分の写真にしました');
    } catch (err) { toast('下絵が読み込めません：' + err.message); }
  });
  $('#fl-back-clear').addEventListener('click', () => {
    closePops(); const id = (drawing.backs || {})[view]; if (!id) return;
    delete drawing.backs[view]; if (!Object.keys(drawing.backs).length) delete drawing.backs;
    if (!app.lib().drawings.some(d => Object.values(d.backs || {}).includes(id))) media.del(id).catch(() => {});
    app.saved(); loadBacks().then(renderAll); toast('ヘッドの線画に戻しました');
  });
  // 預覽
  $('#fl-play').addEventListener('click', () => { if (play && play.playing) stopPlay(); else if (play && play.frame < play.tl.frames) { play.playing = true; const t0 = performance.now(), f0 = play.frame; const tick = now => { if (!play || !play.playing) return; play.frame = f0 + (now - t0) / (1000 / AN.FPS); if (play.frame >= play.tl.frames) { play.frame = play.tl.frames; play.playing = false; } drawFrame(); syncPlayer(); if (play.playing) play.raf = requestAnimationFrame(tick); }; play.raf = requestAnimationFrame(tick); syncPlayer(); } else playStep(play ? play.scope : 'step'); });
  $('#fl-replay').addEventListener('click', () => playStep('step'));
  $('#fl-playall').addEventListener('click', () => playStep('all'));
  document.querySelectorAll('#fl-speed [data-speed]').forEach(b => b.addEventListener('click', () => { settings().speed = b.dataset.speed; app.saved(); syncPlayer(); playStep(play ? play.scope : 'step'); }));
  new ResizeObserver(() => { if (mode === 'preview' && drawing) { resizeCanvas(); drawFrame(); } else if (drawing) updateUi(); }).observe(root);

  // 這一筆移到下一步（沒有下一步就加一步）
  function moveToNextStep() {
    const s = sel(); if (!s) return;
    pushHistory();
    const moving = [s, ...(s.mirrorPairId && byId(s.mirrorPairId) ? [byId(s.mirrorPairId)] : [])];
    shapes = shapes.filter(x => !moving.includes(x)); selId = null;
    commit();
    if (stepIdx === drawing.steps.length - 1) L.addStep(drawing, stepIdx);
    const next = drawing.steps[stepIdx + 1], list = L.stepShapes(next);
    list.push(...moving); L.storeStepShapes(next, list); app.saved();
    toast('次のステップに移しました（' + L.stepLabel(stepIdx + 1) + '）');
  }

  return {
    media, open, close, openStep, setMode, undo, redo, keydown, switchHead, output, thumbnail, clearStep, closePops, photo,
    canUndo: () => history.length > 0, canRedo: () => future.length > 0, stepCount: () => shapes.length,
    toggleEye: () => togglePop('fl-eye-pop'),
    // 給自動化測試用
    get state() { return { tool, view, layout, mode, selId, shapes, below, variant, styles }; },
    setTool, setView, setLayout, select, addTemplate, magic, mirrorSide, fillAt, create: o => create(S.newShape({ view, ...o })),
    templates: () => tpls,
    build: async kind => (kind === 'pdf' ? makePdf() : kind === 'carousel' ? makeCarousel() : kind === 'png-sheet' ? canvasBlob(await sheetCanvas()) : kind === 'png-view' ? viewPng() : kind === 'thumb' ? thumbnail() : null),
  };
}
