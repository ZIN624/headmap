// SPDX-License-Identifier: AGPL-3.0-only
// 2D 頭圖的五個視圖：左側（臉朝左）、右側（臉朝右）、頂視（臉朝上）、正面、背面。純資料，瀏覽器與 Node 共用。
// 座標：視圖平面上的公釐，+x 往右、+y 往下，原點＝頭心（3D 的原點）的投影。3D 是公尺、+Y 向上、臉朝 +Z、模型左側 +X。
// 每個視圖是一張固定大小的紙（PAGE），頭模的線稿畫在上面；筆畫的座標也是這個公釐座標，所以換頭模、換紙張大小都不會跑掉。

export const PAGE = { w: 360, h: 468 }; // 一張紙 360×468 mm（直式，3:3.9）
export const VIEWS = [
  { id: 'left', label: '左側', short: '左', mirror: 'right', dir: [1, 0, 0], up: [0, 1, 0], cy: 40 },
  { id: 'right', label: '右側', short: '右', mirror: 'left', dir: [-1, 0, 0], up: [0, 1, 0], cy: 40 },
  { id: 'top', label: '頂視', short: '頂', mirror: 'top', dir: [0, 1, 0], up: [0, 0, 1], cy: 0 },
  { id: 'front', label: '正面', short: '正', mirror: 'front', dir: [0, 0, 1], up: [0, 1, 0], cy: 40 },
  { id: 'back', label: '背面', short: '背', mirror: 'back', dir: [0, 0, -1], up: [0, 1, 0], cy: 40 },
];
export const VIEW_IDS = VIEWS.map(v => v.id);
export const viewById = id => VIEWS.find(v => v.id === id) || null;
// 左右對稱的視圖（鏡像在同一個視圖裡、對 x＝0 翻）；左側和右側互為鏡像（翻到另一個視圖）
export const isSymmetric = id => id === 'top' || id === 'front' || id === 'back';
export const mirrorView = id => (viewById(id) || {}).mirror || null;

// 這張紙在視圖座標裡的範圍
export function pageBox(id) {
  const v = viewById(id);
  return { x: -PAGE.w / 2, y: v.cy - PAGE.h / 2, w: PAGE.w, h: PAGE.h };
}

// 3D 點（公尺，[x,y,z] 或 {x,y,z}）→ 這個視圖的 2D 點（公釐）
export function project(id, p) {
  const x = (Array.isArray(p) ? p[0] : p.x) * 1000, y = (Array.isArray(p) ? p[1] : p.y) * 1000, z = (Array.isArray(p) ? p[2] : p.z) * 1000;
  switch (id) {
    case 'front': return [x, -y];
    case 'back': return [-x, -y];
    case 'left': return [-z, -y];  // 從模型左側看：臉（+Z）在左邊
    case 'right': return [z, -y];
    case 'top': return [-x, -z];   // 從頭頂看、臉朝上：模型右側在畫面右邊
    default: throw new Error('視圖不認得：' + id);
  }
}
// 2D 點 → 這個視圖平面上的 3D 點（深度＝depth 公尺，沿視線方向量；預設 0＝過頭心的那一片）
export function unproject(id, q, depth = 0) {
  const u = q[0] / 1000, w = q[1] / 1000;
  switch (id) {
    case 'front': return [u, -w, depth];
    case 'back': return [-u, -w, -depth];
    case 'left': return [depth, -w, -u];
    case 'right': return [-depth, -w, u];
    case 'top': return [-u, depth, -w];
    default: throw new Error('視圖不認得：' + id);
  }
}
