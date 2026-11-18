// SPDX-License-Identifier: AGPL-3.0-only
// 2D 頭圖的畫法：同一套圖形畫成 SVG（編輯畫面）或畫在 canvas 上（PNG、PDF、影片、預覽動畫）。
// 座標都是公釐（views.js）；canvas 由呼叫的人先把公釐換成像素（ctx.setTransform）。
import { geom, endCap, dashArray, angleInfo, textSize, pathLength, PATH_TYPES, TEMPLATE_INK } from './shapes.js';

// 工具圖示：24×24 的格子，刀尖或工作的那一頭朝右（+x）。每個是 [路徑, 'fill'|'stroke'] 的清單
export const ICON_PATHS = {
  scissors: [['M5 4.8a2.9 2.9 0 1 0 0 5.8a2.9 2.9 0 1 0 0-5.8M5 13.4a2.9 2.9 0 1 0 0 5.8a2.9 2.9 0 1 0 0-5.8', 'stroke'], ['M7.2 13.6L11 10.8Q16.5 7.4 22 5.6L12.2 12.9L8 15.4Z', 'fill'], ['M7.2 10.4L11 13.2Q16.5 16.6 22 18.4L12.2 11.1L8 8.6Z', 'fill']],
  thinning: [['M5 4.8a2.9 2.9 0 1 0 0 5.8a2.9 2.9 0 1 0 0-5.8M5 13.4a2.9 2.9 0 1 0 0 5.8a2.9 2.9 0 1 0 0-5.8', 'stroke'], ['M7.2 10.4L11 13.2Q16.5 16.6 22 18.4L12.2 11.1L8 8.6Z', 'fill'], ['M8 13.8L22 6M11 12.2l.8 1.3M13.5 10.8l.8 1.3M16 9.4l.8 1.3M18.5 8l.8 1.3', 'stroke']],
  razor: [['M2.5 13.5h9.5v3.5H2.5z', 'stroke'], ['M12 11h9.2l-1.4 6H12z', 'fill'], ['M12 14h9', 'stroke']],
  clipper: [['M3 8.5h11.5a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H3a1.5 1.5 0 0 1-1.5-1.5v-4A1.5 1.5 0 0 1 3 8.5z', 'stroke'], ['M16.5 8.8h4.5v6.4h-4.5z', 'fill'], ['M21 9.6h1.6M21 11.2h1.6M21 12.8h1.6M21 14.4h1.6M6 12h5', 'stroke']],
  comb: [['M2.5 7.5h19v3.2h-19z', 'fill'], ['M4 10.7v6M6.4 10.7v6M8.8 10.7v6M11.2 10.7v6M13.6 10.7v6M16 10.7v6M18.4 10.7v6M20.8 10.7v6', 'stroke']],
  brush: [['M2 12h8', 'stroke'], ['M10 9.5h3v5h-3z', 'fill'], ['M13 12a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0', 'stroke'], ['M14.5 6.5l-.8-1.5M17.5 6l0-1.7M20.5 6.5l.8-1.5M14.5 17.5l-.8 1.5M17.5 18l0 1.7M20.5 17.5l.8 1.5M22.6 12h1.4M13 12h-1', 'stroke']],
  clip: [['M2.5 9.5L19 7.8a2.2 2.2 0 0 1 0 4.4L2.5 14.5z', 'stroke'], ['M5 12h12', 'stroke'], ['M19.5 8.6a1.4 1.4 0 1 1 0 2.8', 'fill']],
  hand: [['M3 14.5c2-.2 3.5-1 5-2.2l3-2.6h9.5a1.3 1.3 0 0 1 0 2.6H14', 'stroke'], ['M12.5 12.3h8a1.3 1.3 0 0 1 0 2.6h-7.5M13 14.9h6.5a1.3 1.3 0 0 1 0 2.6H12.5c-2.5 0-5 .6-9.5 1', 'stroke']],
  spray: [['M3 9h7v10H3z', 'stroke'], ['M5 6.5h3V9H5zM8 7.2h3.5', 'fill'], ['M14 6l2.5-1.2M14 8h3M14 10l2.5 1.2M18.5 4.5l1.5-.6M19 8h1.5M18.5 11.5l1.5.6', 'stroke']],
  dryer: [['M2 6.5h12a3.5 3.5 0 0 1 0 7H2z', 'stroke'], ['M5 13.5l-1.5 6.5h3.5l1.8-6.5', 'stroke'], ['M17.5 8.5h2M17.5 10h4M17.5 11.5h2', 'stroke']],
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const f2 = x => (Math.round(x * 100) / 100).toString();
export const FONT = '-apple-system, BlinkMacSystemFont, "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", system-ui, sans-serif';

// 標字的位置：這一筆的中間附近（線的中點、文字與圖示的下方）
export function labelAnchor(s) {
  const g = geom(s);
  if (PATH_TYPES.includes(s.type)) {
    const L = pathLength(g.pts); let acc = 0;
    for (let i = 1; i < g.pts.length; i++) { const d = Math.hypot(g.pts[i][0] - g.pts[i - 1][0], g.pts[i][1] - g.pts[i - 1][1]); if (acc + d >= L / 2) { const t = (L / 2 - acc) / (d || 1); return [g.pts[i - 1][0] + (g.pts[i][0] - g.pts[i - 1][0]) * t + 2.5, g.pts[i - 1][1] + (g.pts[i][1] - g.pts[i - 1][1]) * t - 2.5]; } acc += d; }
  }
  let x0 = Infinity, y1 = -Infinity, x1 = -Infinity;
  for (const p of g.pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return [(x0 + x1) / 2, y1 + 5];
}
const LABEL_SIZE = 5.2;

// ---------------------------------------------------------------- SVG
// 一筆畫成 SVG 字串。opts：{ color（蓋過原本的顏色，選取中用）, ghost（淡）}
export function shapeSvg(s, opts = {}) {
  const st = s.style, c = opts.color || st.color, w = st.width, g = geom(s);
  const op = opts.ghost ? ' opacity="0.35"' : '';
  const dash = dashArray(st), da = dash ? ` stroke-dasharray="${dash.map(f2).join(' ')}"` : '';
  let body = '';
  const stroke = (d, extra = '') => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${f2(w)}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
  switch (s.type) {
    case 'line': case 'curve': case 'poly': case 'free': {
      body = stroke(g.d, da);
      for (const k of ['a', 'b']) { const cap = endCap(s.ends[k], g.ends[k], w); if (cap) body += cap.fill ? `<path d="${cap.d}" fill="${c}"/>` : stroke(cap.d); }
      break;
    }
    case 'region': body = `<path d="${g.d}" fill="${c}" fill-opacity="${f2(st.opacity)}" stroke="${c}" stroke-width="${f2(Math.max(0.3, w * 0.6))}" stroke-linejoin="round"${da}/>`; break;
    case 'ellipse': body = `<path d="${g.d}" fill="${st.fill ? c : 'none'}"${st.fill ? ` fill-opacity="${f2(Math.min(st.opacity, 0.35))}"` : ''} stroke="${c}" stroke-width="${f2(w)}"${da}/>`; break;
    case 'dot':
      if (s.mark === 'fill') body = `<path d="${g.d}" fill="${c}"/>`;
      else if (s.mark === 'ring') body = `<path d="${g.d}" fill="#fff" fill-opacity=".9" stroke="${c}" stroke-width="${f2(Math.max(0.4, s.r * 0.32))}"/>`;
      else body = stroke(g.d).replace(`stroke-width="${f2(w)}"`, `stroke-width="${f2(Math.max(0.4, s.r * 0.36))}"`);
      break;
    case 'text': {
      const [x, y] = s.pts[0], t = textSize(s);
      const box = s.box ? `<rect x="${f2(x - t.w / 2)}" y="${f2(y - t.h / 2)}" width="${f2(t.w)}" height="${f2(t.h)}" rx="${f2(s.size * 0.3)}" fill="#fff" fill-opacity=".92" stroke="${c}" stroke-width="${f2(Math.max(0.25, s.size * 0.04))}"/>` : '';
      body = `<g transform="rotate(${f2(s.rot)} ${f2(x)} ${f2(y)})">${box}<text x="${f2(x)}" y="${f2(y)}" font-size="${f2(s.size)}" font-family='${FONT}' font-weight="${s.bold ? 700 : 500}" fill="${c}" text-anchor="middle" dominant-baseline="central"${s.box ? '' : ' paint-order="stroke" stroke="#fff" stroke-width="' + f2(s.size * 0.18) + '" stroke-linejoin="round"'}>${esc(s.text)}</text></g>`;
      break;
    }
    case 'icon': {
      const [x, y] = s.pts[0], k = s.size / 24;
      const parts = (ICON_PATHS[s.icon] || []).map(([d, mode]) => mode === 'fill' ? `<path d="${d}" fill="${c}"/>` : `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
      body = `<g transform="translate(${f2(x)} ${f2(y)}) rotate(${f2(s.rot)}) scale(${s.flip ? -k : k} ${k}) translate(-12 -12)">${parts}</g>`;
      break;
    }
    case 'angle': {
      const a = angleInfo(s), lx = a.v[0] + (a.r + 6) * Math.cos(a.bis), ly = a.v[1] + (a.r + 6) * Math.sin(a.bis);
      body = stroke(g.d, da) + `<text x="${f2(lx)}" y="${f2(ly)}" font-size="5.6" font-family='${FONT}' font-weight="700" fill="${c}" text-anchor="middle" dominant-baseline="central" paint-order="stroke" stroke="#fff" stroke-width="1.2">${Math.round(a.deg)}°</text>`;
      break;
    }
  }
  if (s.label) { const [lx, ly] = labelAnchor(s); body += `<text x="${f2(lx)}" y="${f2(ly)}" font-size="${LABEL_SIZE}" font-family='${FONT}' font-weight="600" fill="${c}" paint-order="stroke" stroke="#fff" stroke-width="1.4" stroke-linejoin="round">${esc(s.label)}</text>`; }
  return `<g data-id="${esc(s.id)}"${op}>${body}</g>`;
}

// 底圖（紙、格線、立體底、線稿、髮際線、結構線、點位）畫成 SVG 字串
// tpl：template.js 的一個視圖；opt：{ grid, shade, hairline, structure, points, names, back（自己的底圖 URL）}
export function backgroundSvg(tpl, opt, patId) {
  const b = tpl.box;
  let s = `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#fff"/>`;
  if (opt.grid === 'grid') s += `<defs><pattern id="${patId}" width="10" height="10" patternUnits="userSpaceOnUse" x="${b.x}" y="${b.y}"><path d="M10 0H0V10" fill="none" stroke="#DDE3E8" stroke-width=".35"/></pattern></defs><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="url(#${patId})"/>`;
  else if (opt.grid === 'dots') s += `<defs><pattern id="${patId}" width="10" height="10" patternUnits="userSpaceOnUse" x="${b.x}" y="${b.y}"><circle cx="0" cy="0" r=".55" fill="#C5CDD4"/></pattern></defs><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="url(#${patId})"/>`;
  if (opt.back) s += `<image href="${opt.back}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" preserveAspectRatio="xMidYMid meet" opacity=".85"/>`;
  else {
    if (opt.shade) s += `<image href="${tpl.shadeUrl}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`;
    s += `<image href="${tpl.lineUrl}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`;
    if (opt.hairline) s += tpl.hairline.map(r => `<polyline points="${r.map(p => f2(p[0]) + ',' + f2(p[1])).join(' ')}" fill="none" stroke="${TEMPLATE_INK}" stroke-width=".55" stroke-dasharray="1.6 1.3" stroke-linecap="round"/>`).join('');
  }
  if (opt.structure) s += tpl.structure.flatMap(l => l.runs).map(r => `<polyline points="${r.map(p => f2(p[0]) + ',' + f2(p[1])).join(' ')}" fill="none" stroke="#9AA3AD" stroke-width=".45" stroke-dasharray="3 1.6"/>`).join('');
  if (opt.points) s += tpl.points.map(p => `<circle cx="${f2(p.p[0])}" cy="${f2(p.p[1])}" r="1.15" fill="#334155" stroke="#fff" stroke-width=".4"/>`).join('');
  if (opt.points && opt.names) s += tpl.points.map(p => `<text x="${f2(p.p[0] + 1.8)}" y="${f2(p.p[1] - 1.6)}" font-size="3.2" font-family='${FONT}' font-weight="600" fill="#334155" paint-order="stroke" stroke="#fff" stroke-width=".8">${esc(p.id)}</text>`).join('');
  return s;
}

// ---------------------------------------------------------------- canvas
function setStroke(ctx, c, w, dash) { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash(dash || []); }
// 沿取樣點走到第 t（0～1）的地方：回傳點與方向
function along(pts, t) {
  const L = pathLength(pts), target = L * t; let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + d >= target) { const u = (target - acc) / (d || 1); const dir = d ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : [1, 0]; return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], dir }; }
    acc += d;
  }
  const a = pts[pts.length - 2] || pts[0], b = pts[pts.length - 1], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return { p: b, dir: [(b[0] - a[0]) / d, (b[1] - a[1]) / d] };
}
// 一筆畫在 canvas 上。t＝畫到幾成（0～1，動畫用）：線照長度描出來、箭頭跟著線頭走；點、文字、圖示、面淡入
export function drawShape(ctx, s, t = 1, colorOverride = null) {
  if (t <= 0) return;
  const st = s.style, c = colorOverride || st.color, w = st.width, g = geom(s);
  ctx.save();
  const p2 = new Path2D(g.d);
  if (PATH_TYPES.includes(s.type) || s.type === 'ellipse' || s.type === 'angle') {
    const L = pathLength(g.pts) + 1, dash = dashArray(st);
    if (t < 1 && !dash) { setStroke(ctx, c, w, [L * t, L * 2]); }
    else setStroke(ctx, c, w, dash);
    if (t < 1 && dash) { ctx.save(); ctx.beginPath(); clipAlong(ctx, g.pts, t, w); ctx.clip(); }
    if (s.type === 'ellipse' && st.fill) { ctx.globalAlpha = Math.min(st.opacity, 0.35) * t; ctx.fillStyle = c; ctx.fill(p2); ctx.globalAlpha = 1; }
    ctx.stroke(p2);
    if (t < 1 && dash) ctx.restore();
    if (PATH_TYPES.includes(s.type)) {
      ctx.setLineDash([]);
      const head = t < 1 ? along(g.pts, t) : null;
      for (const k of ['a', 'b']) {
        const kind = s.ends[k]; if (kind === 'none') continue;
        if (k === 'a') { drawCap(ctx, endCap(kind, g.ends.a, w), c, w); continue; }
        drawCap(ctx, endCap(kind, head ? { p: head.p, dir: head.dir } : g.ends.b, w), c, w); // 終點的箭頭跟著線頭走
      }
    }
    if (s.type === 'angle' && t >= 1) { const a = angleInfo(s); text(ctx, Math.round(a.deg) + '°', a.v[0] + (a.r + 6) * Math.cos(a.bis), a.v[1] + (a.r + 6) * Math.sin(a.bis), 5.6, 700, c, 'center', 1.2); }
  } else {
    ctx.globalAlpha = t;
    if (t < 1) { const k = 0.96 + 0.04 * t, cx = s.pts[0][0], cy = s.pts[0][1]; ctx.translate(cx, cy); ctx.scale(k, k); ctx.translate(-cx, -cy); }
    if (s.type === 'region') { ctx.globalAlpha = st.opacity * t; ctx.fillStyle = c; ctx.fill(p2); ctx.globalAlpha = t; setStroke(ctx, c, Math.max(0.3, w * 0.6), dashArray(st)); ctx.stroke(p2); }
    else if (s.type === 'dot') {
      if (s.mark === 'fill') { ctx.fillStyle = c; ctx.fill(p2); }
      else if (s.mark === 'ring') { ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill(p2); setStroke(ctx, c, Math.max(0.4, s.r * 0.32)); ctx.stroke(p2); }
      else { setStroke(ctx, c, Math.max(0.4, s.r * 0.36)); ctx.stroke(p2); }
    } else if (s.type === 'text') {
      const [x, y] = s.pts[0], tz = textSize(s);
      ctx.translate(x, y); ctx.rotate(s.rot * Math.PI / 180);
      if (s.box) { ctx.fillStyle = 'rgba(255,255,255,.92)'; roundRect(ctx, -tz.w / 2, -tz.h / 2, tz.w, tz.h, s.size * 0.3); ctx.fill(); setStroke(ctx, c, Math.max(0.25, s.size * 0.04)); ctx.stroke(); }
      text(ctx, s.text, 0, 0, s.size, s.bold ? 700 : 500, c, 'center', s.box ? 0 : s.size * 0.18);
    } else if (s.type === 'icon') {
      const [x, y] = s.pts[0], k = s.size / 24;
      ctx.translate(x, y); ctx.rotate(s.rot * Math.PI / 180); ctx.scale(s.flip ? -k : k, k); ctx.translate(-12, -12);
      for (const [d, mode] of ICON_PATHS[s.icon] || []) { const p = new Path2D(d); if (mode === 'fill') { ctx.fillStyle = c; ctx.fill(p); } else { setStroke(ctx, c, 1.6); ctx.stroke(p); } }
    }
  }
  ctx.restore();
  if (s.label && t >= 1) { const [lx, ly] = labelAnchor(s); text(ctx, s.label, lx, ly, LABEL_SIZE, 600, c, 'left', 1.4); }
}
function drawCap(ctx, cap, c, w) {
  if (!cap) return;
  const p = new Path2D(cap.d);
  if (cap.fill) { ctx.fillStyle = c; ctx.fill(p); } else { setStroke(ctx, c, w); ctx.stroke(p); }
}
// 虛線描到一半：用沿線的粗帶子當遮罩
function clipAlong(ctx, pts, t, w) {
  const L = pathLength(pts), target = L * t; let acc = 0; const r = w * 4 + 3;
  for (let i = 1; i < pts.length && acc <= target; i++) {
    const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = Math.min(1, (target - acc) / (d || 1)), e = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    const nx = -(b[1] - a[1]) / (d || 1) * r, ny = (b[0] - a[0]) / (d || 1) * r;
    ctx.moveTo(a[0] + nx, a[1] + ny); ctx.lineTo(e[0] + nx, e[1] + ny); ctx.lineTo(e[0] - nx, e[1] - ny); ctx.lineTo(a[0] - nx, a[1] - ny); ctx.closePath();
    ctx.moveTo(a[0] + r, a[1]); ctx.arc(a[0], a[1], r, 0, Math.PI * 2);
    acc += d;
  }
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function text(ctx, str, x, y, size, weight, color, align, halo) {
  ctx.save(); ctx.setLineDash([]);
  ctx.font = `${weight} ${size}px ${FONT}`; ctx.textAlign = align; ctx.textBaseline = align === 'left' ? 'alphabetic' : 'middle';
  if (halo) { ctx.strokeStyle = '#fff'; ctx.lineWidth = halo; ctx.lineJoin = 'round'; ctx.strokeText(str, x, y); }
  ctx.fillStyle = color; ctx.fillText(str, x, y);
  ctx.restore();
}

// 底圖畫在 canvas 上（ctx 已經換成公釐座標）。back＝自己的底圖（Image）
export function drawBackground(ctx, tpl, opt, back = null) {
  const b = tpl.box;
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.fillRect(b.x, b.y, b.w, b.h);
  if (opt.grid === 'grid' || opt.grid === 'dots') {
    ctx.strokeStyle = '#DDE3E8'; ctx.fillStyle = '#C5CDD4'; ctx.lineWidth = 0.35;
    for (let x = Math.ceil(b.x / 10) * 10; x <= b.x + b.w; x += 10) for (let y = Math.ceil(b.y / 10) * 10; y <= b.y + b.h; y += 10) {
      if (opt.grid === 'dots') { ctx.beginPath(); ctx.arc(x, y, 0.55, 0, Math.PI * 2); ctx.fill(); }
    }
    if (opt.grid === 'grid') {
      ctx.beginPath();
      for (let x = Math.ceil(b.x / 10) * 10; x <= b.x + b.w; x += 10) { ctx.moveTo(x, b.y); ctx.lineTo(x, b.y + b.h); }
      for (let y = Math.ceil(b.y / 10) * 10; y <= b.y + b.h; y += 10) { ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y); }
      ctx.stroke();
    }
  }
  if (back) {
    const k = Math.min(b.w / back.width, b.h / back.height), w = back.width * k, h = back.height * k;
    ctx.globalAlpha = 0.85; ctx.drawImage(back, b.x + (b.w - w) / 2, b.y + (b.h - h) / 2, w, h); ctx.globalAlpha = 1;
  } else {
    if (opt.shade) ctx.drawImage(tpl.shade, b.x, b.y, b.w, b.h);
    ctx.drawImage(tpl.line, b.x, b.y, b.w, b.h);
    if (opt.hairline) { setStroke(ctx, TEMPLATE_INK, 0.55, [1.6, 1.3]); for (const r of tpl.hairline) poly(ctx, r); }
  }
  if (opt.structure) { setStroke(ctx, '#9AA3AD', 0.45, [3, 1.6]); for (const l of tpl.structure) for (const r of l.runs) poly(ctx, r); }
  if (opt.points) for (const p of tpl.points) { ctx.setLineDash([]); ctx.beginPath(); ctx.arc(p.p[0], p.p[1], 1.15, 0, Math.PI * 2); ctx.fillStyle = '#334155'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.4; ctx.stroke(); }
  ctx.restore();
}
function poly(ctx, r) { ctx.beginPath(); r.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke(); }

// 一個視圖整張畫在 canvas 上：底圖＋筆。progress（可省略）＝每一筆畫到幾成（Map id → 0～1）
export function drawView(ctx, tpl, shapes, opt, { progress = null, back = null } = {}) {
  drawBackground(ctx, tpl, opt, back);
  for (const s of shapes) drawShape(ctx, s, progress ? (progress.has(s.id) ? progress.get(s.id) : 1) : 1);
}
