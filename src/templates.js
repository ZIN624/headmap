// SPDX-License-Identifier: AGPL-3.0-only
// 分區樣板——正中線、耳到耳、四區、U型區、瀏海三角。
// 按一下樣板，就照頭模的點位（computeLandmarks 的十五點）算出分線；畫出來是一般的線，可以再選取微調、復原。
// 位置一律從點位算，不寫死座標：
//   正中線   C.P（前髮際中心）→ 頭頂 → N.P（後頸髮際中心）。一條垂直分線（section V、切面＝頭的左右正中面，見 section.js）。
//   耳到耳   經頭頂最高點 T.P，連到左右耳上 E.P。左右各一條放射分線（section R、樞軸＝正中線上的 T.P），所以一定通過 T.P。
//            （T.P 和 E.P 前後差幾 mm：一片前後向的垂直面同時通過兩個 E.P 就過不了 T.P，所以不用一條垂直線。）
//   四區     正中線＋耳到耳（三條線，在 T.P 相交）。
//   U型區    左額角 F.S.P → 頭側（G.P 的高度）→ G.P → 另一側 → 右額角：一條通過七個點的曲線，和結構線的「G.P 橫線」同一組點。
//   瀏海三角 尖端 C.T.M.P（C.P 和 T.P 的中點）連到左右額角 F.S.P：兩條一般的兩點線；底邊就是前髮際（外輪廓），不另外畫。
// 這裡只算位置（純幾何）；顏色、鏡像配對、復原由 app.js 處理。
import { azElToDir, mirrorX, toV } from './geometry.js';
import { findLandmark } from './landmarks.js';
import * as SEC from './section.js';

export const TEMPLATE_LABELS = { center: '正中線', ear: 'イヤーツーイヤー', four: '4ブロック', uzone: 'Uセクション', fringe: '前髪トライアングル' };
const SAME_TOL = 0.0015; // 兩條線的每個點都差不到 1.5 mm＝同一條（按第二次不重畫）

function landmark(scalp, lms, id, side = '') {
  const l = findLandmark(lms, id, side);
  if (!l) throw new Error('ヘッドにポイントがありません ' + id + (side ? '（' + side + '）' : ''));
  return scalp.nearest(l.point).point;
}
// 正中線上的點：x 歸零再貼回頭皮
const onMid = (scalp, p) => { const q = toV(p).clone(); q.x = 0; const r = scalp.nearest(q).point; r.x = 0; return scalp.nearest(r).point; };
const mirrorPt = (scalp, p) => scalp.nearest(mirrorX(p)).point;
const allInside = (dense, inside) => !inside || dense.every(inside);

// 一條分線（照切面走）：兩個端點直接畫得出來、而且整條在外輪廓裡面就照用；
// 不行（端點剛好壓在外輪廓外面一點）就照畫線的流程裁到外輪廓為止。都不行就丟錯。
function sectionLine(scalp, section, a, b, inside, name) {
  const sec = SEC.normalizeSection(section), dense = SEC.sectionDense(scalp, sec, a, b);
  if (dense && allInside(dense, inside)) return { shape: 'line', points: [a.clone(), b.clone()], section: sec };
  const f = SEC.fitSection(scalp, sec, a, b, inside);
  if (!f) throw new Error(name + 'はこのヘッドには描けません');
  return { shape: 'line', points: [f.a.clone(), f.b.clone()], section: sec };
}
// 一般的兩點線（沿頭皮最短的路）：走到外輪廓外面就把終點退到最後一個還在裡面的地方
function plainLine(scalp, a, b, inside, name) {
  const dense = scalp.line(a, b);
  if (allInside(dense, inside)) return { shape: 'line', points: [a.clone(), b.clone()] };
  let i = 0; while (i < dense.length && inside(dense[i])) i++;
  if (i < 2) throw new Error(name + 'はこのヘッドには描けません');
  return { shape: 'line', points: [a.clone(), scalp.nearest(dense[i - 1]).point] };
}

function center(scalp, lms, inside) {
  const line = sectionLine(scalp, { kind: 'V', az: 0 }, onMid(scalp, landmark(scalp, lms, 'C.P')), onMid(scalp, landmark(scalp, lms, 'N.P')), inside, '正中線');
  return [{ id: 'center', name: '正中線', ...line }];
}
function ear(scalp, lms, inside) {
  const top = onMid(scalp, landmark(scalp, lms, 'T.P')), epL = landmark(scalp, lms, 'E.P', 'L');
  const L = sectionLine(scalp, { kind: 'R', pivot: 0 }, top, epL, inside, 'イヤーツーイヤー（左）');
  const R = sectionLine(scalp, { kind: 'R', pivot: 0 }, top, mirrorPt(scalp, L.points[1]), inside, 'イヤーツーイヤー（右）');
  return [{ id: 'ear_l', name: 'イヤーツーイヤー（左）', pair: 'ear_r', ...L }, { id: 'ear_r', name: 'イヤーツーイヤー（右）', pair: 'ear_l', ...R }];
}
// U型區經過的七個點（左額角 → 左側 → 左後 → G.P → 右後 → 右側 → 右額角）。頭側兩點的高度照 G.P 的仰角，和 landmarks.js 的 gp_line 一樣。
function uzonePoints(scalp, lms) {
  const gp = findLandmark(lms, 'G.P');
  if (!gp) throw new Error('ヘッドにポイント G.P がありません');
  const onHead = (az, el) => scalp.nearest(scalp.onSkull(scalp.center.clone().addScaledVector(azElToDir(az, el), 0.2)).point).point;
  const fl = landmark(scalp, lms, 'F.S.P', 'L'), side = onHead(90, gp.el - 2), back = onHead(135, gp.el), mid = onMid(scalp, gp.point);
  return [fl, side, back, mid, mirrorPt(scalp, back), mirrorPt(scalp, side), mirrorPt(scalp, fl)];
}
function uzone(scalp, lms) {
  return [{ id: 'uzone', name: 'Uセクション', shape: 'curve', points: uzonePoints(scalp, lms) }];
}
function fringe(scalp, lms, inside) {
  const apex = onMid(scalp, landmark(scalp, lms, 'C.T.M.P')), fl = landmark(scalp, lms, 'F.S.P', 'L');
  const L = plainLine(scalp, apex, fl, inside, '前髪トライアングル（左）');
  const R = plainLine(scalp, apex, mirrorPt(scalp, L.points[1]), inside, '前髪トライアングル（右）');
  return [{ id: 'fringe_l', name: '前髪トライアングル（左）', pair: 'fringe_r', ...L }, { id: 'fringe_r', name: '前髪トライアングル（右）', pair: 'fringe_l', ...R }];
}

// 一個樣板要畫的線：[{ id, name, shape:'line'|'curve', points:[Vector3（頭皮上、沒抬高）], section?, pair? }]。
//   pair＝左右成對的另一條的 id（鏡像開著時 app.js 把兩條配成一對）。
//   inside(p)＝這一點在不在外輪廓裡面（不給就不檢查）。點位不夠或畫不出來丟錯。
export function templateLines(scalp, lms, key, inside = null) {
  if (key === 'center') return center(scalp, lms, inside);
  if (key === 'ear') return ear(scalp, lms, inside);
  if (key === 'four') return [...center(scalp, lms, inside), ...ear(scalp, lms, inside)];
  if (key === 'uzone') return uzone(scalp, lms);
  if (key === 'fringe') return fringe(scalp, lms, inside);
  throw new Error('不明なテンプレート：' + key);
}

// 這一頁的某一筆（layer：doc.js 的格式）是不是就是樣板的這一條：同樣是兩點線（沒拉彎）或同樣是曲線、點數一樣、
// 每個點都差不到 tol（順著比或反著比）。按第二次樣板時用來跳過已經有的線。
export function sameLine(layer, spec, tol = SAME_TOL) {
  if (!layer || layer.shape !== spec.shape || !Array.isArray(layer.points) || layer.points.length !== spec.points.length) return false;
  if (layer.shape === 'line' && layer.control) return false;
  if (Array.isArray(layer.bends) && layer.bends.some(Boolean)) return false;
  const n = spec.points.length, near = (p, q) => toV(p).distanceTo(q) <= tol;
  return spec.points.every((q, i) => near(layer.points[i], q)) || spec.points.every((q, i) => near(layer.points[n - 1 - i], q));
}
