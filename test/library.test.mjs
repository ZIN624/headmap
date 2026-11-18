// SPDX-License-Identifier: AGPL-3.0-only
// 資料層的測試：一筆圖的格式（doc.js）與頭圖庫（library.js）。執行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/doc.js';
import * as L from '../src/library.js';

const A = { x: 0.05, y: 0.08, z: 0.02 }, B = { x: 0.03, y: 0.09, z: 0.04 }, C = { x: 0.02, y: 0.1, z: 0.01 };

test('新的一筆：樣式照形狀整理', () => {
  const line = D.newLayer({ shape: 'line', points: [A, B], dashed: true, arrow: true });
  assert.deepEqual(line.style.dash, D.DASH);
  assert.equal(line.arrow, true);
  assert.equal(line.control, null);

  const point = D.newLayer({ shape: 'point', points: [A], dashed: true, arrow: true, style: { stroke: '#236B91' } });
  assert.deepEqual(point.style.dash, []);
  assert.equal(point.arrow, false);
  assert.equal(point.style.fill, '#236B91');

  const region = D.newLayer({ shape: 'region', points: [A, B, C], style: { stroke: '#0C8F91' } });
  assert.equal(region.closed, true);
  assert.equal(region.style.opacity, D.FILL_OPACITY);
  assert.equal(region.bends.length, 3);

  assert.throws(() => D.newLayer({ shape: 'circle', points: [A] }), /形狀不認得/);
});

test('標字：去掉控制字元、壓掉多餘空白、限制長度', () => {
  assert.equal(D.cleanLabel('  導線\n13mm  '), '導線 13mm');
  assert.equal(D.cleanLabel('a'.repeat(40)).length, D.LABEL_MAX);
  assert.equal(D.cleanLabel(null), '');
});

test('線拉成髮片、點變成提拉線', () => {
  const panel = D.convertToLift(D.newLayer({ shape: 'line', points: [A, B] }), 'panel');
  assert.equal(panel.shape, 'panel');
  assert.equal(panel.bends.length, 1);
  assert.ok(panel.lift && panel.lift.length_cm > 0);
  assert.equal('control' in panel, false);

  const strand = D.convertToLift(D.newLayer({ shape: 'point', points: [A] }), 'strand');
  assert.equal(strand.arrow, true);
  assert.throws(() => D.convertToLift(D.newLayer({ shape: 'point', points: [A] }), 'panel'), /只有線/);
});

test('存檔再讀回來是同一筆', () => {
  const layers = [
    D.newLayer({ shape: 'line', points: [A, B], control: C, style: { stroke: '#C63B32', width: 5.5 }, label: '導線' }),
    D.newLayer({ shape: 'curve', points: [A, B, C], bends: [C, null], dashed: true }),
    D.newLayer({ shape: 'region', points: [A, B, C], poly: true }),
    D.convertToLift(D.newLayer({ shape: 'line', points: [A, B] }), 'panel'),
  ];
  const back = D.parseLayers(JSON.parse(JSON.stringify(D.saveLayers(layers))));
  assert.deepEqual(back, layers);
});

test('讀檔：不合格的筆說得出是哪一筆', () => {
  assert.throws(() => D.parseLayers([{ shape: 'line', points: [A] }]), /第 1 筆的點少於 2 個/);
  assert.throws(() => D.parseLayers([{ shape: 'point', points: [A] }, { shape: 'line', points: [A, { x: 9, y: 0, z: 0 }] }]), /第 2 筆第 2 點離頭太遠/);
  assert.throws(() => D.parseLayers([{ shape: 'point', points: [A, B] }]), /多於 1 個/);
  assert.throws(() => D.parseLayers({}), /缺 layers/);
});

test('讀檔：顏色或線寬不對就用預設，鏡像配對的另一筆不在就解除', () => {
  const [l] = D.parseLayers([{ id: 'a', shape: 'line', points: [A, B], style: { stroke: 'red', width: 99 }, mirrorPairId: 'gone' }]);
  assert.equal(l.style.stroke, '#1B1B1B');
  assert.equal(l.style.width, D.WIDTHS[1]);
  assert.equal('mirrorPairId' in l, false);
});

function sampleLibrary() {
  const lib = L.newLibrary(), d = L.newDrawing('測試');
  L.storeStepLayers(d.steps[0], [D.newLayer({ shape: 'line', points: [A, B] }), D.newLayer({ shape: 'point', points: [C] })]);
  d.steps[0].view = { p: [0, 0, 1.2], u: [0, 1, 0], z: 1, k: 'front' };
  lib.drawings.push(d);
  return { lib, d };
}

test('步驟：新增、複製、移動、刪除', () => {
  const { d } = sampleLibrary();
  assert.equal(L.addStep(d, 0), 1);
  assert.equal(L.duplicateStep(d, 0), 1);
  assert.equal(d.steps.length, 3);
  assert.notEqual(d.steps[1].id, d.steps[0].id);
  assert.notEqual(d.steps[1].layers[0].id, d.steps[0].layers[0].id);
  assert.equal(L.moveStep(d, 1, 1), 2);
  assert.equal(L.moveStep(d, 0, -1), 0);
  assert.equal(L.deleteStep(d, 2), 1);
  L.deleteStep(d, 1);
  assert.throws(() => L.deleteStep(d, 0), /至少要留一個步驟/);
});

test('複製步驟時鏡像配對跟著對到新的筆', () => {
  const { d } = sampleLibrary();
  const [a, b] = d.steps[0].layers;
  a.mirrorPairId = b.id; b.mirrorPairId = a.id;
  L.duplicateStep(d, 0);
  const [a2, b2] = d.steps[1].layers;
  assert.equal(a2.mirrorPairId, b2.id);
  assert.equal(b2.mirrorPairId, a2.id);
});

test('步驟的編號、名字、前面步驟變淡', () => {
  const { d } = sampleLibrary();
  L.addStep(d); L.addStep(d);
  d.steps[1].title = '分區';
  assert.equal(L.stepLabel(0), '01');
  assert.equal(L.stepName(d, 0), '步驟 1');
  assert.equal(L.stepName(d, 1), '分區');
  assert.deepEqual(L.ghostIndices(d, 2), [0]);
  assert.deepEqual(L.ghostIndices(d, 0), []);
});

test('頭圖庫存檔再讀回來內容一樣', () => {
  const { lib } = sampleLibrary();
  lib.settings.mirror = true;
  lib.current = { drawingId: lib.drawings[0].id, stepId: lib.drawings[0].steps[0].id, mode: 'draw' };
  const back = L.parseLibrary(L.serializeLibrary(lib));
  assert.deepEqual(back.drawings, lib.drawings);
  assert.deepEqual(back.settings, lib.settings);
  assert.deepEqual(back.current, lib.current);
});

test('匯出一張頭圖再匯入：加在後面，同 id 的另外給新 id', () => {
  const { lib, d } = sampleLibrary();
  const { added } = L.importInto(lib, L.exportDrawing(d));
  assert.equal(lib.drawings.length, 2);
  assert.notEqual(added[0].id, d.id);
  assert.equal(added[0].title, '測試（匯入）');
  assert.deepEqual(added[0].steps, d.steps);
});

test('匯出整個頭圖庫再匯入到空的頭圖庫', () => {
  const { lib } = sampleLibrary();
  const other = L.newLibrary();
  assert.equal(L.importInto(other, L.exportLibrary(lib)).added.length, 1);
  assert.deepEqual(other.drawings, lib.drawings);
});

test('匯入：看不懂、太新、壞掉的檔案都擋下來，頭圖庫不變', () => {
  const { lib } = sampleLibrary();
  const before = L.serializeLibrary(lib);
  assert.throws(() => L.importInto(lib, '{'), /不是正確的 JSON/);
  assert.throws(() => L.importInto(lib, '{"format":"something-else"}'), /看不懂這個檔案/);
  assert.throws(() => L.importInto(lib, JSON.stringify({ format: L.DRAWING_FORMAT, version: L.FORMAT_VERSION + 1, drawing: {} })), /比較新的版本/);
  assert.throws(() => L.importInto(lib, JSON.stringify({ format: L.DRAWING_FORMAT, version: 1, drawing: { steps: [{ layers: [{ shape: 'line', points: [A] }] }] } })), /第 1 步的圖讀不進來/);
  assert.throws(() => L.importInto(lib, JSON.stringify({ format: L.DRAWING_FORMAT, version: 1, drawing: { steps: [] } })), /沒有任何步驟/);
  const good = lib.drawings[0];
  assert.throws(() => L.importInto(lib, JSON.stringify({ format: L.LIBRARY_FORMAT, version: 1, drawings: [good, { steps: [] }] })), /第 2 張沒有任何步驟/);
  assert.equal(L.serializeLibrary(lib), before);
});
