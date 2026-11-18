// SPDX-License-Identifier: AGPL-3.0-only
// 頭模清單：有哪幾顆頭、預設哪一顆、每顆的來源與授權。清單在 assets/heads/heads.json；每張頭圖記自己畫在哪顆頭上（drawing.head）。
// 純資料，不依賴 three，瀏覽器與 Node 共用。
export const HEADS_DIR = './assets/heads/';
export const HEADS_URL = HEADS_DIR + 'heads.json';
export const TRANSFER_URL = HEADS_DIR + 'transfer.json';
export const HEADS_FORMAT = 'head3d-heads';

export const modelById = (list, id) => (list && list.models.find(m => m.id === id)) || null;
// 這張頭圖用哪顆頭：記的那顆不在清單裡（或沒記）就用預設那顆
export const headOf = (list, drawing) => (modelById(list, drawing && drawing.head) ? drawing.head : list.default);
// 2D 頭圖固定用哪顆頭模（heads.json 的 default2d；沒寫或不在清單裡就用預設那顆）
export const flatHead = list => (modelById(list, list.default2d) ? list.default2d : list.default);
export const headLabel = m => (m ? m.label + '（' + m.sub + '）' : '');

// 清單檢查：回傳問題清單（空的＝沒問題）
export function validateHeads(list) {
  if (!list || list.format !== HEADS_FORMAT || !Array.isArray(list.models) || !list.models.length) return ['ヘッド一覧の形式が正しくありません'];
  const out = [], ids = new Set();
  for (const m of list.models) {
    if (!m || typeof m.id !== 'string' || !/^[a-z0-9_]{1,24}$/.test(m.id) || ids.has(m.id)) { out.push('ヘッドの id が重複しているか正しくありません：' + (m && m.id)); continue; }
    ids.add(m.id);
    for (const k of ['label', 'sub', 'glb', 'meta', 'author', 'license', 'source']) if (typeof m[k] !== 'string' || !m[k]) out.push(m.id + ' に次がありません：' + k);
  }
  if (!ids.has(list.default)) out.push('標準のヘッドが一覧にありません');
  if (list.default2d !== undefined && !ids.has(list.default2d)) out.push('2D 用のヘッドが一覧にありません');
  return out;
}
