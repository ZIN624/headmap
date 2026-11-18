// SPDX-License-Identifier: AGPL-3.0-only
// 點一下填色。點在線圍起來的地方，就找出「這一塊」的邊界（一圈點），交給 app.js 存成一塊面。
// 邊界＝這一頁已經畫的線（分線、曲線、手畫線、髮片的根線、別的面的邊）＋外輪廓。沒有圍起來（這一塊就是整顆頭）回 'open'，不填。
// 這裡只算幾何；顏色、鏡像、復原由 app.js 處理。
//
// 做法（都在「從頭心看出去的方向」上算，和 scalp.regionPositions 判斷三角形在不在面裡面用同一套）：
//   1. 可畫網格每個三角形切成四小塊（三個角＋中間），小塊之間照共用邊相鄰。只切一次，存在 scalp 上。
//   2. 相鄰兩小塊的重心連線，被任何一段邊界線穿過＝這兩塊不相通。只檢查邊界線附近的（格子分桶）。
//   3. 從點的那一小塊往外擴（不能穿過邊界）＝這一塊。只擋外輪廓再擴一次＝整個髮區；兩個面積差不到 1 cm² 就是沒有圍起來。
//   4. 沿著這一塊的邊走一圈：每一步被哪一段邊界線擋住，就記那個交點（在真的線上）；兩條線交接的地方補上交點（轉角才是尖的）。
//      線頭離別的線或外輪廓不到 4 mm 當成接上（每條線兩端各延長 4 mm 來擋，延長的那一段不進邊界）。
//   5. 裡面有一圈別的線（例如頭頂畫了一個圓，點在圓外面）：把那一圈用一條來回的縫接進邊界（面積不變）。
import { Vector3 } from '../vendor/three/build/three.module.js';
import { rdp, insideSphericalPolygon, toV } from './geometry.js';

const FILL_GAP = 0.004;        // 線頭離別的線／外輪廓不到 4 mm：當成接上
const FILL_MIN_REST = 1e-4;    // 這一塊以外剩不到 1 cm²＝整顆頭＝沒有圍起來
const FILL_HOLE_MIN = 5e-5;    // 裡面那一圈圍住的面積不到 0.5 cm²：不算洞（只是一條沒圍起來的線）
const FILL_LOOP_TOL = 0.0002;  // 邊界減點：離減點前的線不超過 0.2 mm
const CORNER_REACH = 0.012, BETWEEN_MAX = 0.04;

// ---------------------------------------------------------------- 1. 小塊的相鄰關係（只跟網格有關，算一次）
// 小塊編號＝三角形 × 4 ＋（0、1、2＝三個角；3＝中間）。每一小塊三條邊：nb＝對面是哪一小塊（−1＝網格的邊）、nbe＝在對面那一塊是第幾條邊。
// vid＝三個頂點的名字（網格的頂點＝編號；邊的中點＝−(邊的鍵＋1)），走邊界時用它認同一個頂點。
function fillTopology(scalp) {
  const g = scalp.scalpGeometry;
  if (scalp._fillTopo && scalp._fillTopo.g === g) return scalp._fillTopo;
  const T = scalp._triCount, idx = scalp._idx, pos = scalp._pos, edges = scalp._edges(), V = pos.count, C = scalp.center;
  const key = (i, j) => Math.min(i, j) * V + Math.max(i, j);
  const nbTri = new Int32Array(T * 3).fill(-1);
  for (let t = 0; t < T; t++) for (let e = 0; e < 3; e++) {
    const arr = edges.get(key(idx.getX(t * 3 + e), idx.getX(t * 3 + (e + 1) % 3)));
    if (arr && arr.length === 2) nbTri[t * 3 + e] = arr[0] === t ? arr[1] : arr[0];
  }
  const N = T * 4;
  const vid = new Float64Array(N * 3), nb = new Int32Array(N * 3).fill(-1), nbe = new Int8Array(N * 3).fill(-1);
  const cen = new Float64Array(N * 3), dir = new Float64Array(N * 3), area = new Float64Array(N);
  const P = [new Vector3(), new Vector3(), new Vector3()], c = new Vector3(), ab = new Vector3(), ac = new Vector3();
  const cornerOf = (n, v) => { for (let k = 0; k < 3; k++) if (idx.getX(n * 3 + k) === v) return n * 4 + k; return -1; };
  let maxAdj = 0;
  for (let t = 0; t < T; t++) {
    const v = [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)];
    for (let k = 0; k < 3; k++) P[k].fromBufferAttribute(pos, v[k]);
    const M = [0, 1, 2].map(e => -(key(v[e], v[(e + 1) % 3]) + 1));
    const quarter = ab.subVectors(P[1], P[0]).cross(ac.subVectors(P[2], P[0])).length() / 8;
    for (let s = 0; s < 4; s++) {
      const o = (t * 4 + s) * 3;
      if (s < 3) {
        const p = (s + 2) % 3, q = (s + 1) % 3;
        vid[o] = v[s]; vid[o + 1] = M[s]; vid[o + 2] = M[p];
        c.copy(P[s]).multiplyScalar(2).addScaledVector(P[q], 0.5).addScaledVector(P[p], 0.5).multiplyScalar(1 / 3);
        const n0 = nbTri[t * 3 + s], n2 = nbTri[t * 3 + p];
        nb[o] = n0 < 0 ? -1 : cornerOf(n0, v[s]); nb[o + 1] = t * 4 + 3; nb[o + 2] = n2 < 0 ? -1 : cornerOf(n2, v[s]);
      } else {
        vid[o] = M[0]; vid[o + 1] = M[1]; vid[o + 2] = M[2];
        c.copy(P[0]).add(P[1]).add(P[2]).multiplyScalar(1 / 3);
        nb[o] = t * 4 + 1; nb[o + 1] = t * 4 + 2; nb[o + 2] = t * 4;
      }
      cen[o] = c.x; cen[o + 1] = c.y; cen[o + 2] = c.z;
      c.sub(C).normalize(); dir[o] = c.x; dir[o + 1] = c.y; dir[o + 2] = c.z;
      area[t * 4 + s] = quarter;
    }
  }
  for (let s = 0; s < N; s++) for (let e = 0; e < 3; e++) {
    const i = s * 3 + e, n = nb[i]; if (n < 0) continue;
    const a = vid[i], b = vid[s * 3 + (e + 1) % 3];
    let found = -1;
    for (let k = 0; k < 3; k++) { const x = vid[n * 3 + k], y = vid[n * 3 + (k + 1) % 3]; if ((x === a && y === b) || (x === b && y === a)) { found = k; break; } }
    if (found < 0) { nb[i] = -1; continue; } // 對不上（網格不乾淨）：當成邊
    nbe[i] = found;
    maxAdj = Math.max(maxAdj, Math.hypot(cen[i - e] - cen[n * 3], cen[i - e + 1] - cen[n * 3 + 1], cen[i - e + 2] - cen[n * 3 + 2]));
  }
  let total = 0; for (let s = 0; s < N; s++) total += area[s];
  return scalp._fillTopo = { g, N, T, V, vid, nb, nbe, nbTri, cen, dir, area, maxAdj, total };
}

// ---------------------------------------------------------------- 2. 邊界線切成一段一段，放進格子
function buildSegments(scalp, boundaries, gap, h) {
  const C = scalp.center, segs = [], lines = [];
  boundaries.forEach((b, k) => {
    const pts = [];
    for (const p of b.points || []) { const v = toV(p); if (!pts.length || v.distanceTo(pts[pts.length - 1]) > 1e-7) pts.push(v); }
    const closed = !!b.closed;
    if (closed && pts.length > 2 && pts[0].distanceTo(pts[pts.length - 1]) <= 1e-7) pts.pop();
    const line = { k, pts, closed, outline: !!b.outline, segs: [] };
    lines.push(line);
    if (pts.length < 2) return;
    const add = (pa, pb, j, ext) => {
      const a = pa.clone().sub(C).normalize(), bb = pb.clone().sub(C).normalize(), n = a.clone().cross(bb);
      if (n.lengthSq() < 1e-22) return;
      const s = { id: segs.length, k, j, ext, outline: line.outline, ord: line.segs.length, pa, pb, ax: a.x, ay: a.y, az: a.z, bx: bb.x, by: bb.y, bz: bb.z, nx: n.x, ny: n.y, nz: n.z, len: pa.distanceTo(pb) };
      segs.push(s); line.segs.push(s);
    };
    // 線頭往外延長 gap（照最後 2 mm 的方向）：只用來擋，不進邊界
    const tangent = end => { const e = end ? pts[pts.length - 1] : pts[0]; let i = end ? pts.length - 2 : 1; while (i > 0 && i < pts.length - 1 && pts[i].distanceTo(e) < 0.002) i += end ? -1 : 1; return e.clone().sub(pts[i]).normalize(); };
    if (!closed && gap > 0) add(pts[0].clone().addScaledVector(tangent(false), gap), pts[0], -1, true);
    const n = pts.length;
    for (let j = 0; j + 1 < n; j++) add(pts[j], pts[j + 1], j, false);
    if (closed) add(pts[n - 1], pts[0], n - 1, false);
    else if (gap > 0) add(pts[n - 1], pts[n - 1].clone().addScaledVector(tangent(true), gap), n - 1, true);
  });
  // 格子：每一段放進它經過的格子和周圍一圈（查的時候只要看一格）
  const grid = new Map(), cell = x => Math.floor(x / h) + 512;
  const put = (ix, iy, iz, s) => { const kk = (ix * 1024 + iy) * 1024 + iz; let arr = grid.get(kk); if (!arr) grid.set(kk, arr = []); if (arr[arr.length - 1] !== s) arr.push(s); };
  for (const s of segs) {
    const steps = Math.max(1, Math.ceil(s.len / (h / 2)));
    let lx = NaN, ly = NaN, lz = NaN;
    for (let q = 0; q <= steps; q++) {
      const u = q / steps, ix = cell(s.pa.x + (s.pb.x - s.pa.x) * u), iy = cell(s.pa.y + (s.pb.y - s.pa.y) * u), iz = cell(s.pa.z + (s.pb.z - s.pa.z) * u);
      if (ix === lx && iy === ly && iz === lz) continue;
      lx = ix; ly = iy; lz = iz;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) put(ix + dx, iy + dy, iz + dz, s);
    }
  }
  const near = (x, y, z) => grid.get((cell(x) * 1024 + cell(y)) * 1024 + cell(z));
  return { segs, lines, near };
}

// 方向 A→B 的弧有沒有穿過線段 s。穿過回傳在 A→B 上的比例（0～1），並把在 s 上的比例放在 _t；沒穿過回 −1。
// 剛好壓在面上的點一律算正的那一側（相鄰兩段共用的端點不會兩段都漏掉）。
let _t = 0;
function crossArc(ax, ay, az, bx, by, bz, s) {
  const n1x = ay * bz - az * by, n1y = az * bx - ax * bz, n1z = ax * by - ay * bx;
  const sC = n1x * s.ax + n1y * s.ay + n1z * s.az, sD = n1x * s.bx + n1y * s.by + n1z * s.bz;
  if ((sC >= 0) === (sD >= 0)) return -1;
  const sA = s.nx * ax + s.ny * ay + s.nz * az, sB = s.nx * bx + s.ny * by + s.nz * bz;
  if ((sA >= 0) === (sB >= 0)) return -1;
  // 兩個大圓有兩個交點：要的是兩段弧都在的那一邊
  const lx = n1y * s.nz - n1z * s.ny, ly = n1z * s.nx - n1x * s.nz, lz = n1x * s.ny - n1y * s.nx;
  const d1 = lx * (ax + bx) + ly * (ay + by) + lz * (az + bz), d2 = lx * (s.ax + s.bx) + ly * (s.ay + s.by) + lz * (s.az + s.bz);
  if (d1 * d2 <= 0) return -1;
  _t = sC / (sC - sD);
  return sA / (sA - sB);
}

// ---------------------------------------------------------------- 主程式
// boundaries：[{ points:[Vector3（抬高過的密集點，就是畫面上那條線）], closed?, outline? }]。outline＝外輪廓（最多一條）。
// 回傳 { ok:true, loop:[Vector3（頭皮上、沒抬高）], area, total, rest, holes, contains(p) }
//   或 { ok:false, reason:'outside'（點在外輪廓外面）｜'open'（沒有圍起來）｜'tiny'（這一塊比網格還小，點不到）, ... }。
export function fillCell(scalp, seed, boundaries, { gap = FILL_GAP, minRest = FILL_MIN_REST, tol = FILL_LOOP_TOL } = {}) {
  const topo = fillTopology(scalp), { N, vid, nb, nbe, nbTri, cen, dir, area } = topo, C = scalp.center;
  const h = Math.max(0.004, topo.maxAdj * 1.3);
  const { segs, lines, near } = buildSegments(scalp, boundaries, gap, h);
  const outline = boundaries.find(b => b.outline && b.points && b.points.length >= 3);
  const hit = scalp.nearest(seed), P = hit.point, pd = P.clone().sub(C).normalize();
  if (outline && !insideSphericalPolygon(pd, outline.points.map(p => toV(p).clone().sub(C).normalize()))) return { ok: false, reason: 'outside' };

  // 相鄰兩小塊之間有沒有被擋：blkSeg＝從這一塊出發最先碰到的那一段（−1＝沒擋）、blkT＝交點在那一段上的比例、blkOut＝擋的裡面有外輪廓
  const blkSeg = new Int32Array(N * 3).fill(-1), blkT = new Float32Array(N * 3), blkOut = new Uint8Array(N * 3);
  for (let s = 0; s < N; s++) for (let e = 0; e < 3; e++) {
    const i = s * 3 + e, n = nb[i]; if (n <= s) continue;
    const so = s * 3, no = n * 3;
    const cands = near((cen[so] + cen[no]) / 2, (cen[so + 1] + cen[no + 1]) / 2, (cen[so + 2] + cen[no + 2]) / 2);
    if (!cands) continue;
    let s1 = -1, u1 = 2, t1 = 0, s2 = -1, u2 = -1, t2 = 0, out = 0;
    for (const sg of cands) {
      const u = crossArc(dir[so], dir[so + 1], dir[so + 2], dir[no], dir[no + 1], dir[no + 2], sg);
      if (u < 0) continue;
      if (sg.outline) out = 1;
      if (u < u1) { u1 = u; s1 = sg.id; t1 = _t; }
      if (u > u2) { u2 = u; s2 = sg.id; t2 = _t; }
    }
    if (s1 < 0) continue;
    const i2 = no + nbe[i];
    blkSeg[i] = s1; blkT[i] = t1; blkOut[i] = out; blkSeg[i2] = s2; blkT[i2] = t2; blkOut[i2] = out;
  }

  // 點在哪一小塊：點所在的三角形和它旁邊三個三角形的小塊裡，離點最近、而且和點之間沒有隔著線的那一塊
  const clear = (p, pdir, s) => {
    const o = s * 3;
    for (const u of [0, 0.5, 1]) { // 點、中間、重心三個位置附近的線段都查（點離重心可以到 8 mm）
      const cands = near(p.x + (cen[o] - p.x) * u, p.y + (cen[o + 1] - p.y) * u, p.z + (cen[o + 2] - p.z) * u);
      if (cands) for (const sg of cands) if (crossArc(pdir.x, pdir.y, pdir.z, dir[o], dir[o + 1], dir[o + 2], sg) >= 0) return false;
    }
    return true;
  };
  const subOf = (p, pdir, face) => {
    const tris = [face]; for (let e = 0; e < 3; e++) { const n = nbTri[face * 3 + e]; if (n >= 0) tris.push(n); }
    const cs = [];
    for (const t of tris) for (let q = 0; q < 4; q++) { const s = t * 4 + q, o = s * 3; cs.push({ s, d: Math.hypot(cen[o] - p.x, cen[o + 1] - p.y, cen[o + 2] - p.z) }); }
    cs.sort((a, b) => a.d - b.d);
    for (const c of cs) if (clear(p, pdir, c.s)) return c.s;
    return -1;
  };
  const start = subOf(P, pd, hit.faceIndex);
  if (start < 0) return { ok: false, reason: 'tiny' };

  const flood = pass => {
    const mark = new Uint8Array(N), stack = [start]; mark[start] = 1; let a = 0;
    while (stack.length) { const s = stack.pop(); a += area[s]; for (let e = 0; e < 3; e++) { const i = s * 3 + e, n = nb[i]; if (n < 0 || mark[n] || !pass(i)) continue; mark[n] = 1; stack.push(n); } }
    return { mark, area: a };
  };
  const whole = flood(i => !blkOut[i]), cell = flood(i => blkSeg[i] < 0);
  const rest = whole.area - cell.area;
  const contains = q => { const hq = scalp.nearest(q), qd = hq.point.clone().sub(C).normalize(), s = subOf(hq.point, qd, hq.faceIndex); return s >= 0 && cell.mark[s] === 1; };
  if (rest < minRest) return { ok: false, reason: 'open', area: cell.area, total: whole.area, rest, contains };

  // 沿著這一塊的邊走：每一條被擋住的邊（或網格的邊）接到下一條——繞著邊的終點轉，穿過沒被擋的邊，直到又碰到被擋的邊
  const isEdge = i => blkSeg[i] >= 0 || nb[i] < 0, seen = new Uint8Array(N * 3);
  const next = i => {
    const s = (i / 3) | 0, e = i % 3, w = vid[s * 3 + (e + 1) % 3];
    let cs = s, ce = (e + 1) % 3;
    for (let guard = 0; guard < 4096; guard++) {
      const ci = cs * 3 + ce;
      if (isEdge(ci)) return ci;
      const n = nb[ci], ne = nbe[ci];
      ce = vid[n * 3 + ne] === w ? (ne + 2) % 3 : (ne + 1) % 3; cs = n;
    }
    return -1;
  };
  const posOf = id => { if (id >= 0) return new Vector3().fromBufferAttribute(scalp._pos, id); const k = -id - 1, i = Math.floor(k / topo.V), j = k - i * topo.V; return new Vector3().fromBufferAttribute(scalp._pos, i).add(new Vector3().fromBufferAttribute(scalp._pos, j)).multiplyScalar(0.5); };
  const hitOf = i => {
    if (blkSeg[i] >= 0) { const sg = segs[blkSeg[i]]; return { seg: sg, X: sg.pa.clone().lerp(sg.pb, blkT[i]) }; }
    const s = (i / 3) | 0, e = i % 3; return { seg: null, X: posOf(vid[i]).add(posOf(vid[s * 3 + (e + 1) % 3])).multiplyScalar(0.5) };
  };
  const loops = [];
  for (let s = 0; s < N; s++) {
    if (!cell.mark[s]) continue;
    for (let e = 0; e < 3; e++) {
      const i0 = s * 3 + e; if (!isEdge(i0) || seen[i0]) continue;
      const hits = []; let i = i0, okLoop = true;
      for (let guard = 0; guard <= N * 3; guard++) { seen[i] = 1; hits.push(hitOf(i)); i = next(i); if (i === i0) break; if (i < 0 || seen[i]) { okLoop = false; break; } }
      if (okLoop && hits.length >= 3) loops.push(loopPoints(hits, lines));
    }
  }
  if (!loops.length) return { ok: false, reason: 'tiny', contains };
  // 最大的一圈是外圈；其他的圍住的面積夠大才是洞（不夠大＝只是一條沒接上的線），用一條來回的縫接進外圈
  const sized = loops.filter(l => l.length >= 3).map(l => ({ pts: l, a: vectorArea(l) })).sort((a, b) => b.a - a.a);
  if (!sized.length) return { ok: false, reason: 'tiny', contains };
  let ring = sized[0].pts, holes = 0;
  for (const hl of sized.slice(1)) { if (hl.a < FILL_HOLE_MIN) continue; ring = stitch(ring, hl.pts); holes++; }
  const simp = rdp(ring.concat([ring[0]]), tol); simp.pop();
  if (simp.length < 3) return { ok: false, reason: 'tiny', contains };
  return { ok: true, loop: simp.map(p => scalp.nearest(p).point), area: cell.area, total: whole.area, rest, holes, contains };
}

// ---------------------------------------------------------------- 4. 一圈交點 → 邊界上的點
function loopPoints(hits, lines) {
  const out = [], push = p => { if (!out.length || out[out.length - 1].distanceToSquared(p) > 1e-14) out.push(p); };
  for (let i = 0; i < hits.length; i++) {
    const a = hits[i], b = hits[(i + 1) % hits.length];
    if (!a.seg || !a.seg.ext) push(a.X);
    if (!a.seg || !b.seg) continue;
    if (a.seg.k === b.seg.k) { if (!a.seg.ext && !b.seg.ext && a.seg.j !== b.seg.j) between(lines[a.seg.k], a.seg.j, b.seg.j, push); }
    else { const c = corner(lines[a.seg.k], a.seg, lines[b.seg.k], b.seg, a.X, b.X); if (c) push(c); }
  }
  if (out.length > 1 && out[0].distanceToSquared(out[out.length - 1]) <= 1e-14) out.pop();
  return out;
}
// 同一條線上從第 j1 段走到第 j2 段：中間經過的頂點照順序補上（閉合的線走短的那一邊）；跳太遠（不是沿著線走）就不補
function between(line, j1, j2, push) {
  const pts = line.pts, n = pts.length, list = [];
  if (!line.closed) { if (j2 > j1) for (let j = j1 + 1; j <= j2; j++) list.push(pts[j]); else for (let j = j1; j > j2; j--) list.push(pts[j]); }
  else { const f = (j2 - j1 + n) % n, bk = n - f; if (f <= bk) for (let q = 1; q <= f; q++) list.push(pts[(j1 + q) % n]); else for (let q = 0; q < bk; q++) list.push(pts[(j1 - q + n) % n]); }
  let len = 0; for (let i = 1; i < list.length; i++) len += list[i].distanceTo(list[i - 1]);
  if (len > BETWEEN_MAX) return;
  for (const p of list) push(p.clone());
}
// 兩條線交接的地方：在兩個交點附近（沿線各 12 mm 內，含延長段）找兩條線真的交叉的那一點
function corner(lineA, segA, lineB, segB, XA, XB) {
  const around = (line, sg) => {
    const L = line.segs, n = L.length, out = [sg];
    for (const stepDir of [1, -1]) { let acc = 0; for (let q = 1; q < n; q++) { let o = sg.ord + stepDir * q; if (line.closed) o = ((o % n) + n) % n; else if (o < 0 || o >= n) break; if (L[o] === sg) break; out.push(L[o]); acc += L[o].len; if (acc > CORNER_REACH) break; } }
    return out;
  };
  const mid = XA.clone().add(XB).multiplyScalar(0.5);
  let best = null, bd = Infinity;
  for (const a of around(lineA, segA)) for (const b of around(lineB, segB)) {
    const u = crossArc(a.ax, a.ay, a.az, a.bx, a.by, a.bz, b);
    if (u < 0) continue;
    const p = a.pa.clone().lerp(a.pb, u), d = p.distanceTo(mid);
    if (d < bd) { bd = d; best = p; }
  }
  return best && bd < CORNER_REACH ? best : null;
}
// 一圈點圍住的面積（向量面積的大小：繞過半顆頭的大圈也還是大的）
function vectorArea(pts) {
  const c = new Vector3(); for (const p of pts) c.add(p); c.multiplyScalar(1 / pts.length);
  const sum = new Vector3(), a = new Vector3(), b = new Vector3();
  for (let i = 0; i < pts.length; i++) { a.subVectors(pts[i], c); b.subVectors(pts[(i + 1) % pts.length], c); sum.add(a.cross(b)); }
  return sum.length() / 2;
}
// 把洞接進外圈：找兩圈最近的一對點，外圈走到那裡 → 繞洞一圈 → 回到外圈（來回同一條縫，面積互相抵銷）
function stitch(ring, hole) {
  let bi = 0, bj = 0, bd = Infinity;
  const si = Math.max(1, Math.floor(ring.length / 400)), sj = Math.max(1, Math.floor(hole.length / 400));
  for (let i = 0; i < ring.length; i += si) for (let j = 0; j < hole.length; j += sj) { const d = ring[i].distanceToSquared(hole[j]); if (d < bd) { bd = d; bi = i; bj = j; } }
  return [...ring.slice(0, bi + 1), ...hole.slice(bj), ...hole.slice(0, bj + 1).map(p => p.clone()), ring[bi].clone(), ...ring.slice(bi + 1)];
}
