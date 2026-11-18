// SPDX-License-Identifier: AGPL-3.0-only
// 2D 頭圖的資料與幾何：筆的格式（flat/shapes.js）、吸附與完善線條（flat/snap.js）、動畫時間軸（flat/anim.js）、
// 頭圖庫的 2D 步驟、資料夾與回收桶（library.js）、換頭模的平面變形（transfer.js）。執行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/flat/shapes.js';
import * as SN from '../src/flat/snap.js';
import * as AN from '../src/flat/anim.js';
import * as V from '../src/flat/views.js';
import * as L from '../src/library.js';
import { fitWarp } from '../src/transfer.js';

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test('視圖：3D 點投影到五個視圖、再投回來', () => {
  const p = [0.03, 0.05, -0.02];
  assert.deepEqual(V.project('front', p).map(Math.round), [30, -50]);
  assert.deepEqual(V.project('back', p).map(Math.round), [-30, -50]);
  assert.deepEqual(V.project('left', p).map(Math.round), [20, -50]);   // 從左側看，臉（+Z）在左邊
  assert.deepEqual(V.project('right', p).map(Math.round), [-20, -50]);
  assert.deepEqual(V.project('top', p).map(Math.round), [-30, 20]);    // 從頭頂看，臉朝上
  for (const v of V.VIEW_IDS) {
    const q = V.project(v, p), back = V.unproject(v, q, 0);
    const again = V.project(v, back);
    assert.ok(near(again[0], q[0]) && near(again[1], q[1]), v);
  }
  assert.equal(V.mirrorView('left'), 'right');
  assert.equal(V.mirrorView('front'), 'front');
  assert.ok(V.isSymmetric('top') && !V.isSymmetric('left'));
});

test('新的一筆：樣式與欄位照種類整理，壞值拉回範圍', () => {
  const l = S.newShape({ type: 'line', view: 'front', pts: [[0, 0], [10, 0]], style: { color: 'red', width: 99, dash: 'wavy' }, ends: { b: 'arrow', a: 'x' } });
  assert.equal(l.style.color, '#1B1B1B');
  assert.equal(l.style.width, 8);
  assert.equal(l.style.dash, 'solid');
  assert.deepEqual(l.ends, { a: 'none', b: 'arrow' });
  const c = S.newShape({ type: 'curve', view: 'front', pts: [[0, 0], [10, 0]] });
  assert.deepEqual(c.m, [5, 0]);
  const r = S.newShape({ type: 'region', view: 'top', pts: [[0, 0], [10, 0], [5, 8]] });
  assert.equal(r.style.fill, true);
  const t = S.newShape({ type: 'text', view: 'back', pts: [[0, 0]], text: '' });
  assert.equal(t.text, '文字');
  assert.throws(() => S.newShape({ type: 'star', view: 'front', pts: [[0, 0]] }), /種類不認得/);
});

test('存檔再讀回來是同一筆；不合格的筆說得出是哪一筆', () => {
  const list = [
    S.newShape({ type: 'line', view: 'front', pts: [[0, 0], [10.123456, 5]], ends: { b: 'arrow' }, label: '導線' }),
    S.newShape({ type: 'curve', view: 'left', pts: [[0, 0], [20, 0]], m: [10, -6] }),
    S.newShape({ type: 'ellipse', view: 'top', pts: [[3, 4]], rx: 12, ry: 8, rot: 30, style: { fill: true } }),
    S.newShape({ type: 'icon', view: 'right', pts: [[1, 1]], icon: 'razor', size: 20, rot: 45, flip: true }),
    S.newShape({ type: 'angle', view: 'back', pts: [[0, 0], [10, 0], [0, -10]] }),
  ];
  list[0].mirrorPairId = list[1].id;
  const back = S.parseShapes(JSON.parse(JSON.stringify(S.saveShapes(list))), V.VIEW_IDS);
  assert.deepEqual(back.map(s => s.type), list.map(s => s.type));
  assert.deepEqual(back[0].pts[1], [10.12, 5]);
  assert.equal(back[0].label, '導線');
  assert.equal(back[0].mirrorPairId, list[1].id);
  assert.deepEqual(back[3].flip, true);
  assert.throws(() => S.parseShapes([{ type: 'line', view: 'front', pts: [[0, 0]] }], V.VIEW_IDS), /第 1 筆的點數不對/);
  assert.throws(() => S.parseShapes([{ type: 'dot', view: 'side', pts: [[0, 0]] }], V.VIEW_IDS), /視圖不認得/);
  assert.throws(() => S.parseShapes([{ type: 'dot', view: 'top', pts: [[0, 1e9]] }], V.VIEW_IDS), /不是 \[x, y\] 數字/);
});

test('幾何：曲線通過中間點、命中距離、外框', () => {
  const c = S.newShape({ type: 'curve', view: 'front', pts: [[0, 0], [20, 0]], m: [10, 8] });
  const g = S.geom(c);
  assert.ok(g.pts.some(p => S.dist(p, [10, 8]) < 0.01), '曲線在一半的地方通過 m');
  const l = S.newShape({ type: 'line', view: 'front', pts: [[0, 0], [10, 0]], style: { width: 1 } });
  assert.ok(near(S.hitDistance(l, [5, 3]), 2.5));
  const r = S.newShape({ type: 'region', view: 'front', pts: [[0, 0], [10, 0], [10, 10], [0, 10]], smooth: false });
  assert.equal(S.hitDistance(r, [5, 5]), 0);
  const b = S.bbox(l);
  assert.ok(near(b.x0, -0.5) && near(b.x1, 10.5));
});

test('變換：鏡像、反轉方向、在自己的中心翻、旋轉與縮放', () => {
  const a = S.newShape({ type: 'line', view: 'front', pts: [[2, 0], [10, 4]], ends: { b: 'arrow' } });
  S.mirrorX(a);
  assert.deepEqual(a.pts, [[-2, 0], [-10, 4]]);
  S.reverse(a);
  assert.deepEqual(a.pts, [[-10, 4], [-2, 0]]);
  assert.deepEqual(a.ends, { a: 'arrow', b: 'none' });
  const icon = S.newShape({ type: 'icon', view: 'front', pts: [[0, 0]], rot: 30 });
  S.mirrorX(icon);
  assert.equal(icon.rot, -30); assert.equal(icon.flip, true);
  const t = S.newShape({ type: 'text', view: 'front', pts: [[5, 5]], text: 'A', size: 10 });
  S.scale(t, 2, [0, 0]);
  assert.deepEqual(t.pts[0], [10, 10]); assert.equal(t.size, 20);
  const d = S.newShape({ type: 'line', view: 'front', pts: [[0, 0], [10, 0]] });
  S.rotate(d, 90, [0, 0]);
  assert.ok(near(d.pts[1][0], 0) && near(d.pts[1][1], 10));
});

test('手畫線整理：抖動去掉', () => {
  const raw = []; for (let i = 0; i <= 100; i++) raw.push([i, Math.sin(i / 8) * 4 + (i % 2 ? 0.08 : -0.08)]);
  const t = S.tidyFree(raw, 2);
  assert.ok(t.length < 40 && t.length >= 5, '點數變少：' + t.length);
});

test('吸附：點位優先、吸住了不輕易換、方向轉正、對齊輔助線', () => {
  const px = 0.2; // 1 px＝0.2 mm
  const cands = [{ id: 'a', p: [0, 0], kind: 'point' }, { id: 'b', p: [1.5, 0], kind: 'end' }];
  assert.equal(SN.snapPoint([1.4, 0], cands, px).id, 'b');
  assert.equal(SN.snapPoint([0.9, 0], cands, px, 'a').id, 'a'); // 還在 9 px 內：留在 a
  assert.equal(SN.snapPoint([5, 5], cands, px), null);
  const d = SN.snapDirection([0, 0], [10, 0.3], px);
  assert.ok(d && near(d.p[1], 0, 1e-9) && d.deg === 0);
  const d45 = SN.snapDirection([0, 0], [10, 10.4], px);
  assert.ok(d45 && d45.deg === 45);
  assert.equal(SN.snapDirection([0, 0], [10, 3], px), null);
  const g = SN.alignGuides([5.3, 7], [[5, 30], [40, 7.2]], px);
  assert.deepEqual(g.p, [5, 7.2]);
  assert.equal(g.guides.length, 2);
});

test('完善線條：很近的線端接起來、線端延長到頭的外框', () => {
  const px = 0.25;
  const a = S.newShape({ type: 'line', view: 'front', pts: [[0, 0], [10, 0]] });
  const b = S.newShape({ type: 'line', view: 'front', pts: [[11, 0.5], [20, 0.5]] });
  const c = S.newShape({ type: 'line', view: 'front', pts: [[0, 10], [9, 10]] });
  const wall = [{ id: 'outline', pts: [[10, -20], [10, 40]] }];
  const n = SN.magicAlign([a, b, c], [a, b, c], wall, px);
  assert.ok(n >= 3);
  assert.deepEqual(a.pts[1], b.pts[0]);
  assert.ok(near(c.pts[1][0], 10, 1e-9), '延長到牆上：' + c.pts[1]);
  const far = S.newShape({ type: 'line', view: 'front', pts: [[0, 50], [5, 50]] });
  assert.equal(SN.magicAlign([far], [far], [], px), 0);
});

test('點一下填滿：圍起來的填得到，沒圍起來的認得出來', () => {
  const W = 20, H = 20, grid = new Uint8Array(W * H);
  for (let i = 4; i <= 14; i++) { grid[4 * W + i] = 1; grid[14 * W + i] = 1; grid[i * W + 4] = 1; grid[i * W + 14] = 1; }
  const inside = SN.flood(grid, W, H, 9, 9);
  assert.equal(inside.touchesEdge, false);
  assert.equal(inside.count, 9 * 9);
  const outside = SN.flood(grid, W, H, 1, 1);
  assert.equal(outside.touchesEdge, true);
  const poly = SN.traceMask(inside.mask, W, H, 0.5);
  assert.ok(poly.length >= 4);
});

test('局部擦掉：線在擦子碰到的地方斷成兩段', () => {
  const l = S.newShape({ type: 'line', view: 'front', pts: [[0, 0], [20, 0]] });
  const runs = SN.eraseSplit(l, [10, 0], 2);
  assert.equal(runs.length, 2);
  assert.ok(runs[0][runs[0].length - 1][0] < 8.5 && runs[1][0][0] > 11.5);
  assert.equal(SN.eraseSplit(l, [10, 30], 2), null);
});

test('動畫：平行的直線同時畫、其他依序錯開、下一步等上一步畫完', () => {
  const ln = (y, x0 = 0) => S.newShape({ type: 'line', view: 'front', pts: [[x0, y], [x0 + 50, y]] });
  const a = ln(0), b = ln(10), c = ln(20), dot = S.newShape({ type: 'dot', view: 'front', pts: [[0, 0]] });
  const groups = AN.groupShapes([a, b, c, dot]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, 3);
  const tl = AN.timeline([[a, b, dot], [c]], 'normal');
  const at = id => tl.items.find(i => i.id === id).start;
  assert.equal(at(a.id), at(b.id));
  assert.equal(at(dot.id), at(a.id) + AN.STAGGER);
  assert.equal(at(c.id), tl.steps[0].end + AN.GAP);
  assert.equal(tl.frames, tl.steps[1].end + AN.HOLD);
  const p = AN.progressAt(tl, at(dot.id) + AN.SPEEDS.normal / 2);
  assert.ok(near(p.get(dot.id), 0.5) && p.get(a.id) > 0.9 && p.get(c.id) === 0);
  const arrowUp = S.newShape({ type: 'line', view: 'front', pts: [[0, 0], [50, 0]], ends: { b: 'arrow' } });
  const arrowDown = S.newShape({ type: 'line', view: 'front', pts: [[50, 10], [0, 10]], ends: { b: 'arrow' } });
  assert.equal(AN.groupShapes([arrowUp, arrowDown]).length, 2, '方向相反的箭頭不併組');
});

test('頭圖庫：2D 頭圖的步驟、複製、資料夾、回收桶', () => {
  const lib = L.newLibrary(), d = L.newDrawing('平面', { kind: '2d', head: 'bl_f' });
  lib.drawings.push(d);
  assert.deepEqual(d.steps[0].shapes, []);
  L.storeStepShapes(d.steps[0], [S.newShape({ type: 'line', view: 'front', pts: [[0, 0], [10, 0]] })]);
  const j = L.duplicateStep(d, 0);
  assert.notEqual(d.steps[j].shapes[0].id, d.steps[0].shapes[0].id);
  assert.equal(L.stepShapes(d.steps[1]).length, 1);
  const f = L.addFolder(lib, '短髮');
  assert.throws(() => L.addFolder(lib, '短髮'), /已經有/);
  d.folder = f.id; d.star = true;
  const copy = L.duplicateDrawing(lib, d);
  assert.equal(copy.folder, f.id); assert.equal(copy.star, undefined);
  assert.equal(L.listDrawings(lib, { box: f.id }).length, 2);
  assert.equal(L.listDrawings(lib, { box: 'star' }).length, 1);
  L.trashDrawing(copy, new Date('2026-01-01'));
  assert.equal(L.listDrawings(lib, { box: 'all' }).length, 1);
  assert.equal(L.listDrawings(lib, { box: 'trash' }).length, 1);
  assert.deepEqual(L.expiredDrawings(lib, new Date('2026-03-01')), [copy]);
  L.deleteFolder(lib, f.id);
  assert.equal(d.folder, undefined);
  const back = L.parseLibrary(L.serializeLibrary(lib));
  assert.equal(back.drawings[0].kind, '2d');
  assert.equal(back.drawings[0].head, 'bl_f');
  assert.deepEqual(back.drawings[0].steps, d.steps);
});

test('頭圖庫：匯出帶照片、匯入時資料夾照名字對回來、回收桶的不匯出', () => {
  const lib = L.newLibrary(), d = L.newDrawing('有照片', { kind: '2d' });
  const f = L.addFolder(lib, '客人'); d.folder = f.id; d.photos = ['img-1']; d.backs = { front: 'img-2' };
  lib.drawings.push(d);
  const gone = L.newDrawing('刪掉的'); L.trashDrawing(gone); lib.drawings.push(gone);
  const text = L.exportLibrary(lib, { 'img-1': 'data:image/jpeg;base64,AAAA', 'img-2': 'data:image/png;base64,BBBB', bad: 'javascript:alert(1)' });
  const other = L.newLibrary();
  const r = L.importInto(other, text);
  assert.equal(r.added.length, 1);
  assert.deepEqual(Object.keys(r.media).sort(), ['img-1', 'img-2']);
  assert.equal(other.folders.length, 1);
  assert.equal(other.drawings[0].folder, other.folders[0].id);
  assert.deepEqual(L.mediaIds(other.drawings[0]), ['img-1', 'img-2']);
});

test('平面變形：通過每個對照點，兩維也能用', () => {
  const src = [[0, 0], [10, 0], [0, 10], [10, 10], [5, 5], [3, 8]];
  const dst = src.map(([x, y]) => [x * 1.1 + 2, y * 0.9 - 1 + x * 0.05]);
  const w = fitWarp(src, dst);
  for (let i = 0; i < src.length; i++) { const q = w(src[i]); assert.ok(near(q[0], dst[i][0], 1e-9) && near(q[1], dst[i][1], 1e-9)); }
  const q = w([7, 2]);
  assert.ok(near(q[0], 7 * 1.1 + 2, 1e-6) && near(q[1], 2 * 0.9 - 1 + 7 * 0.05, 1e-6), '仿射的變形照樣還原');
});
