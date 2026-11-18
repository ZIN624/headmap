// アウトラインのガイド（2D）：あご先と首の輪郭の測り方、選んだ cm からの位置と前下がり／前上がりの判定。実行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadMeshes } from '../src/glb.js';
import { Scalp } from '../src/scalp.js';
import { computeLandmarks, findLandmark } from '../src/landmarks.js';
import * as OL from '../src/flat/outline.js';
import * as S from '../src/flat/shapes.js';
import { VIEW_IDS } from '../src/flat/views.js';

const dir = fileURLToPath(new URL('../assets/heads/', import.meta.url));
function anchorsOf(id) {
  const f = readFileSync(dir + id + '.glb');
  const meshes = loadMeshes(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
  const meta = JSON.parse(readFileSync(dir + id + '.json', 'utf8'));
  const lms = computeLandmarks(new Scalp(meshes), meta);
  return OL.profileAnchors(meshes, findLandmark(lms, 'N.P').point.y);
}
const A = anchorsOf('bl_f'); // 2D はヘッド 2

test('アウトライン：ヘッド2のあご先は N.P より下、顔の前', () => {
  assert.ok(A.chin[1] > A.np + 20 && A.chin[1] < A.np + 60, 'あご先の高さ ' + A.chin[1]);
  assert.ok(A.chin[0] > 80 && A.chin[0] < 130, 'あご先の前後 ' + A.chin[0]);
  assert.ok(A.backX(A.np) < -50, '襟足の高さの首の後ろ');
});

test('アウトライン：選んだ cm どおりの位置と、前下がり・水平・前上がり', () => {
  const g = OL.outlineGeometry(A, { front: 3, back: 0 });
  assert.equal(g.frontPt[1], Math.round((A.chin[1] + 30) * 10) / 10);
  assert.equal(g.backPt[1], A.np);
  assert.equal(g.kind, '前下がり');
  assert.equal(g.label, 'あご下3cm・前下がり');
  const up = OL.outlineGeometry(A, { front: -6, back: 8 });
  assert.equal(up.kind, '前上がり');
  assert.ok(OL.outlineGeometry(A, { front: 1, back: 4 }).frontPt[1] > OL.outlineGeometry(A, { front: 0, back: 4 }).frontPt[1]);
});

test('アウトライン：ラベルと範囲', () => {
  assert.equal(OL.frontLabel(0), 'あごの高さ');
  assert.equal(OL.frontLabel(-2), 'あご上2cm');
  assert.equal(OL.backLabel(1.5), '生え際下1.5cm');
  assert.equal(OL.clampCm(99, OL.FRONT_RANGE), OL.FRONT_RANGE[1]);
  assert.equal(OL.clampCm(-99, OL.BACK_RANGE), OL.BACK_RANGE[0]);
});

test('アウトライン：右側面と左側面は鏡像のペア、背面は首を横切る線。読み書きしても同じ', () => {
  const specs = OL.outlineSpecs(OL.outlineGeometry(A, OL.DEFAULT_OUTLINE), ['a', 'b', 'c']);
  assert.deepEqual(specs.map(s => s.view), ['right', 'left', 'back']);
  assert.equal(specs[0].mirrorPairId, 'b');
  assert.equal(specs[1].mirrorPairId, 'a');
  assert.deepEqual(specs[1].pts, specs[0].pts.map(p => [-p[0], p[1]]));
  assert.equal(specs[2].pts[0][0], -specs[2].pts[1][0]);
  const shapes = specs.map(S.newShape);
  assert.deepEqual(S.saveShapes(S.parseShapes(S.saveShapes(shapes), VIEW_IDS)), S.saveShapes(shapes));
});
