// SPDX-License-Identifier: AGPL-3.0-only
// 2D 頭圖的動畫：一筆一筆畫出來。純函式，瀏覽器與 Node 共用。單位是影格（每秒 30 格）。
// 規則：
//   一個步驟＝一段。段裡照畫的順序一筆接一筆，下一筆在上一筆開始後 STAGGER 格就開始（會重疊，看起來是連續的）。
//   平行的直線（同種類、方向差不多、並排、彼此靠近）自動併成一組，同時畫。
//   下一段要等上一段全部畫完再過 GAP 格才開始。最後停 HOLD 格。
//   速度三段：每一筆畫多久（慢 23、中 14、快 8 格）。

export const FPS = 30;
export const SPEEDS = { slow: 23, normal: 14, fast: 8 };
export const STAGGER = 6, GAP = 9, HOLD = 23;

// 可以自動併組的直線：種類＝實直線、虛直線、直箭頭（各自一類）
function lineClass(s) {
  if (s.type !== 'line') return null;
  if (s.ends && (s.ends.a === 'arrow' || s.ends.b === 'arrow')) return 'arrow';
  return s.style.dash === 'solid' ? 'line' : 'dash';
}
function canGroup(a, b) {
  const ca = lineClass(a), cb = lineClass(b);
  if (!ca || ca !== cb || a.view !== b.view) return false;
  const va = [a.pts[1][0] - a.pts[0][0], a.pts[1][1] - a.pts[0][1]], vb = [b.pts[1][0] - b.pts[0][0], b.pts[1][1] - b.pts[0][1]];
  const la = Math.hypot(...va), lb = Math.hypot(...vb); if (!la || !lb) return false;
  const cos = (va[0] * vb[0] + va[1] * vb[1]) / (la * lb);
  const ang = Math.acos(Math.max(-1, Math.min(1, ca === 'arrow' ? cos : Math.abs(cos)))) * 180 / Math.PI; // 箭頭要同方向；線不分方向
  if (ang > (ca === 'arrow' ? 15 : 3)) return false;
  // 沿 a 的方向投影：兩條重疊的長度至少是比較短那條的一半
  const ux = va[0] / la, uy = va[1] / la, proj = p => (p[0] - a.pts[0][0]) * ux + (p[1] - a.pts[0][1]) * uy;
  const a0 = 0, a1 = la, b0 = Math.min(proj(b.pts[0]), proj(b.pts[1])), b1 = Math.max(proj(b.pts[0]), proj(b.pts[1]));
  const overlap = Math.min(a1, b1) - Math.max(a0, b0);
  if (overlap < Math.min(la, lb) / 2) return false;
  // 兩條線之間的垂直距離
  const mid = [(b.pts[0][0] + b.pts[1][0]) / 2, (b.pts[0][1] + b.pts[1][1]) / 2];
  const gap = Math.abs((mid[0] - a.pts[0][0]) * -uy + (mid[1] - a.pts[0][1]) * ux);
  const L = Math.min(la, lb);
  return gap <= Math.min(Math.max(40, 0.75 * L), 60);
}
// 一段（一個步驟的筆）分組：回傳 [[shape, …], …]，照第一筆出現的順序
export function groupShapes(shapes) {
  const groupOf = new Map(), groups = [];
  for (const s of shapes) {
    let g = null;
    for (const t of shapes) { if (t === s || !groupOf.has(t.id)) continue; if (canGroup(t, s)) { g = groupOf.get(t.id); break; } }
    if (!g) { g = []; groups.push(g); }
    g.push(s); groupOf.set(s.id, g);
  }
  return groups;
}

// 整張圖的時間軸：steps＝[shapes 陣列]（每一步要動畫的筆，已經只留看得到的視圖）
// 回傳 { frames, items:[{ id, start, dur, step }], steps:[{ start, end }] }
export function timeline(steps, speed = 'normal') {
  const dur = SPEEDS[speed] || SPEEDS.normal, items = [], marks = [];
  let t = 0;
  steps.forEach((shapes, k) => {
    const groups = groupShapes(shapes), start = t;
    let end = t;
    groups.forEach((g, i) => { const s0 = t + i * STAGGER; for (const s of g) items.push({ id: s.id, start: s0, dur, step: k }); end = Math.max(end, s0 + dur); });
    marks.push({ start, end });
    t = groups.length ? end + GAP : t;
  });
  const last = marks.length ? Math.max(...marks.map(m => m.end)) : 0;
  return { frames: last + HOLD, items, steps: marks };
}
// 第 frame 格時每一筆畫到幾成（0～1）
export function progressAt(tl, frame) {
  const out = new Map();
  for (const it of tl.items) out.set(it.id, Math.max(0, Math.min(1, (frame - it.start) / it.dur)));
  return out;
}
// 慢慢加速再減速，看起來比較自然
export const ease = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
