// SPDX-License-Identifier: AGPL-3.0-only
// 換頭模時把畫好的圖搬到新頭上相對的位置。純資料，不依賴 three，瀏覽器與 Node 共用。
// 做法：
//   1. 每顆頭各有一份「骨架」＝同一組對照點：十五點（側面的分左右，共 21 點）、外輪廓上每兩個點位之間等分的點、
//      結構線上等分的點。存在 assets/heads/transfer.json（用畫圖同一套程式算出來）。
//   2. 舊頭的骨架 → 新頭的骨架，用通過每個對照點的平滑變形（三維徑向基底函數，核 φ(r)=r 加仿射項）把點搬過去，
//      再貼到新頭可以畫的表面上（呼叫的人給 project）。點位搬到點位、外輪廓搬到外輪廓、結構線搬到結構線。
//   3. 每一筆記住原本畫在哪顆頭、原本的位置（layer.origin）。換頭永遠從原本的位置換算：換回原本那顆就是原樣，
//      換來換去不會越換越歪。在新頭上動過位置（doc.js 的 geomSig 對不上），就改算是在新頭上畫的。
//   4. 髮長、提拉角度、顏色不動。
import { geomSig } from './doc.js';

export const TRANSFER_FORMAT = 'head3d-transfer';

// ---------------------------------------------------------------- 骨架
// 每兩個點位之間取幾個點（不含兩端）。ear、gp：[側面那一頭 → 交叉點, 交叉點 → 中間的點位]
export const SKELETON_K = { outline: 6, center: 3, ear: [3, 3], gp: [3, 5], epbp: 5 };
const OUTLINE_ORDER = ['C.P', 'F.S.P', 'S.P', 'S.C.P', 'E.P', 'E.B.P', 'N.S.P', 'N.P'];
const MIDLINE = ['C.P', 'C.T.M.P', 'T.P', 'T.G.M.P', 'G.P', 'G.B.M.P', 'B.P', 'B.N.M.P', 'N.P'];

const arr = p => (Array.isArray(p) ? [p[0], p[1], p[2]] : [p.x, p.y, p.z]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const r5 = x => Math.round(x * 1e5) / 1e5;

function nearestIndex(poly, p, from = 0, to = poly.length - 1) {
  let best = from, bd = Infinity;
  for (let i = from; i <= to; i++) { const d = dist(poly[i], p); if (d < bd) { bd = d; best = i; } }
  return best;
}
// poly[i0..i1] 上照弧長等分取 k 個點（不含兩端）
function between(poly, i0, i1, k) {
  if (!(i1 > i0)) throw new Error('骨組み：線の上の2つのポイントの順番が違います');
  const cum = [0];
  for (let i = i0 + 1; i <= i1; i++) cum.push(cum[cum.length - 1] + dist(poly[i], poly[i - 1]));
  const total = cum[cum.length - 1], out = [];
  let j = 0;
  for (let n = 1; n <= k; n++) {
    const s = total * n / (k + 1);
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const a = poly[i0 + j], b = poly[i0 + j + 1], u = (s - cum[j]) / Math.max(1e-12, cum[j + 1] - cum[j]);
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
  }
  return out;
}

// lms：computeLandmarks 的 21 個點；outline：outlinePoints 的閉合點列（從 C.P 往左側走）；lines：structureLines 的五條。
// symmetric＝這顆頭左右對稱：左右對照點取平均後鏡像、中線點 x＝0，兩顆對稱的頭之間的變形才會剛好左右對稱。
// 回傳 { labels, pts }：每顆頭的 labels 一模一樣，pts 是 [x,y,z] 公尺。
export function skeleton(lms, outline, lines, { symmetric = false } = {}) {
  const lm = (id, side = '') => { const l = lms.find(x => x.id === id && x.side === side); if (!l) throw new Error('骨組み：ポイントが見つかりません ' + id + side); return arr(l.point); };
  const labels = [], pts = [];
  const add = (label, p) => { labels.push(label); pts.push(p); };
  for (const l of lms) add('lm:' + l.id + (l.side ? ':' + l.side : ''), arr(l.point));
  // 外輪廓：左側順著走、右側反著走，兩側都從 C.P 那一頭開始編號
  const ring = outline.map(arr);
  for (const side of ['L', 'R']) {
    const poly = side === 'L' ? ring.concat([ring[0]]) : [ring[0], ...ring.slice(1).reverse(), ring[0]];
    let prev = 0;
    for (let s = 0; s < OUTLINE_ORDER.length - 1; s++) {
      const b = OUTLINE_ORDER[s + 1], pb = b === 'N.P' ? lm('N.P') : lm(b, side);
      const next = nearestIndex(poly, pb, prev + 1, poly.length - 2);
      between(poly, prev, next, SKELETON_K.outline).forEach((p, j) => add('ol:' + OUTLINE_ORDER[s] + '>' + b + ':' + side + ':' + (j + 1), p));
      prev = next;
    }
  }
  const line = id => { const l = lines.find(x => x.id === id); if (!l) throw new Error('骨組み：構造線が見つかりません ' + id); return l.points.map(arr); };
  { // 中線：九個點之間各取幾個
    const poly = line('center'); let prev = 0;
    for (let s = 0; s < MIDLINE.length - 1; s++) {
      const next = s === MIDLINE.length - 2 ? poly.length - 1 : nearestIndex(poly, lm(MIDLINE[s + 1]), prev + 1, poly.length - 1);
      between(poly, prev, next, SKELETON_K.center).forEach((p, j) => add('ct:' + MIDLINE[s] + '>' + MIDLINE[s + 1] + ':' + (j + 1), p));
      prev = next;
    }
  }
  // 耳到耳、G.P 橫線在耳朵上方交叉。交叉點在兩條線上的位置每顆頭不一樣，所以交叉點自己當一個對照點（x:L、x:R），
  // 兩條線都在交叉點再切一段（側面那一頭 → 交叉點 → 中間的點位），每一段各自等分，兩組對照點才不會互相拉扯。
  const half = (id, midLm) => {
    const poly = line(id), m = nearestIndex(poly, lm(midLm), 1, poly.length - 2);
    return { L: poly.slice(0, m + 1), R: poly.slice(m).reverse() };
  };
  const ee = half('ear_to_ear', 'T.P'), gp = half('gp_line', 'G.P');
  for (const side of ['L', 'R']) {
    const a = ee[side], b = gp[side];
    let ia = 1, ib = 1, bd = Infinity;
    for (let i = 1; i < a.length - 1; i++) for (let j = 1; j < b.length - 1; j++) { const d = dist(a[i], b[j]); if (d < bd) { bd = d; ia = i; ib = j; } }
    if (bd > 0.004) throw new Error('骨組み：イヤーツーイヤーと G.P の横線が交わりません（最も近い所で ' + (bd * 1000).toFixed(1) + ' mm）');
    add('x:' + side, [(a[ia][0] + b[ib][0]) / 2, (a[ia][1] + b[ib][1]) / 2, (a[ia][2] + b[ib][2]) / 2]);
    between(a, 0, ia, SKELETON_K.ear[0]).forEach((p, j) => add('ee:' + side + ':a' + (j + 1), p));
    between(a, ia, a.length - 1, SKELETON_K.ear[1]).forEach((p, j) => add('ee:' + side + ':b' + (j + 1), p));
    between(b, 0, ib, SKELETON_K.gp[0]).forEach((p, j) => add('gp:' + side + ':a' + (j + 1), p));
    between(b, ib, b.length - 1, SKELETON_K.gp[1]).forEach((p, j) => add('gp:' + side + ':b' + (j + 1), p));
  }
  for (const [id, side] of [['ep_bp_left', 'L'], ['ep_bp_right', 'R']]) { const poly = line(id); between(poly, 0, poly.length - 1, SKELETON_K.epbp).forEach((p, j) => add('eb:' + side + ':' + (j + 1), p)); }
  if (symmetric) {
    const at = new Map(labels.map((l, i) => [l, i]));
    labels.forEach((l, i) => {
      const parts = l.split(':'), k = parts.indexOf('L');
      if (k >= 0) {
        parts[k] = 'R'; const j = at.get(parts.join(':')); if (j === undefined) throw new Error('骨組み：' + l + ' に右側の対応点がありません');
        const a = pts[i], b = pts[j], m = [(a[0] - b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        pts[i] = m; pts[j] = [-m[0], m[1], m[2]];
      } else if (!parts.includes('R')) pts[i] = [0, pts[i][1], pts[i][2]];
    });
  }
  return { labels, pts: pts.map(p => p.map(r5)) };
}

// ---------------------------------------------------------------- 變形（通過每個對照點）
function solve(A, B) { // 高斯消去（部分選主元）；A：n×n，B：n×m。會改到傳進來的陣列
  const n = A.length, m = B[0].length;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-13) throw new Error('ヘッド切り替え：対応点が重なっていて変形を計算できません');
    [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
    for (let r = c + 1; r < n; r++) { const f = A[r][c] / A[c][c]; if (!f) continue; for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]; for (let k = 0; k < m; k++) B[r][k] -= f * B[c][k]; }
  }
  const X = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let r = n - 1; r >= 0; r--) for (let k = 0; k < m; k++) { let s = B[r][k]; for (let c = r + 1; c < n; c++) s -= A[r][c] * X[c][k]; X[r][k] = s / A[r][r]; }
  return X;
}
// src、dst：一樣多的點（[x,y,z] 或 [x,y]，維度 d 由點決定）。回傳 f(p) → 同維度的點，f(src[i])＝dst[i]。
export function fitWarp(src, dst) {
  const n = src.length, d = src.length ? src[0].length : 3;
  if (n !== dst.length || n < d + 1) throw new Error('ヘッド切り替え：両方の対応点の数が違います');
  const D = (a, b) => { let s = 0; for (let k = 0; k < d; k++) s += (a[k] - b[k]) ** 2; return Math.sqrt(s); };
  const N = n + 1 + d, A = Array.from({ length: N }, () => new Array(N).fill(0)), B = Array.from({ length: N }, () => new Array(d).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = D(src[i], src[j]);
    A[i][n] = 1; A[n][i] = 1;
    for (let k = 0; k < d; k++) { A[i][n + 1 + k] = src[i][k]; A[n + 1 + k][i] = src[i][k]; B[i][k] = dst[i][k] - src[i][k]; }
  }
  const W = solve(A, B);
  return p => {
    const out = p.slice(0, d);
    for (let k = 0; k < d; k++) { out[k] += W[n][k]; for (let c = 0; c < d; c++) out[k] += W[n + 1 + c][k] * p[c]; }
    for (let i = 0; i < n; i++) { const r = D(p, src[i]); if (!r) continue; for (let k = 0; k < d; k++) out[k] += r * W[i][k]; }
    return out;
  };
}

export function validateTransfer(data) {
  const out = [];
  if (!data || data.format !== TRANSFER_FORMAT || !Array.isArray(data.labels) || !data.heads) return ['ヘッド切り替えの対応データの形式が正しくありません'];
  for (const [id, h] of Object.entries(data.heads)) {
    if (!h || !Array.isArray(h.pts) || h.pts.length !== data.labels.length) out.push(id + ' の対応点の数が labels と違います');
    else if (!h.pts.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) out.push(id + ' の対応点が数値ではありません');
  }
  return out;
}

// data：transfer.json。回傳 { has(id), warp(from, to) }；warp 回傳 [x,y,z] → [x,y,z]（還沒貼表面）。
export function makeContext(data) {
  const bad = validateTransfer(data); if (bad.length) throw new Error(bad[0]);
  const cache = new Map();
  return {
    has: id => !!data.heads[id],
    warp(from, to) {
      const key = from + '>' + to;
      if (!cache.has(key)) {
        if (!data.heads[from] || !data.heads[to]) throw new Error('ヘッド切り替えの対応データにこのヘッドがありません：' + (data.heads[from] ? to : from));
        cache.set(key, fitWarp(data.heads[from].pts, data.heads[to].pts));
      }
      return cache.get(key);
    },
  };
}

// ---------------------------------------------------------------- 一筆、一張頭圖
const cp = p => ({ x: p.x, y: p.y, z: p.z });
const r4 = x => Math.round(x * 10000) / 10000;
// 拉彎的直線存的是二次貝茲控制點 C；線上的彎度點 M＝曲線中點。搬的時候搬 M（在頭皮上），再換回 C。
const handleOf = (S, C, E) => ({ x: (S.x + 2 * C.x + E.x) / 4, y: (S.y + 2 * C.y + E.y) / 4, z: (S.z + 2 * C.z + E.z) / 4 });
const controlOf = (S, E, M) => ({ x: 2 * M.x - (S.x + E.x) / 2, y: 2 * M.y - (S.y + E.y) / 2, z: 2 * M.z - (S.z + E.z) / 2 });

// layers：存檔格式的筆，現在的座標在 fromHead 上，搬到 toHead。就地改，回傳搬了幾筆。
// project({x,y,z}) → {x,y,z}：貼到 toHead 可以畫的表面上。
export function convertLayers(layers, fromHead, toHead, ctx, project) {
  let moved = 0;
  const onSurface = q => { const s = project({ x: q[0], y: q[1], z: q[2] }); return { x: r4(s.x), y: r4(s.y), z: r4(s.z) }; };
  for (const l of layers || []) {
    if (!l || !Array.isArray(l.points)) continue;
    const keep = l.origin && l.origin.sig === geomSig(l) && ctx.has(l.origin.head) ? l.origin : null; // 搬過來之後沒動過 → 從原本的位置換算
    const src = keep || { head: fromHead, points: l.points.map(cp), ...(l.control ? { control: cp(l.control) } : {}), ...(Array.isArray(l.bends) && l.bends.some(Boolean) ? { bends: l.bends.map(b => (b ? cp(b) : null)) } : {}) };
    if (src.head === toHead) { // 回到原本那顆頭：原樣放回去
      l.points = src.points.map(cp);
      if ('control' in l || src.control) l.control = src.control ? cp(src.control) : null;
      if (src.bends) l.bends = src.bends.map(b => (b ? cp(b) : null)); else if (l.bends) l.bends = l.bends.map(() => null);
      delete l.origin;
    } else {
      const w = ctx.warp(src.head, toHead), f = p => onSurface(w(arr(p)));
      const pts = src.points.map(f);
      if (src.control && src.points.length >= 2) {
        const S = src.points[0], E = src.points[src.points.length - 1], M = f(handleOf(S, src.control, E)), C = controlOf(pts[0], pts[pts.length - 1], M);
        l.control = { x: r4(C.x), y: r4(C.y), z: r4(C.z) };
      } else if ('control' in l) l.control = null;
      if (src.bends) l.bends = src.bends.map(b => (b ? f(b) : null)); else if (l.bends) l.bends = l.bends.map(() => null);
      l.points = pts;
      l.origin = { head: src.head, points: src.points.map(cp), ...(src.control ? { control: cp(src.control) } : {}), ...(src.bends ? { bends: src.bends.map(b => (b ? cp(b) : null)) } : {}), sig: '' };
      l.origin.sig = geomSig(l);
    }
    moved++;
  }
  return moved;
}

// 一張 3D 頭圖整張搬到 toHead（drawing.head＝現在的座標在哪顆頭上）。回傳搬了幾筆。
export function convertDrawing(drawing, toHead, ctx, project) {
  const from = drawing.head;
  if (from === toHead) return 0;
  if (!ctx.has(from) || !ctx.has(toHead)) throw new Error('ヘッド切り替えの対応データにこのヘッドがありません：' + (ctx.has(from) ? toHead : from));
  let n = 0;
  for (const s of drawing.steps) n += convertLayers(s.layers, from, toHead, ctx, project);
  drawing.head = toHead;
  return n;
}
