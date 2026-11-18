// SPDX-License-Identifier: AGPL-3.0-only
// 重新產生 assets/heads/transfer.json：每顆頭模的「骨架」（換頭模時用來把圖搬到新頭上的對照點）。
// 用畫圖同一套程式算（點位、外輪廓、結構線），所以加了新頭模或改了點位資料之後要重跑一次。
//
//   node tools/build-transfer.mjs           重新產生並寫檔
//   node tools/build-transfer.mjs --check   只比對：算出來的和現有的檔不一樣就結束碼 1（不寫檔）
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadMeshes } from '../src/glb.js';
import { Scalp } from '../src/scalp.js';
import { computeLandmarks, outlinePoints, structureLines } from '../src/landmarks.js';
import { skeleton, TRANSFER_FORMAT } from '../src/transfer.js';
import { validateHeads } from '../src/heads.js';

const dir = fileURLToPath(new URL('../assets/heads/', import.meta.url));
const check = process.argv.includes('--check');
const list = JSON.parse(readFileSync(dir + 'heads.json', 'utf8'));
const problems = validateHeads(list);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

const out = { format: TRANSFER_FORMAT, version: 1, labels: null, heads: {} };
for (const m of list.models) {
  const started = Date.now();
  const file = readFileSync(dir + m.glb);
  const meshes = loadMeshes(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const meta = JSON.parse(readFileSync(dir + m.meta, 'utf8'));
  const scalp = new Scalp(meshes);
  const landmarks = computeLandmarks(scalp, meta);
  const outline = outlinePoints(scalp, landmarks);
  scalp.extendDrawingSurface(outline);
  // 外輪廓只給一邊（outline.right 沒有）的頭＝左右對稱
  const sk = skeleton(landmarks, outline, structureLines(scalp, landmarks), { symmetric: !meta.outline.right });
  if (!out.labels) out.labels = sk.labels;
  else if (JSON.stringify(out.labels) !== JSON.stringify(sk.labels)) throw new Error(m.id + '：対応点の順番がほかのヘッドと違います');
  out.heads[m.id] = { pts: sk.pts };
  console.log(`${m.id}　${sk.pts.length} 個の対応点　${Date.now() - started} ms`);
}

const target = dir + 'transfer.json', text = JSON.stringify(out);
if (check) {
  const same = readFileSync(target, 'utf8') === text;
  console.log(same ? 'transfer.json は計算結果と一致しています' : 'transfer.json が計算結果と違います。node tools/build-transfer.mjs を実行し直してください');
  process.exit(same ? 0 : 1);
}
writeFileSync(target, text);
console.log('assets/heads/transfer.json に書き出しました');
