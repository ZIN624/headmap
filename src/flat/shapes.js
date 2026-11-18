// SPDX-License-Identifier: AGPL-3.0-only
// 2D 頭圖的一筆（shape）：資料格式、檢查、幾何（路徑、取樣點、命中、外框）與變換。純資料，瀏覽器與 Node 共用。
// 座標是視圖平面上的公釐（views.js），+x 往右、+y 往下。
//
//   { id, type, view, pts:[[x,y],…], style:{ color, width, dash, opacity, fill }, ends?:{ a, b }, label?, mirrorPairId?, …依種類 }
//   line     直線，pts＝[起點, 終點]
//   curve    曲線，pts＝[起點, 終點]，m＝線上的中間點（曲線在一半的地方剛好通過它）
//   poly     折線，pts＝依序的轉折點
//   free     手畫線，pts＝整理過的點（畫的時候用二次曲線圓順地接起來）
//   region   面（填色的一塊），pts＝外框的點；smooth＝外框圓順（否則照點直接連）
//   ellipse  圓／橢圓，pts＝[圓心]，rx、ry（半徑）、rot（度）
//   dot      點，pts＝[位置]，r（半徑）、mark：fill 實心／ring 空心／cross 十字／x 叉
//   text     文字，pts＝[中心]，text、size（字高 mm）、rot、bold、box（白底）
//   icon     工具圖示（剪刀、剃刀、電剪…），pts＝[中心]，icon、size、rot、flip（左右翻）
//   angle    角度，pts＝[頂點, 一邊, 另一邊]，畫兩條邊、一段弧和度數
//   ends     線的兩端：none／arrow 箭頭／dot 圓點／bar 短橫（line、curve、poly、free 才有）
//   style.dash：solid 實線／dash 虛線／dot 點線；style.fill：ellipse 要不要填色（region 一定填）

export const TYPES = ['line', 'curve', 'poly', 'free', 'region', 'ellipse', 'dot', 'text', 'icon', 'angle'];
export const TYPE_LABELS = { line: '直線', curve: '曲線', poly: '折れ線', free: '手描き', region: '面', ellipse: '円', dot: '点', text: '文字', icon: '道具アイコン', angle: '角度' };
export const PATH_TYPES = ['line', 'curve', 'poly', 'free'];   // 有兩端、可以加箭頭
export const ENDS = ['none', 'arrow', 'dot', 'bar'];
export const DASHES = ['solid', 'dash', 'dot'];
export const MARKS = ['fill', 'ring', 'cross', 'x'];
export const ICONS = ['scissors', 'thinning', 'razor', 'clipper', 'comb', 'brush', 'clip', 'hand', 'spray', 'dryer'];
export const ICON_LABELS = { scissors: 'ハサミ', thinning: 'セニング', razor: 'レザー', clipper: 'バリカン', comb: 'コーム', brush: 'ロールブラシ', clip: 'ダッカール', hand: '指', spray: '霧吹き', dryer: 'ドライヤー' };
export const WIDTHS = [0.5, 0.9, 1.4, 2.2, 3.2];             // 線寬（mm）五段
export const COLORS = ['#1B1B1B', '#7A8089', '#236B91', '#1B64FF', '#0C8F91', '#2E8B57', '#D86735', '#C63B32', '#B0479A', '#E0A526'];
export const TEMPLATE_INK = '#8A9099';                       // 頭模線稿的顏色
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const isColor = s => typeof s === 'string' && COLOR_RE.test(s);
export const LABEL_MAX = 24, TEXT_MAX = 200;
const LIMIT = 2000; // 座標離原點超過 2 m 一律當成壞資料

export function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
}
const r2 = x => Math.round(x * 100) / 100;
const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const ptOk = p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && Math.abs(v) <= LIMIT);
export const cleanText = (t, max) => (typeof t === 'string' ? t.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, max) : '');
export const cleanLabel = t => cleanText(t, LABEL_MAX).replace(/\s+/g, ' ').trim();

const minPts = t => ({ line: 2, curve: 2, poly: 2, free: 2, region: 3, angle: 3 }[t] || 1);
const maxPts = t => ({ line: 2, curve: 2, angle: 3, poly: 400, free: 4000, region: 4000 }[t] || 1);

// 每種一開始的樣式
export function defaultStyle(type) {
  const base = { color: '#1B1B1B', width: WIDTHS[1], dash: 'solid', opacity: 1, fill: false };
  if (type === 'region') return { ...base, color: '#0C8F91', opacity: 0.35, fill: true };
  if (type === 'dot') return { ...base, color: '#D86735' };
  if (type === 'text') return { ...base, color: '#363B49' };
  if (type === 'icon') return { ...base, color: '#363B49' };
  if (type === 'angle') return { ...base, color: '#D86735' };
  return base;
}

// 新的一筆：缺的欄位補預設值、超出範圍的拉回來
export function newShape(o) {
  if (!TYPES.includes(o.type)) throw new Error('不明な種類：' + o.type);
  const s = { id: o.id || newId(), type: o.type, view: o.view, pts: (o.pts || []).map(p => [p[0], p[1]]) };
  const st = { ...defaultStyle(o.type), ...(o.style || {}) };
  s.style = {
    color: isColor(st.color) ? st.color.toUpperCase() : '#1B1B1B',
    width: num(st.width, 0.2, 8, WIDTHS[1]),
    dash: DASHES.includes(st.dash) ? st.dash : 'solid',
    opacity: num(st.opacity, 0.05, 1, 1),
    fill: o.type === 'region' ? true : o.type === 'ellipse' ? !!st.fill : false,
  };
  if (PATH_TYPES.includes(o.type)) { const e = o.ends || {}; s.ends = { a: ENDS.includes(e.a) ? e.a : 'none', b: ENDS.includes(e.b) ? e.b : 'none' }; }
  if (o.type === 'curve') s.m = ptOk(o.m) ? [o.m[0], o.m[1]] : mid(s.pts[0], s.pts[1]);
  if (o.type === 'region') s.smooth = o.smooth !== false;
  if (o.type === 'ellipse') { s.rx = num(o.rx, 0.5, 600, 20); s.ry = num(o.ry, 0.5, 600, 20); s.rot = num(o.rot, -360, 360, 0); }
  if (o.type === 'dot') { s.r = num(o.r, 0.4, 40, 2.4); s.mark = MARKS.includes(o.mark) ? o.mark : 'fill'; }
  if (o.type === 'text') { s.text = cleanText(o.text, TEXT_MAX) || '文字'; s.size = num(o.size, 2, 120, 9); s.rot = num(o.rot, -360, 360, 0); s.bold = !!o.bold; s.box = !!o.box; }
  if (o.type === 'icon') { s.icon = ICONS.includes(o.icon) ? o.icon : 'scissors'; s.size = num(o.size, 4, 200, 22); s.rot = num(o.rot, -360, 360, 0); s.flip = !!o.flip; }
  const label = cleanLabel(o.label); if (label) s.label = label;
  if (typeof o.mirrorPairId === 'string' && o.mirrorPairId) s.mirrorPairId = o.mirrorPairId;
  if (o.origin && typeof o.origin === 'object') s.origin = o.origin;
  return s;
}
export const clone = s => JSON.parse(JSON.stringify(s));

// ---- 存檔（座標留到 0.01 mm）與讀檔（逐筆檢查，不合格丟出錯誤）
export function saveShapes(list) {
  return list.map(s => {
    const out = { id: s.id, type: s.type, view: s.view, pts: s.pts.map(p => [r2(p[0]), r2(p[1])]), style: { ...s.style, width: r2(s.style.width), opacity: r2(s.style.opacity) } };
    for (const k of ['ends', 'smooth', 'mark', 'text', 'bold', 'box', 'icon', 'flip', 'label', 'mirrorPairId']) if (s[k] !== undefined) out[k] = s[k];
    for (const k of ['rx', 'ry', 'rot', 'r', 'size']) if (s[k] !== undefined) out[k] = r2(s[k]);
    if (s.m) out.m = [r2(s.m[0]), r2(s.m[1])];
    if (s.origin && s.origin.sig === shapeSig(out)) out.origin = s.origin;
    return out;
  });
}
export function parseShapes(list, viewIds) {
  if (!Array.isArray(list)) throw new Error('shapes がありません');
  const seen = new Set();
  const out = list.map((o, i) => {
    const where = (i + 1) + ' 番目の図形';
    if (!o || typeof o !== 'object') throw new Error(where + 'がオブジェクトではありません');
    if (!TYPES.includes(o.type)) throw new Error(where + 'の種類が不明です：' + o.type);
    if (!viewIds.includes(o.view)) throw new Error(where + 'のビューが不明です：' + o.view);
    if (!Array.isArray(o.pts) || o.pts.length < minPts(o.type) || o.pts.length > maxPts(o.type)) throw new Error(where + 'の点の数が違います');
    if (!o.pts.every(ptOk)) throw new Error(where + 'の点が [x, y] の数値ではありません');
    let id = typeof o.id === 'string' && o.id ? o.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    return newShape({ ...o, id, origin: originOk(o.origin, o.pts.length) });
  });
  const ids = new Set(out.map(s => s.id));
  for (const s of out) if (s.mirrorPairId && !ids.has(s.mirrorPairId)) delete s.mirrorPairId;
  return out;
}
function originOk(o, n) {
  if (!o || typeof o !== 'object' || typeof o.head !== 'string' || typeof o.sig !== 'string') return undefined;
  if (!Array.isArray(o.pts) || o.pts.length !== n || !o.pts.every(ptOk)) return undefined;
  return { head: o.head, pts: o.pts.map(p => [p[0], p[1]]), ...(ptOk(o.m) ? { m: [o.m[0], o.m[1]] } : {}), sig: o.sig };
}
// 位置指紋（換頭模時判斷搬過來之後有沒有動過）
export function shapeSig(s) {
  const text = JSON.stringify([s.pts.map(p => [r2(p[0]), r2(p[1])]), s.m ? [r2(s.m[0]), r2(s.m[1])] : null]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------- 幾何
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const quad = (a, c, b, t) => { const u = 1 - t; return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]; };
const rotPt = (p, c, deg) => { const r = deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r), dx = p[0] - c[0], dy = p[1] - c[1]; return [c[0] + dx * cs - dy * sn, c[1] + dx * sn + dy * cs]; };
const f = x => (Math.round(x * 100) / 100).toString();
const P = p => f(p[0]) + ' ' + f(p[1]);
// 曲線：線上的中間點 m → 二次貝茲控制點 C（曲線在 t＝0.5 通過 m）
export const curveControl = (a, b, m) => [2 * m[0] - (a[0] + b[0]) / 2, 2 * m[1] - (a[1] + b[1]) / 2];

// 手畫線的圓順路徑：每兩點的中點當接點、點本身當控制點（二次曲線），頭尾照原點
function smoothSegs(pts, closed) {
  const n = pts.length, segs = [];
  if (closed) {
    for (let i = 0; i < n; i++) segs.push([mid(pts[(i + n - 1) % n], pts[i]), pts[i], mid(pts[i], pts[(i + 1) % n])]);
    return segs;
  }
  if (n < 3) return [[pts[0], mid(pts[0], pts[n - 1]), pts[n - 1]]];
  let start = pts[0];
  for (let i = 1; i < n - 1; i++) { const end = i === n - 2 ? pts[n - 1] : mid(pts[i], pts[i + 1]); segs.push([start, pts[i], end]); start = end; }
  return segs;
}

// 文字的外框大小（估算：中日韓字寬 1 個字高、其他 0.58）
export function textSize(s) {
  let w = 0;
  for (const ch of s.text) w += ch.codePointAt(0) > 0x2e80 ? 1 : 0.58;
  return { w: Math.max(1, w) * s.size + (s.box ? s.size * 0.6 : 0), h: s.size * 1.3 + (s.box ? s.size * 0.4 : 0) };
}
function boxCorners(c, w, h, rot) {
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(p => rotPt([c[0] + p[0], c[1] + p[1]], c, rot));
}
export function boxOf(s) { // 文字、圖示：旋轉後的四個角
  if (s.type === 'text') { const t = textSize(s); return boxCorners(s.pts[0], t.w, t.h, s.rot); }
  if (s.type === 'icon') return boxCorners(s.pts[0], s.size, s.size, s.rot);
  return null;
}
// 角度：頂點、兩邊的方向、弧的半徑、度數（0～180）
export function angleInfo(s) {
  const [v, a, b] = s.pts, la = dist(v, a), lb = dist(v, b);
  const aa = Math.atan2(a[1] - v[1], a[0] - v[0]), ab = Math.atan2(b[1] - v[1], b[0] - v[0]);
  let d = ab - aa; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  const r = Math.max(5, Math.min(22, Math.min(la, lb) * 0.35));
  return { v, aa, d, r, deg: Math.abs(d) * 180 / Math.PI, bis: aa + d / 2 };
}

// 一筆的形狀：{ d（SVG 路徑）, pts（取樣點，命中與吸附用）, closed, ends:{ a:{p,dir}, b:{p,dir} } }
// dir＝在端點往外的單位方向（箭頭朝這個方向）
export function geom(s) {
  const p = s.pts;
  const endsOf = (pts) => {
    const a = pts[0], b = pts[pts.length - 1];
    const dirAt = (from, toward) => { const l = dist(from, toward) || 1; return [(from[0] - toward[0]) / l, (from[1] - toward[1]) / l]; };
    const back = (list, idx, step) => { let j = idx; while (j + step >= 0 && j + step < list.length && dist(list[j + step], list[idx]) < 1.2) j += step; return list[Math.max(0, Math.min(list.length - 1, j + step))] || list[idx]; };
    return { a: { p: a, dir: dirAt(a, back(pts, 0, 1)) }, b: { p: b, dir: dirAt(b, back(pts, pts.length - 1, -1)) } };
  };
  switch (s.type) {
    case 'line': return { d: 'M' + P(p[0]) + 'L' + P(p[1]), pts: [p[0], p[1]], closed: false, ends: endsOf(p) };
    case 'curve': {
      const c = curveControl(p[0], p[1], s.m), pts = [];
      for (let i = 0; i <= 32; i++) pts.push(quad(p[0], c, p[1], i / 32));
      return { d: 'M' + P(p[0]) + 'Q' + P(c) + ' ' + P(p[1]), pts, closed: false, ends: endsOf(pts) };
    }
    case 'poly': return { d: 'M' + p.map(P).join('L'), pts: p.slice(), closed: false, ends: endsOf(p) };
    case 'free':
    case 'region': {
      const closed = s.type === 'region';
      if (closed && !s.smooth) return { d: 'M' + p.map(P).join('L') + 'Z', pts: p.concat([p[0]]), closed, ends: null };
      const segs = smoothSegs(p, closed), pts = [];
      let d = 'M' + P(segs[0][0]);
      for (const [a, c, b] of segs) { d += 'Q' + P(c) + ' ' + P(b); for (let i = 1; i <= 8; i++) pts.push(quad(a, c, b, i / 8)); }
      pts.unshift(segs[0][0]);
      return { d: d + (closed ? 'Z' : ''), pts, closed, ends: closed ? null : endsOf(pts) };
    }
    case 'ellipse': {
      const c = p[0], pts = [];
      for (let i = 0; i <= 64; i++) { const t = i / 64 * 2 * Math.PI; pts.push(rotPt([c[0] + s.rx * Math.cos(t), c[1] + s.ry * Math.sin(t)], c, s.rot)); }
      const a = rotPt([c[0] + s.rx, c[1]], c, s.rot), b = rotPt([c[0] - s.rx, c[1]], c, s.rot);
      const d = 'M' + P(a) + 'A' + f(s.rx) + ' ' + f(s.ry) + ' ' + f(s.rot) + ' 1 0 ' + P(b) + 'A' + f(s.rx) + ' ' + f(s.ry) + ' ' + f(s.rot) + ' 1 0 ' + P(a) + 'Z';
      return { d, pts, closed: true, ends: null };
    }
    case 'dot': {
      const c = p[0], r = s.r, pts = [];
      for (let i = 0; i <= 16; i++) { const t = i / 16 * 2 * Math.PI; pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
      let d;
      if (s.mark === 'cross') d = 'M' + P([c[0] - r, c[1]]) + 'L' + P([c[0] + r, c[1]]) + 'M' + P([c[0], c[1] - r]) + 'L' + P([c[0], c[1] + r]);
      else if (s.mark === 'x') { const k = r * 0.75; d = 'M' + P([c[0] - k, c[1] - k]) + 'L' + P([c[0] + k, c[1] + k]) + 'M' + P([c[0] + k, c[1] - k]) + 'L' + P([c[0] - k, c[1] + k]); }
      else d = 'M' + P([c[0] + r, c[1]]) + 'A' + f(r) + ' ' + f(r) + ' 0 1 0 ' + P([c[0] - r, c[1]]) + 'A' + f(r) + ' ' + f(r) + ' 0 1 0 ' + P([c[0] + r, c[1]]) + 'Z';
      return { d, pts, closed: true, ends: null };
    }
    case 'angle': {
      const g = angleInfo(s), arc = [];
      for (let i = 0; i <= 24; i++) { const t = g.aa + g.d * i / 24; arc.push([g.v[0] + g.r * Math.cos(t), g.v[1] + g.r * Math.sin(t)]); }
      const d = 'M' + P(p[1]) + 'L' + P(p[0]) + 'L' + P(p[2]) + 'M' + P(arc[0]) + 'A' + f(g.r) + ' ' + f(g.r) + ' 0 0 ' + (g.d > 0 ? 1 : 0) + ' ' + P(arc[arc.length - 1]);
      return { d, pts: [p[1], p[0], p[2]], closed: false, ends: null, arc };
    }
    default: { const b = boxOf(s); return { d: 'M' + b.map(P).join('L') + 'Z', pts: b.concat([b[0]]), closed: true, ends: null }; }
  }
}

// 線端的小圖形（箭頭、圓點、短橫）：回傳 { d, fill }；線寬 w
export function endCap(kind, end, w) {
  if (!end || kind === 'none') return null;
  const [x, y] = end.p, [dx, dy] = end.dir, nx = -dy, ny = dx;
  if (kind === 'arrow') {
    const L = 2.6 + w * 2.6, W = L * 0.42;
    const tip = [x + dx * w * 0.6, y + dy * w * 0.6], base = [tip[0] - dx * L, tip[1] - dy * L];
    return { d: 'M' + P(tip) + 'L' + P([base[0] + nx * W, base[1] + ny * W]) + 'L' + P([base[0] - nx * W, base[1] - ny * W]) + 'Z', fill: true, trim: L * 0.7 };
  }
  if (kind === 'dot') { const r = 1 + w * 1.1; return { d: 'M' + P([x + r, y]) + 'A' + f(r) + ' ' + f(r) + ' 0 1 0 ' + P([x - r, y]) + 'A' + f(r) + ' ' + f(r) + ' 0 1 0 ' + P([x + r, y]) + 'Z', fill: true, trim: 0 }; }
  if (kind === 'bar') { const h = 2 + w * 1.6; return { d: 'M' + P([x + nx * h, y + ny * h]) + 'L' + P([x - nx * h, y - ny * h]), fill: false, trim: 0 }; }
  return null;
}
// 虛線樣式（相對線寬）
export function dashArray(st) {
  if (st.dash === 'dash') return [st.width * 3 + 2.2, st.width * 2 + 1.6];
  if (st.dash === 'dot') return [0.01, st.width * 2 + 1.2];
  return null;
}

// 點到線段的距離
export function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
export function nearestOnPolyline(p, pts) {
  let best = { d: Infinity, q: pts[0], i: 0, t: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const q = [a[0] + dx * t, a[1] + dy * t], d = dist(p, q);
    if (d < best.d) best = { d, q, i, t };
  }
  return best;
}
export function insidePolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
// p 離這一筆多遠（mm）。面、填色的圓、文字、圖示：在裡面＝0
export function hitDistance(s, p) {
  const g = geom(s), w = s.style.width / 2;
  if (s.type === 'text' || s.type === 'icon' || (s.type === 'region') || (s.type === 'ellipse' && s.style.fill) || (s.type === 'dot' && s.mark === 'fill')) {
    if (insidePolygon(p, g.pts)) return 0;
  }
  if (s.type === 'dot') return Math.max(0, dist(p, s.pts[0]) - s.r);
  return Math.max(0, nearestOnPolyline(p, g.pts).d - w);
}
export function bbox(s) {
  const g = geom(s); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of g.pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  const w = s.style.width / 2;
  return { x0: x0 - w, y0: y0 - w, x1: x1 + w, y1: y1 + w };
}
export const center = s => { const b = bbox(s); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]; };
// 取樣點的總長（動畫照長度描線）
export function pathLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; }

// ---------------------------------------------------------------- 變換（就地改，回傳同一筆）
export function translate(s, dx, dy) {
  s.pts = s.pts.map(p => [p[0] + dx, p[1] + dy]);
  if (s.m) s.m = [s.m[0] + dx, s.m[1] + dy];
  return s;
}
// 對 x＝cx 翻（鏡像）：點翻過去，旋轉角取負，圖示左右翻，角度與方向照舊
export function mirrorX(s, cx = 0) {
  const fx = p => [2 * cx - p[0], p[1]];
  s.pts = s.pts.map(fx);
  if (s.m) s.m = fx(s.m);
  if (s.rot !== undefined) s.rot = -s.rot;
  if (s.type === 'icon') s.flip = !s.flip;
  return s;
}
// 反轉方向：起點和終點互換（箭頭跟著換邊）
export function reverse(s) {
  if (!PATH_TYPES.includes(s.type) && s.type !== 'angle') return s;
  if (s.type === 'angle') { s.pts = [s.pts[0], s.pts[2], s.pts[1]]; return s; }
  s.pts = s.pts.slice().reverse();
  if (s.ends) s.ends = { a: s.ends.b, b: s.ends.a };
  return s;
}
// 在自己的中心左右翻（垂直線不變、斜線換邊）或上下翻
export function flipLocal(s, axis = 'h') {
  const c = center(s);
  const fp = axis === 'h' ? p => [2 * c[0] - p[0], p[1]] : p => [p[0], 2 * c[1] - p[1]];
  s.pts = s.pts.map(fp);
  if (s.m) s.m = fp(s.m);
  if (s.rot !== undefined) s.rot = axis === 'h' ? -s.rot : 180 - s.rot;
  if (s.type === 'icon' && axis === 'h') s.flip = !s.flip;
  return s;
}
// 繞 c 轉 deg 度
export function rotate(s, deg, c = center(s)) {
  s.pts = s.pts.map(p => rotPt(p, c, deg));
  if (s.m) s.m = rotPt(s.m, c, deg);
  if (s.rot !== undefined) s.rot = ((s.rot + deg + 540) % 360) - 180;
  return s;
}
// 以 c 為中心等比縮放 k 倍（線寬不變）
export function scale(s, k, c = center(s)) {
  const sp = p => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
  s.pts = s.pts.map(sp);
  if (s.m) s.m = sp(s.m);
  for (const key of ['rx', 'ry', 'r', 'size']) if (s[key] !== undefined) s[key] *= k;
  return s;
}

// ---------------------------------------------------------------- 手畫線整理
// Ramer–Douglas–Peucker：保留轉折，去掉多餘的點
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(); let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) { const d = segDist(pts[k], pts[i], pts[j]); if (d > bd) { bd = d; best = k; } }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// 平滑度 0～3：0＝照手畫的點（只去掉重複）；越高越圓順
export function tidyFree(raw, level = 2) {
  const pts = [];
  for (const p of raw) if (!pts.length || dist(p, pts[pts.length - 1]) > 0.15) pts.push(p);
  if (pts.length < 2) return pts;
  const tol = [0.12, 0.45, 0.9, 1.6][Math.max(0, Math.min(3, level))];
  let out = simplify(pts, tol);
  if (level >= 2 && out.length >= 3) { // 先平均一次再簡化，抖動更少
    const avg = out.map((p, i) => (i === 0 || i === out.length - 1 ? p : [(out[i - 1][0] + 2 * p[0] + out[i + 1][0]) / 4, (out[i - 1][1] + 2 * p[1] + out[i + 1][1]) / 4]));
    out = simplify(avg, tol * 0.6);
  }
  return out;
}
