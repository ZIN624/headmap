// SPDX-License-Identifier: AGPL-3.0-only
// 頭模清單與換頭模：清單的檔案都在、對照資料齊全、3D 的圖換過去再換回來一模一樣。執行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as H from '../src/heads.js';
import * as TR from '../src/transfer.js';
import * as D from '../src/doc.js';
import * as L from '../src/library.js';

const dir = fileURLToPath(new URL('../assets/heads/', import.meta.url));
const list = JSON.parse(readFileSync(dir + 'heads.json', 'utf8'));
const transfer = JSON.parse(readFileSync(dir + 'transfer.json', 'utf8'));

test('頭模清單：格式對、預設是頭模 4、2D 用頭模 2、每顆的模型與資料檔都在', () => {
  assert.deepEqual(H.validateHeads(list), []);
  assert.equal(list.default, 'ict');
  assert.equal(H.flatHead(list), 'bl_f'); // 2D 固定用頭模 2
  assert.equal(H.flatHead({ ...list, default2d: 'nope' }), 'ict');
  assert.deepEqual(H.validateHeads({ ...list, default2d: 'nope' }), ['2D 用のヘッドが一覧にありません']);
  assert.equal(list.models.length, 4);
  for (const m of list.models) {
    assert.ok(existsSync(dir + m.glb), m.glb);
    const meta = JSON.parse(readFileSync(dir + m.meta, 'utf8'));
    assert.ok(meta.outline && meta.outline.front && meta.outline.rear && meta.outline.index, m.id + ' 的外輪廓');
    assert.equal(meta.landmarks_m.top.length, 3);
    if (m.licenseFile) assert.ok(existsSync(dir + m.licenseFile), m.licenseFile);
  }
  assert.equal(H.headOf(list, { head: 'nope' }), 'ict');
  assert.equal(H.headOf(list, { head: 'bl_m' }), 'bl_m');
});

test('換頭模的對照資料：四顆頭都有、點數一樣', () => {
  assert.deepEqual(TR.validateTransfer(transfer), []);
  assert.deepEqual(Object.keys(transfer.heads).sort(), list.models.map(m => m.id).sort());
});

test('3D 的圖：換到別顆頭再換回來一模一樣；在別顆頭上動過就改算在那顆頭上', () => {
  const ctx = TR.makeContext(transfer), same = p => ({ ...p });
  const d = L.newDrawing('換頭', { kind: '3d', head: 'ict' });
  const pts = transfer.heads.ict.pts;
  L.storeStepLayers(d.steps[0], [
    D.newLayer({ shape: 'line', points: [pts[0], pts[30]].map(p => ({ x: p[0], y: p[1], z: p[2] })), control: { x: 0.02, y: 0.09, z: 0.03 } }),
    D.newLayer({ shape: 'curve', points: [pts[3], pts[40], pts[60]].map(p => ({ x: p[0], y: p[1], z: p[2] })) }),
  ]);
  const before = JSON.stringify(d.steps[0].layers);
  assert.equal(TR.convertDrawing(d, 'bl_f', ctx, same), 2);
  assert.notEqual(JSON.stringify(d.steps[0].layers), before);
  TR.convertDrawing(d, 'mh_f', ctx, same);
  TR.convertDrawing(d, 'ict', ctx, same);
  assert.equal(JSON.stringify(d.steps[0].layers), before);
  // 在頭模 3 上把第一筆動一下：換回頭模 4 時就從頭模 3 的位置算
  TR.convertDrawing(d, 'bl_m', ctx, same);
  const layers = L.stepLayers(d.steps[0]);
  layers[0].points[0].x += 0.002;
  L.storeStepLayers(d.steps[0], layers);
  assert.equal(d.steps[0].layers[0].origin, undefined);
  assert.ok(d.steps[0].layers[1].origin);
  TR.convertDrawing(d, 'ict', ctx, same);
  assert.ok(d.steps[0].layers[0].origin && d.steps[0].layers[0].origin.head === 'bl_m');
});
