// 全屋墙面一体化壳网格生成器（纯 JS，无 three 依赖，可在 node 中直接测试）
//
// 算法：俯视矩形（墙 + 门洞）→ 平面 arrangement 切分 → 最左转面遍历得到平面单元 →
// 按覆盖关系标注每个单元的实体高度区间 → 只在相邻单元实体区间有差异处发射表面。
// 每个面恰好生成一次：天然无重叠几何、无藏在实体内部的无效面、无不可见的贴地底面。
// L/T/X 连接、门洞（门楣 + 门垛）、每墙不同高度（台阶面）全部由同一套规则统一处理。
//
// 坐标约定与 model.js 一致：俯视 x 右、z 下，y 向上；墙面 A 面法线为 [dz, -dx]。

const SNAP = 1e-4;      // 顶点吸附网格（0.1mm），消除浮点抖动导致的重边/裂缝
const JOIN_EPS = 0.01;  // 墙端连接判定阈值（米）
const EPS = 1e-9;

const snap = v => Math.round(v / SNAP) * SNAP;
const vkey = (x, z) => `${snap(x).toFixed(4)},${snap(z).toFixed(4)}`;

function signedArea2(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

function pointSegDist(p, a, b) {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const l2 = abx * abx + abz * abz;
  if (l2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / l2));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + abz * t));
}

// 射线法 even-odd；采样点已内缩，不会落在边界上
function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- 俯视矩形 ----------

// 每面墙一个俯视矩形（中心线 ± 半厚）。连接端（端点与其他墙端点重合或落在
// 对方墙身上，沿用 JOIN_EPS 判定）沿墙向外延伸自身半厚，让 L 拐角方块、
// T 型接头由并集自然填满；自由端不外延（端面平齐）。
export function wallRects(walls) {
  const infos = [];
  for (const w of walls) {
    const dx = w.end[0] - w.start[0], dz = w.end[1] - w.start[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) continue;
    infos.push({
      wall: w, len,
      d: [dx / len, dz / len],
      n: [dz / len, -dx / len], // A 面法线
      s: (w.thickness || 0.2) / 2,
      h: w.height || 2.8,
    });
  }
  const rects = [];
  for (const cur of infos) {
    let ext0 = 0, ext1 = 0;
    for (const oth of infos) {
      if (oth === cur) continue;
      if (endConnected(cur.wall.start, oth)) ext0 = cur.s;
      if (endConnected(cur.wall.end, oth)) ext1 = cur.s;
    }
    const ax = cur.wall.start[0] - cur.d[0] * ext0, az = cur.wall.start[1] - cur.d[1] * ext0;
    const bx = cur.wall.end[0] + cur.d[0] * ext1, bz = cur.wall.end[1] + cur.d[1] * ext1;
    rects.push({
      corners: [
        [ax + cur.n[0] * cur.s, az + cur.n[1] * cur.s],
        [bx + cur.n[0] * cur.s, bz + cur.n[1] * cur.s],
        [bx - cur.n[0] * cur.s, bz - cur.n[1] * cur.s],
        [ax - cur.n[0] * cur.s, az - cur.n[1] * cur.s],
      ],
      wall: cur.wall,
      h: cur.h,
    });
  }
  return rects;
}

function endConnected(p, oth) {
  const near = q => Math.hypot(p[0] - q[0], p[1] - q[1]) < JOIN_EPS;
  if (near(oth.wall.start) || near(oth.wall.end)) return true;
  return pointSegDist(p, oth.wall.start, oth.wall.end) < JOIN_EPS;
}

// 门洞矩形：沿墙 宽 × (厚 + 0.04)，两侧各外扩 0.02，避免门矩形边与墙边共线退化
function doorRects(walls, doors) {
  const byId = new Map(walls.map(w => [w.id, w]));
  const out = [];
  for (const d of doors || []) {
    const wall = byId.get(d.wall);
    if (!wall) continue;
    const dx = wall.end[0] - wall.start[0], dz = wall.end[1] - wall.start[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) continue;
    const ddx = dx / len, ddz = dz / len;
    const nx = ddz, nz = -ddx;
    const v = (wall.thickness || 0.2) / 2 + 0.02;
    const u0 = d.pos - d.width / 2, u1 = d.pos + d.width / 2;
    const ax = wall.start[0] + ddx * u0, az = wall.start[1] + ddz * u0;
    const bx = wall.start[0] + ddx * u1, bz = wall.start[1] + ddz * u1;
    out.push({
      corners: [
        [ax + nx * v, az + nz * v],
        [bx + nx * v, bz + nz * v],
        [bx - nx * v, bz - nz * v],
        [ax - nx * v, az - nz * v],
      ],
      door: d,
      dh: d.height || 2.0,
    });
  }
  return out;
}

// ---------- 平面 arrangement ----------

// 所有矩形边在所有交点（含共线重叠）处切分，顶点按 SNAP 吸附去重，
// 半边图最左转面遍历（与 model.js detectRooms 同一套范式），返回所有平面单元。
function arrangementFaces(rects) {
  const segs = [];
  for (const r of rects) {
    const c = r.corners;
    for (let i = 0; i < 4; i++) {
      segs.push({ ax: c[i][0], az: c[i][1], bx: c[(i + 1) % 4][0], bz: c[(i + 1) % 4][1], pts: [0, 1] });
    }
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) splitPair(segs[i], segs[j]);
  }

  const vertices = new Map();
  const addV = (x, z) => {
    const k = vkey(x, z);
    if (!vertices.has(k)) vertices.set(k, { x: snap(x), z: snap(z), edges: [] });
    return k;
  };
  const edgeMap = new Map(); // 无向边去重：两矩形共线贴边时只保留一条
  for (const s of segs) {
    const cuts = [...new Set(s.pts.filter(t => t > 1e-6 && t < 1 - 1e-6))].sort((a, b) => a - b);
    let px = s.ax, pz = s.az;
    const push = (qx, qz) => {
      const k1 = addV(px, pz), k2 = addV(qx, qz);
      if (k1 !== k2) {
        const key = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
        if (!edgeMap.has(key)) {
          const e = { a: k1, b: k2 };
          edgeMap.set(key, e);
          vertices.get(k1).edges.push(e);
          vertices.get(k2).edges.push(e);
        }
      }
      px = qx; pz = qz;
    };
    for (const t of cuts) push(s.ax + (s.bx - s.ax) * t, s.az + (s.bz - s.az) * t);
    push(s.bx, s.bz);
  }

  for (const [k, v] of vertices) {
    v.angles = v.edges.map(e => {
      const other = e.a === k ? e.b : e.a;
      const o = vertices.get(other);
      return { e, angle: Math.atan2(o.z - v.z, o.x - v.x) };
    }).sort((p, q) => p.angle - q.angle);
  }

  const visited = new Set();
  const faces = [];
  for (const e of edgeMap.values()) {
    for (const [kFrom, kTo] of [[e.a, e.b], [e.b, e.a]]) {
      if (visited.has(kFrom + '>' + kTo)) continue;
      const pts = [];
      let curFrom = kFrom, curTo = kTo, guard = 0;
      while (guard++ < 10000) {
        visited.add(curFrom + '>' + curTo);
        const vt = vertices.get(curTo);
        const jdx = vt.angles.findIndex(a => {
          const other = a.e.a === curTo ? a.e.b : a.e.a;
          return other === curFrom;
        });
        const next = vt.angles[(jdx + 1) % vt.angles.length];
        pts.push([vt.x, vt.z]);
        curFrom = curTo;
        curTo = next.e.a === curFrom ? next.e.b : next.e.a;
        if (curFrom === kFrom && curTo === kTo) break;
      }
      if (pts.length >= 3) faces.push(pts);
    }
  }

  const alive = faces.filter(f => Math.abs(signedArea2(f)) > 1e-8);
  if (!alive.length) return [];
  // 去掉外平面（面积最大者）
  let outer = 0, outerArea = -1;
  alive.forEach((f, i) => {
    const a = Math.abs(signedArea2(f));
    if (a > outerArea) { outerArea = a; outer = i; }
  });
  alive.splice(outer, 1);
  return alive;
}

// 一般线段相交：普通 crossing 给两边加内部参数；共线重叠时互相投影端点
function splitPair(s, t) {
  const d1x = s.bx - s.ax, d1z = s.bz - s.az;
  const d2x = t.bx - t.ax, d2z = t.bz - t.az;
  const rx = t.ax - s.ax, rz = t.az - s.az;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) > EPS) {
    const tt = (rx * d2z - rz * d2x) / den;
    const u = (rx * d1z - rz * d1x) / den;
    if (tt > 1e-7 && tt < 1 - 1e-7) s.pts.push(tt);
    if (u > 1e-7 && u < 1 - 1e-7) t.pts.push(u);
    return;
  }
  const len1 = Math.hypot(d1x, d1z);
  if (Math.abs(rx * d1z - rz * d1x) < 1e-7 * len1 && len1 > EPS) {
    // 共线：把对方端点投到自己身上
    const l2 = d1x * d1x + d1z * d1z;
    for (const [px, pz] of [[t.ax, t.az], [t.bx, t.bz]]) {
      const tt = ((px - s.ax) * d1x + (pz - s.az) * d1z) / l2;
      if (tt > 1e-7 && tt < 1 - 1e-7) s.pts.push(tt);
    }
    const l2t = d2x * d2x + d2z * d2z;
    if (l2t > EPS) {
      for (const [px, pz] of [[s.ax, s.az], [s.bx, s.bz]]) {
        const u = ((px - t.ax) * d2x + (pz - t.az) * d2z) / l2t;
        if (u > 1e-7 && u < 1 - 1e-7) t.pts.push(u);
      }
    }
  }
}

// 单元内部采样点：逐边中点沿内法线内缩 1mm，取第一个落在多边形内的；
// 凹多边形退化为质心
function samplePoint(poly) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    let nx = -(b[1] - a[1]), nz = b[0] - a[0];
    const l = Math.hypot(nx, nz);
    if (l < EPS) continue;
    nx /= l; nz /= l;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const cand = [mx + nx * 1e-3, mz + nz * 1e-3];
    if (pointInPolygon(cand, poly)) return cand;
    const back = [mx - nx * 1e-3, mz - nz * 1e-3];
    if (pointInPolygon(back, poly)) return back;
  }
  let cx = 0, cz = 0;
  for (const [x, z] of poly) { cx += x; cz += z; }
  return [cx / poly.length, cz / poly.length];
}

// ---------- 单元分类 ----------

// 平面 arrangement 的每个单元标注被哪些墙/门洞覆盖，得到实体高度区间：
//   无墙覆盖 → 空单元（void）
//   有墙无门 → [0, H]，H = 覆盖墙最大高度（兼容不同墙高）
//   有墙有门 → [门高, H]（门楣区间，门下悬空）
export function computeWallCells(walls, doors = []) {
  const wrects = wallRects(walls);
  const drects = doorRects(walls, doors);
  const faces = arrangementFaces([...wrects, ...drects]);
  return faces.map(face => {
    const polygon = signedArea2(face) < 0 ? [...face].reverse() : face;
    const sample = samplePoint(polygon);
    const cw = wrects.filter(r => pointInPolygon(sample, r.corners));
    const cd = drects.filter(r => pointInPolygon(sample, r.corners));
    let y0 = 0, y1 = 0;
    if (cw.length) {
      y1 = Math.max(...cw.map(r => r.h));
      if (cd.length) y0 = Math.min(y1, Math.max(...cd.map(r => r.dh)));
    }
    return { polygon, sample, walls: cw.map(r => r.wall), doors: cd.map(r => r.door), y0, y1 };
  });
}

// ---------- 表面发射 ----------

// 把三角形按顶点写入 soup；winding 与外法线一致（保证正确剔除），退化三角形丢弃
function emitTriangle(positions, normals, a, b, c, n) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  if (Math.hypot(cx, cy, cz) < 1e-12) return;
  let q = b, r = c;
  if (cx * n[0] + cy * n[1] + cz * n[2] < 0) { q = c; r = b; }
  positions.push(a[0], a[1], a[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  for (let i = 0; i < 3; i++) normals.push(n[0], n[1], n[2]);
}

function emitQuad(positions, normals, a, b, c, d, n) {
  emitTriangle(positions, normals, a, b, c, n);
  emitTriangle(positions, normals, a, c, d, n);
}

// 耳切三角化（简单多边形，CCW）；退化时退化为扇形
function triangulate(poly) {
  const n = poly.length;
  if (n < 3) return [];
  const idx = poly.map((_, i) => i);
  if (signedArea2(poly) < 0) idx.reverse();
  const tris = [];
  let guard = n * n + 10;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i - 1 + idx.length) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cross <= 1e-12) continue; // 凹顶点或退化
      let hasInside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTriangle(poly[j], a, b, c)) { hasInside = true; break; }
      }
      if (hasInside) continue;
      tris.push([i0, i1, i2]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  else for (let i = 1; i + 1 < idx.length; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
  return tris;
}

function pointInTriangle(p, a, b, c) {
  const cr = (u, v) => u[0] * v[1] - u[1] * v[0];
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1]];
  const d1 = cr(sub(p, a), sub(b, a));
  const d2 = cr(sub(p, b), sub(c, b));
  const d3 = cr(sub(p, c), sub(a, c));
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function solidOf(cell) {
  return cell.y1 - cell.y0 > EPS ? [cell.y0, cell.y1] : null;
}

// 竖直面：比较边两侧单元的实体区间，只在区间对称差高度段发射四边形，
// 法线朝向无实体一侧。侧边、门垛（0→门高）、不同墙高的台阶面全由这一条规则产生。
function emitEdgeDiff(e, A, B, positions, normals) {
  const sa = solidOf(A), sb = B ? solidOf(B) : null;
  if (!sa && !sb) return;
  if (sa && sb && Math.abs(sa[0] - sb[0]) < EPS && Math.abs(sa[1] - sb[1]) < EPS) return;
  const ys = [];
  if (sa) ys.push(sa[0], sa[1]);
  if (sb) ys.push(sb[0], sb[1]);
  ys.sort((a, b) => a - b);
  const bounds = ys.filter((v, i) => i === 0 || v - ys[i - 1] > EPS);

  const ux = e.bx - e.ax, uz = e.bz - e.az;
  const len = Math.hypot(ux, uz);
  if (len < EPS) return;
  const lnx = -uz / len, lnz = ux / len; // 有向边 a→b 的左法线

  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = bounds[i], hi = bounds[i + 1];
    const mid = (lo + hi) / 2;
    const inA = !!sa && sa[0] <= mid && mid <= sa[1];
    const inB = !!sb && sb[0] <= mid && mid <= sb[1];
    if (inA === inB) continue;
    const solidCell = inA ? A : B;
    const side = (e.bx - e.ax) * (solidCell.sample[1] - e.az) - (e.bz - e.az) * (solidCell.sample[0] - e.ax);
    const nx = side > 0 ? -lnx : lnx, nz = side > 0 ? -lnz : lnz;
    emitQuad(
      positions, normals,
      [e.ax, lo, e.az], [e.bx, lo, e.bz], [e.bx, hi, e.bz], [e.ax, hi, e.az],
      [nx, 0, nz],
    );
  }
}

// 水平面：实体单元的顶盖（朝上）与悬空底面（朝下，即门楣底面）；不生成贴地底面
function emitCap(cell, y, n, positions, normals) {
  const pts = cell.polygon.map(([x, z]) => [x, y, z]);
  for (const [i, j, k] of triangulate(cell.polygon)) {
    emitTriangle(positions, normals, pts[i], pts[j], pts[k], n);
  }
}

// ---------- 对外 API ----------

// 生成全屋墙面壳网格：{ positions: [x,y,z,...], normals: [nx,ny,nz,...] } 三角形汤，
// 每面顶点独立、法线解析给出，可直接填进 THREE.BufferGeometry。
export function buildWallShell(walls, doors = []) {
  const cells = computeWallCells(walls, doors);
  const positions = [], normals = [];

  // 边 → 相邻单元（去重后边最多两侧各一个单元）
  const edgeMap = new Map();
  cells.forEach((cell, ci) => {
    const poly = cell.polygon;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const k1 = vkey(p[0], p[1]), k2 = vkey(q[0], q[1]);
      const key = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
      let e = edgeMap.get(key);
      if (!e) { e = { ax: p[0], az: p[1], bx: q[0], bz: q[1], cells: [] }; edgeMap.set(key, e); }
      if (!e.cells.includes(ci)) e.cells.push(ci);
    }
  });

  for (const e of edgeMap.values()) {
    if (e.cells.length > 2) continue; // 理论上不存在，防御
    emitEdgeDiff(e, cells[e.cells[0]], e.cells.length > 1 ? cells[e.cells[1]] : null, positions, normals);
  }

  for (const cell of cells) {
    const s = solidOf(cell);
    if (!s) continue;
    emitCap(cell, s[1], [0, 1, 0], positions, normals);
    if (s[0] > 1e-6) emitCap(cell, s[0], [0, -1, 0], positions, normals);
  }

  return { positions, normals };
}

// 拾取辅助：命中点 → 最近的墙与该墙的 face（与 wallNormal(wall, face) 语义一致，
// 对顶盖/门楣底面命中同样稳健）。point 为 [x, y, z]。
// hitNormal 为射线命中的世界法向（可选）：T/L 接头处命中点常同时落在多面墙的容差管内，
// 距中心线最近不一定是被点的墙（如点 stem 墙面却更近宿主中心线）——此时用法向过滤候选，
// 仅保留与某个面法向夹角 ≤60° 的墙；全部被过滤时回退最近距离，保证顶盖/门楣命中仍稳健。
export function locateWall(walls, point, tol = 0.05, hitNormal = null) {
  const [x, y, z] = point;
  let hn = null;
  if (hitNormal) {
    const l = Math.hypot(hitNormal[0], hitNormal[1], hitNormal[2]);
    if (l > 1e-9) hn = [hitNormal[0] / l, hitNormal[1] / l, hitNormal[2] / l];
  }
  // useNormal：仅保留命中法向与某个面法向夹角 ≤60° 的候选
  const scan = useNormal => {
    let best = null, bestD = Infinity;
    for (const w of walls || []) {
      const d = pointSegDist([x, z], w.start, w.end);
      const s = (w.thickness || 0.2) / 2;
      const h = w.height || 2.8;
      if (d > s + tol || y < -tol || y > h + tol || d >= bestD) continue;
      if (useNormal) {
        const dx = w.end[0] - w.start[0], dz = w.end[1] - w.start[1];
        const len = Math.hypot(dx, dz) || 1;
        // 墙两个面法线为 ±[dz, -dx]/len（y 分量为 0）；命中法向须与其中之一大致同向
        const dot = Math.abs(hn[0] * dz / len - hn[2] * dx / len);
        if (dot < 0.5) continue; // 夹角 >60°，不是被点的那个面
      }
      bestD = d;
      best = w;
    }
    return best;
  };
  // 法向过滤后无幸存者（如顶盖/门楣底面命中，法向垂直于所有墙面）时回退最近距离
  const best = (hn ? scan(true) : null) || scan(false);
  if (!best) return null;
  const dx = best.end[0] - best.start[0], dz = best.end[1] - best.start[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return { wall: best, face: 0 };
  // face 0 = A 面 = 左法线 [dz, -dx] 一侧
  const side = ((x - best.start[0]) * dz - (z - best.start[1]) * dx) / len;
  return { wall: best, face: side >= 0 ? 0 : 1 };
}
