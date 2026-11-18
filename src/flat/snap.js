// SPDX-License-Identifier: AGPL-3.0-only
// 2D 頭圖的吸附、對齊、完善線條、點一下填滿的幾何。純函式，瀏覽器與 Node 共用。座標是公釐；px＝這個縮放下 1 個螢幕像素是幾公釐。
import { geom, dist, segDist, nearestOnPolyline, PATH_TYPES, curveControl } from './shapes.js';

export const SNAP_IN = 6, SNAP_KEEP = 9;          // 吸附：進入 6 px、已經吸住的離開 9 px 才放開
export const ANGLE_TOL = 3, ANGLE_MIN = 8;          // 方向：差 3° 以內、長度超過 8 px 才轉正到 45° 的倍數
export const GUIDE_TOL = 2.5;                       // 對齊輔助線：x 或 y 差 2.5 px 以內
export const MAGIC_TOL = 6;                         // 完善線條：6 px 以內的線端才接

// 吸附點：cands＝[{ id, p, kind }]（kind：point 點位／end 線端／path 線上）。locked＝上一次吸住的 id
// 已經吸住的目標在 9 px 內就不換；其他照「點位、線端優先於線上」再比遠近
export function snapPoint(p, cands, px, locked = null) {
  if (locked) { const l = cands.find(c => c.id === locked); if (l && dist(p, l.p) <= SNAP_KEEP * px) return l; }
  let best = null, bd = Infinity, br = 2;
  for (const c of cands) {
    const d = dist(p, c.p); if (d > SNAP_IN * px) continue;
    const rank = c.kind === 'path' ? 1 : 0;
    if (rank < br || (rank === br && d < bd)) { best = c; bd = d; br = rank; }
  }
  return best;
}
// 線上最近的點當候選（頭的外框、髮際線、別的線）：回傳 { id, p, kind:'path' } 或 null
export function nearestPathPoint(p, paths, px) {
  let best = null;
  for (const path of paths) {
    const n = nearestOnPolyline(p, path.pts);
    if (n.d <= SNAP_IN * px && (!best || n.d < best.d)) best = { d: n.d, id: path.id, p: n.q, kind: 'path' };
  }
  return best;
}

// 方向磁吸：從 a 拉到 b，接近水平、垂直或 45° 的倍數就轉正（長度不變）
export function snapDirection(a, b, px) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  if (L < ANGLE_MIN * px) return null;
  const ang = Math.atan2(dy, dx) * 180 / Math.PI, k = Math.round(ang / 45) * 45;
  if (Math.abs(ang - k) > ANGLE_TOL) return null;
  const r = k * Math.PI / 180;
  return { p: [a[0] + L * Math.cos(r), a[1] + L * Math.sin(r)], deg: ((k % 360) + 360) % 360 };
}
// 對齊輔助線：p 的 x 或 y 和別的線端差一點點就對齊。回傳 { p, guides:[{ axis:'x'|'y', v, from }] }
export function alignGuides(p, others, px) {
  let bx = null, by = null;
  for (const o of others) {
    const dx = Math.abs(o[0] - p[0]), dy = Math.abs(o[1] - p[1]);
    if (dx <= GUIDE_TOL * px && (!bx || dx < bx.d)) bx = { d: dx, v: o[0], from: o };
    if (dy <= GUIDE_TOL * px && (!by || dy < by.d)) by = { d: dy, v: o[1], from: o };
  }
  const q = [bx ? bx.v : p[0], by ? by.v : p[1]], guides = [];
  if (bx) guides.push({ axis: 'x', v: bx.v, from: bx.from });
  if (by) guides.push({ axis: 'y', v: by.v, from: by.from });
  return { p: q, guides };
}

// 線端：可以加箭頭的線（直線、曲線、折線、手畫線）的頭尾
export function endpoints(shapes) {
  const out = [];
  for (const s of shapes) if (PATH_TYPES.includes(s.type)) { out.push({ s, k: 0, p: s.pts[0] }); out.push({ s, k: s.pts.length - 1, p: s.pts[s.pts.length - 1] }); }
  return out;
}
// 把一筆的某個線端搬到 q（曲線的中間點跟著搬一半，形狀不會歪掉）
export function moveEnd(s, k, q) {
  const old = s.pts[k], dx = q[0] - old[0], dy = q[1] - old[1];
  s.pts[k] = [q[0], q[1]];
  if (s.type === 'curve' && s.m) s.m = [s.m[0] + dx / 2, s.m[1] + dy / 2];
}

// 射線（從 o 往 dir）和折線的第一個交點，距離在 maxD 以內
function rayHit(o, dir, pts, maxD) {
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dir[0] * ey - dir[1] * ex; if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den, u = ((a[0] - o[0]) * dir[1] - (a[1] - o[1]) * dir[0]) / den;
    if (t >= -maxD && t <= maxD && u >= 0 && u <= 1 && (!best || Math.abs(t) < Math.abs(best.t))) best = { t, p: [o[0] + dir[0] * t, o[1] + dir[1] * t] };
  }
  return best;
}
// 完善線條：shapes＝這個視圖可以動的筆（沒選＝全部線；有選＝選的那些），all＝這個視圖全部的筆，refs＝頭的外框與髮際線 [{ id, pts }]
// 1) 兩條線的線端很近 → 接在一起（取中點）；2) 線端靠近頭的外框、髮際線或別的線 → 沿線的方向延長或縮短到剛好碰到。
// 已經接好的（差不到 0.05 mm）不動。回傳改了幾個線端（就地改）。
export function magicAlign(shapes, all, refs, px) {
  const tol = MAGIC_TOL * px, ends = endpoints(shapes), done = new Set();
  let n = 0;
  const key = e => e.s.id + ':' + e.k;
  const allEnds = endpoints(all);
  for (const e of ends) {
    if (done.has(key(e))) continue;
    let best = null, bd = Infinity;
    for (const o of allEnds) {
      if (o.s === e.s || (e.s.mirrorPairId && o.s.id === e.s.mirrorPairId)) continue;
      const d = dist(e.p, o.p);
      if (d < bd) { bd = d; best = o; }
    }
    if (best && bd <= tol) {
      if (bd > 0.05) {
        const m = [(e.p[0] + best.p[0]) / 2, (e.p[1] + best.p[1]) / 2];
        const movable = shapes.includes(best.s);
        moveEnd(e.s, e.k, movable ? m : best.p); if (movable) moveEnd(best.s, best.k, m);
        n += movable ? 2 : 1;
      }
      done.add(key(e)); done.add(key(best));
    }
  }
  for (const e of ends) {
    if (done.has(key(e))) continue;
    const g = geom(e.s), end = e.k === 0 ? g.ends.a : g.ends.b;
    const targets = refs.concat(all.filter(s => s !== e.s && s.id !== e.s.mirrorPairId && s.type !== 'text' && s.type !== 'icon' && s.type !== 'dot').map(s => ({ id: s.id, pts: geom(s).pts })));
    let hit = null;
    for (const t of targets) { const h = rayHit(end.p, end.dir, t.pts, tol); if (h && (!hit || Math.abs(h.t) < Math.abs(hit.t))) hit = h; }
    if (!hit) for (const t of targets) { const q = nearestOnPolyline(end.p, t.pts); if (q.d <= tol && (!hit || q.d < Math.abs(hit.t))) hit = { t: q.d, p: q.q }; }
    if (hit && Math.abs(hit.t) > 0.05) {
      const len = dist(e.s.pts[0], e.s.pts[e.s.pts.length - 1]);
      const other = e.s.pts[e.k === 0 ? e.s.pts.length - 1 : 0];
      if (e.s.type === 'line' && dist(hit.p, other) < Math.min(len, 8) * 0.5) continue; // 縮太短就不動
      moveEnd(e.s, e.k, hit.p); n++;
    }
    done.add(key(e));
  }
  return n;
}

// ---------------------------------------------------------------- 點一下填滿（在格子上做）
// grid：Uint8Array，1＝邊界（線）、0＝空；從 (x,y) 往四方填，碰到邊界或格子外緣就停。
// 回傳 { mask, count, touchesEdge }；touchesEdge＝填到格子外緣（沒有圍起來）
export function flood(grid, W, H, x, y) {
  const mask = new Uint8Array(W * H);
  if (x < 0 || y < 0 || x >= W || y >= H || grid[y * W + x]) return { mask, count: 0, touchesEdge: false };
  const stack = [y * W + x]; mask[y * W + x] = 1;
  let count = 0, touchesEdge = false;
  while (stack.length) {
    const i = stack.pop(); count++;
    const cx = i % W, cy = (i - cx) / W;
    if (cx === 0 || cy === 0 || cx === W - 1 || cy === H - 1) touchesEdge = true;
    for (const j of [cx > 0 ? i - 1 : -1, cx < W - 1 ? i + 1 : -1, cy > 0 ? i - W : -1, cy < H - 1 ? i + W : -1]) if (j >= 0 && !mask[j] && !grid[j]) { mask[j] = 1; stack.push(j); }
  }
  return { mask, count, touchesEdge };
}
// 填好的區塊往外長 r 格（蓋住邊界線的一半，面才會貼著線）
export function grow(mask, W, H, r) {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const nxt = cur.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (cur[i]) continue; if ((x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1]) || (y > 0 && cur[i - W]) || (y < H - 1 && cur[i + W])) nxt[i] = 1; }
    cur = nxt;
  }
  return cur;
}
// mask 的外緣描成閉合折線（像素座標），再簡化
export function traceMask(mask, W, H, tol = 1.2) {
  let start = -1;
  for (let i = 0; i < W * H && start < 0; i++) if (mask[i]) start = i;
  if (start < 0) return [];
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x];
  let x = start % W, y = Math.floor(start / W), d = 6;
  const sx = x, sy = y, pts = [[x, y]];
  for (let guard = 0; guard < W * H * 2; guard++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (d + 6 + k) % 8, nx = x + dirs[nd][0], ny = y + dirs[nd][1];
      if (inside(nx, ny)) { x = nx; y = ny; d = nd; found = true; break; }
    }
    if (!found || (x === sx && y === sy)) break;
    pts.push([x, y]);
  }
  return simplifyClosed(pts, tol);
}
export function simplifyClosed(pts, tol) {
  if (pts.length < 8) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = 1;
  let far = 0, fd = -1;
  pts.forEach((p, i) => { const d = dist(p, pts[0]); if (d > fd) { fd = d; far = i; } });
  keep[far] = 1;
  const stack = [[0, far], [far, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(); let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) { const dd = segDist(pts[k], pts[i], pts[j]); if (dd > bd) { bd = dd; best = k; } }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  keep[pts.length - 1] = 1;
  return pts.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------- 局部擦掉
// 把一筆線在擦子（圓心 c、半徑 r）碰到的地方切開，回傳剩下的幾段（點列；每段至少兩點）。沒碰到回傳 null
export function eraseSplit(s, c, r) {
  const pts = densePoints(s);
  if (!pts.some(p => dist(p, c) <= r) && !pts.some((p, i) => i && segDist(c, pts[i - 1], p) <= r)) return null;
  const runs = []; let cur = [];
  for (const p of pts) { if (dist(p, c) > r) cur.push(p); else { if (cur.length >= 2) runs.push(cur); cur = []; } }
  if (cur.length >= 2) runs.push(cur);
  return runs.filter(run => dist(run[0], run[run.length - 1]) > 0.4 || run.length > 3);
}
// 線的取樣點（直線每 1 mm 補點，擦的時候才切得細）
export function densePoints(s) {
  const g = geom(s), out = [];
  for (let i = 0; i < g.pts.length; i++) {
    const p = g.pts[i];
    if (i) { const a = g.pts[i - 1], n = Math.floor(dist(a, p)); for (let k = 1; k < n; k++) out.push([a[0] + (p[0] - a[0]) * k / n, a[1] + (p[1] - a[1]) * k / n]); }
    out.push(p);
  }
  return out;
}
export { curveControl };
