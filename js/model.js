// 数据模型：墙、房间检测、线路计算、通用工具函数

export const CIRCUIT_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#46f0f0', '#f032e6', '#bcf60c', '#008080', '#9a6324',
  '#800000', '#808000', '#000075', '#e6beff', '#aa6e28',
];

export const DEVICE_TYPES = {
  socket: { name: '插座', color: '#c04040', shape: 'socket' },
  switch: { name: '开关', color: '#4060c0', shape: 'switch' },
  light: { name: '灯具', color: '#e0a020', shape: 'light' },
  breakerBox: { name: '强电箱', color: '#3a4048', shape: 'breakerBox' },
};

export const NODE_TYPE_NAMES = {
  turn: '转弯端点',
  split: '分线端点',
  device: '设备',
};

// 强电箱统一尺寸（米）：宽(沿墙) × 高 × 深(出墙)，各处渲染必须引用此常量
export const BREAKER_BOX_SIZE = { w: 0.5, h: 0.7, d: 0.14 };

// 端子高度：每条线路占 1 权重，两端各预留 0.5 权重（总 n+1 权重均分箱高），返回第 i 条（0 起）端子高度
export function breakerTerminalHeight(i, n, boxCenterHeight) {
  const unit = BREAKER_BOX_SIZE.h / (n + 1);
  return boxCenterHeight - BREAKER_BOX_SIZE.h / 2 + (i + 1) * unit;
}

let idCounter = 1;
export function genId(prefix) {
  return `${prefix}${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

export function createEmptyData() {
  return {
    version: 2,
    walls: [],
    nodes: [],
    wires: [],
    links: [],
    doors: [],
    roomNames: {},
    roomNameHints: [],
  };
}

// 门：开在墙上的通道。pos 为门中心沿墙距离，width 门洞宽，face 开门方向（0/1）
export const DOOR_MIN_WIDTH = 0.4;
export const DOOR_DEFAULT_WIDTH = 0.9;
export const DOOR_DEFAULT_HEIGHT = 2.0;

export function createDoor(wallId, pos, width, face) {
  return {
    id: genId('d'),
    wall: wallId,
    pos,
    width: width || DOOR_DEFAULT_WIDTH,
    face: face || 0,
    height: DOOR_DEFAULT_HEIGHT,
  };
}

export function createWall(x1, z1, x2, z2) {
  return {
    id: genId('w'),
    start: [x1, z1],
    end: [x2, z2],
    height: 2.8,
    thickness: 0.2,
  };
}

// pos 为沿墙的 0~1 归一化坐标（0=墙起点端，1=墙终点端），与墙长无关；
// 墙在电路编辑/预览中被派生拆分时，pos 始终相对于原始整墙
export function createNode(type, wallId, face, pos, height, deviceType) {
  return {
    id: genId('n'),
    type,
    wall: wallId,
    face,
    pos,
    height,
    deviceType: type === 'device' ? (deviceType || 'socket') : undefined,
    label: '',
  };
}

export function createWire(from, to) {
  return { id: genId('e'), from, to, label: '' };
}

// 强电箱是一种特殊设备：作为设备节点存放在 nodes 中，断路器挂在节点上
// pos 同样为沿墙的 0~1 归一化坐标
export function createBreakerBox(wallId, face, pos) {
  return {
    id: genId('bb'),
    type: 'device',
    deviceType: 'breakerBox',
    wall: wallId,
    face,
    pos,
    height: 1.6,
    label: '强电箱',
    breakers: [], // { id, label, terminal: 节点id（箱内端子） }
  };
}

export function findBreakerBox(data) {
  return (data.nodes || []).find(n => n.type === 'device' && n.deviceType === 'breakerBox') || null;
}

// 旧版数据把强电箱存为顶层 breakerBox 对象，迁移为设备节点；
// 强电箱是有且仅有一个、默认存在的特殊设备：有墙就必须有箱体，
// 缺失时补建到第一堵墙中点，所在墙失效时重新挂靠
export function normalizeData(data) {
  if (data && !Array.isArray(data.doors)) data.doors = []; // 旧数据没有门字段
  if (data && data.breakerBox) {
    const box = data.breakerBox;
    data.nodes = data.nodes || [];
    data.nodes.push({
      id: box.id || genId('bb'),
      type: 'device',
      deviceType: 'breakerBox',
      wall: box.wall,
      face: box.face,
      pos: box.pos,
      height: box.height != null ? box.height : 1.6,
      label: box.label || '强电箱',
      breakers: box.breakers || [],
    });
    delete data.breakerBox;
  }
  if (data && Array.isArray(data.walls) && Array.isArray(data.nodes) && data.walls.length) {
    const first = data.walls[0];
    const box = findBreakerBox(data);
    if (!box) {
      data.nodes.push(createBreakerBox(first.id, 1, 0.5));
    } else if (!data.walls.some(w => w.id === box.wall)) {
      box.wall = first.id;
      box.face = 1;
      box.pos = 0.5;
    }
  }
  // v1→v2（放在最后：顶层 breakerBox 迁移进来的 pos 还是米数，一并转换）：
  // 节点 pos 从沿墙米数改为 0~1 归一化坐标（门保持米数不变）
  if (data && typeof data.version === 'number' && data.version < 2) {
    if (Array.isArray(data.walls) && Array.isArray(data.nodes)) {
      const wallsById = new Map(data.walls.map(w => [w.id, w]));
      for (const n of data.nodes) {
        const w = wallsById.get(n.wall);
        if (!w) continue;
        const len = wallLen(w);
        if (!(len > 0)) { n.pos = 0; continue; }
        n.pos = Math.min(1, Math.max(0, Math.round((n.pos / len) * 10000) / 10000));
      }
    }
    data.version = 2;
  }
  return data;
}

export function addLink(data, a, b) {
  if (!data.links) data.links = [];
  if (data.links.some(l => (l.a === a && l.b === b) || (l.a === b && l.b === a))) return null;
  const link = { id: genId('l'), a, b };
  data.links.push(link);
  return link;
}

export function removeLink(data, linkId) {
  if (!data.links) return;
  data.links = data.links.filter(l => l.id !== linkId);
}

export function linksOf(data, nodeId) {
  return (data.links || []).filter(l => l.a === nodeId || l.b === nodeId);
}

// ---------- 墙的几何工具 ----------

export function wallLen(wall) {
  const dx = wall.end[0] - wall.start[0];
  const dz = wall.end[1] - wall.start[1];
  return Math.hypot(dx, dz);
}

export function wallDir(wall) {
  const len = wallLen(wall);
  return [(wall.end[0] - wall.start[0]) / len, (wall.end[1] - wall.start[1]) / len];
}

export function wallNormal(wall, face) {
  const [dx, dz] = wallDir(wall);
  // A面为墙的左侧法线，B面为右侧法线（俯视，x 右 z 下）
  return face === 0 ? [dz, -dx] : [-dz, dx];
}

// 节点在世界坐标中的位置（墙面上的点）；node.pos 为沿墙 0~1 归一化坐标
export function nodeWorldPos(node, wallsById) {
  const wall = wallsById.get(node.wall);
  if (!wall) return null;
  const [dx, dz] = wallDir(wall);
  const t = node.pos * wallLen(wall);
  const off = (wall.thickness || 0.2) / 2;
  const [nx, nz] = wallNormal(wall, node.face);
  return [
    wall.start[0] + dx * t + nx * off,
    node.height,
    wall.start[1] + dz * t + nz * off,
  ];
}

// ---------- 相邻墙面与公共墙面角点（三墙展开 / 跨墙走线共用） ----------

export const WALL_JOIN_EPS = 0.02; // 墙端/墙身交接判定容差（米）

// 点 P 在墙线段上的最近参数 t（0~1，按墙长归一）；距离超过 tol 返回 null
function wallParamNear(wall, px, pz, tol) {
  const len = wallLen(wall);
  if (!(len > 0)) return null;
  const [dx, dz] = wallDir(wall);
  const rx = px - wall.start[0], rz = pz - wall.start[1];
  const s = Math.min(len, Math.max(0, rx * dx + rz * dz));
  const cx = wall.start[0] + dx * s, cz = wall.start[1] + dz * s;
  if (Math.hypot(px - cx, pz - cz) > tol) return null;
  return s / len;
}

// 两面墙指定面的面线（墙面在平面上的投影线）求交：
// 返回 { s, u, qx, qz, sin }（s/u 为交点沿两墙中心线的米制距离，sin 为夹角正弦）；平行返回 null
function faceLineIntersect(wa, fa, wb, fb) {
  const [dax, daz] = wallDir(wa);
  const [dbx, dbz] = wallDir(wb);
  const denom = dax * dbz - daz * dbx;
  if (Math.abs(denom) < 1e-9) return null;
  const offA = (wa.thickness || 0.2) / 2, offB = (wb.thickness || 0.2) / 2;
  const [nax, naz] = wallNormal(wa, fa);
  const [nbx, nbz] = wallNormal(wb, fb);
  const ax = wa.start[0] + nax * offA, az = wa.start[1] + naz * offA;
  const bx = wb.start[0] + nbx * offB, bz = wb.start[1] + nbz * offB;
  const s = ((bx - ax) * dbz - (bz - az) * dbx) / denom;
  const u = ((bx - ax) * daz - (bz - az) * dax) / denom;
  return { s, u, qx: ax + dax * s, qz: az + daz * s, sin: Math.abs(denom) };
}

// 两面墙中心线是否相接（端点落在对方墙身/端点上，或中心线相交）
function wallsConnected(wa, wb) {
  const tol = (wa.thickness || 0.2) / 2 + (wb.thickness || 0.2) / 2 + WALL_JOIN_EPS;
  for (const p of [wa.start, wa.end]) {
    if (wallParamNear(wb, p[0], p[1], tol) != null) return true;
  }
  for (const p of [wb.start, wb.end]) {
    if (wallParamNear(wa, p[0], p[1], tol) != null) return true;
  }
  // X 型交叉：端点互不靠近但中心线相交
  const [dax, daz] = wallDir(wa);
  const [dbx, dbz] = wallDir(wb);
  const denom = dax * dbz - daz * dbx;
  if (Math.abs(denom) < 1e-9) return false;
  const rx = wb.start[0] - wa.start[0], rz = wb.start[1] - wa.start[1];
  const s = (rx * dbz - rz * dbx) / denom;
  const u = (rx * daz - rz * dax) / denom;
  return s >= -1e-9 && s <= wallLen(wa) + 1e-9 && u >= -1e-9 && u <= wallLen(wb) + 1e-9;
}

// 两面墙指定面的公共墙面角点（面线交点）：仅当两墙几何相邻（端部交接/T 型/X 型）时返回 [x, z]，否则 null
export function wallFaceCorner(wallsById, wallA, faceA, wallB, faceB) {
  const wa = wallsById.get(wallA), wb = wallsById.get(wallB);
  if (!wa || !wb || wallA === wallB) return null;
  const hit = faceLineIntersect(wa, faceA, wb, faceB);
  if (!hit) return null;
  // 面线交点允许超出墙端：面线偏移导致的越界量 ≈ 厚度半宽 / sin(夹角)
  const offA = (wa.thickness || 0.2) / 2, offB = (wb.thickness || 0.2) / 2;
  const marginA = (offA + offB) / hit.sin + 0.01;
  const marginB = marginA;
  if (hit.s < -marginA || hit.s > wallLen(wa) + marginA) return null;
  if (hit.u < -marginB || hit.u > wallLen(wb) + marginB) return null;
  if (!wallsConnected(wa, wb)) return null;
  return [hit.qx, hit.qz];
}

// 电线 3D 路径点：同墙/不可相邻时横平竖直（水平到平面中点→垂直折角→水平到达）；
// 跨墙且几何相邻时经两面墙公共墙面角点走线（起点高度角点→终点高度角点）。
// 返回 [[x,y,z], ...]（至少 2 点）；端点缺墙等无效情况返回 null
export function wirePathPoints(wallsById, na, nb) {
  const p1 = nodeWorldPos(na, wallsById);
  const p2 = nodeWorldPos(nb, wallsById);
  if (!p1 || !p2) return null;
  const dedupe = raw => {
    const pts = [];
    for (const p of raw) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 0.01) pts.push(p);
    }
    return pts;
  };
  if (na.wall !== nb.wall) {
    const corner = wallFaceCorner(wallsById, na.wall, na.face, nb.wall, nb.face);
    if (corner) {
      const pts = dedupe([
        [p1[0], p1[1], p1[2]],
        [corner[0], p1[1], corner[1]],
        [corner[0], p2[1], corner[1]],
        [p2[0], p2[1], p2[2]],
      ]);
      if (pts.length >= 2) return pts;
    }
  }
  const mx = (p1[0] + p2[0]) / 2, mz = (p1[2] + p2[2]) / 2;
  const pts = dedupe([
    [p1[0], p1[1], p1[2]],
    [mx, p1[1], mz],
    [mx, p2[1], mz],
    [p2[0], p2[1], p2[2]],
  ]);
  return pts.length >= 2 ? pts : null;
}

// 邻墙面选择：优先按房间归属（同一空间一侧），开放/外侧面用几何方向回退
function pickNeighborFace(candWall, candSeg, room, towardDir) {
  // room：当前墙段可见侧房间 key；towardDir：显示坐标中指向段边界的单位方向
  if (room != null && candSeg) {
    if (candSeg.left === room) return 0;
    if (candSeg.right === room) return 1;
  }
  if (room == null && candSeg) {
    // 开放侧：邻墙段两侧恰一侧无房间 → 无房间面即外侧面
    const nulls = [];
    if (candSeg.left == null) nulls.push(0);
    if (candSeg.right == null) nulls.push(1);
    if (nulls.length === 1) return nulls[0];
  }
  // 几何回退：选法线沿行进方向分量最大的面（围绕 viewer 一侧绕角）
  let best = null, bestScore = -Infinity;
  for (const f of [0, 1]) {
    const [nx, nz] = wallNormal(candWall, f);
    const score = nx * towardDir[0] + nz * towardDir[1];
    if (score > bestScore + 1e-12) { bestScore = score; best = f; }
  }
  return best;
}

// 面向墙面视角（B 面 start→end 从左到右，A 面反向展开）下，当前墙段左右边界处的相邻墙面。
// 返回 { left, right }，每项为 { wallId, face, seg } 或 null；seg 为逻辑墙段快照。
// walls：墙数组；wallSegments：buildWallSegments 的结果；seg 为当前墙段快照（可带 index/t0/t1，可 null）
export function adjacentWallViews(walls, wallSegments, wallId, face, seg) {
  const empty = { left: null, right: null };
  const wall = (walls || []).find(w => w.id === wallId);
  if (!wall) return empty;
  const segs = segmentsForWall(wallSegments, wallId);
  const t0 = seg ? seg.t0 : 0;
  const t1 = seg ? seg.t1 : 1;
  const [dx, dz] = wallDir(wall);
  const endPoint = t => [wall.start[0] + (wall.end[0] - wall.start[0]) * t,
                         wall.start[1] + (wall.end[1] - wall.start[1]) * t];
  const displayDir = face === 1 ? [dx, dz] : [-dx, -dz]; // 显示坐标左→右的平面方向

  const findNeighbor = (tEnd, towardDisplay) => {
    const [px, pz] = endPoint(tEnd);
    // 该边界点所在墙段的可见侧房间 key（开放/外侧面为 null）
    const boundarySeg = segOfNode(segs, tEnd);
    const room = boundarySeg ? (face === 0 ? boundarySeg.left : boundarySeg.right) : null;
    let best = null;
    for (const cand of walls) {
      if (cand.id === wallId) continue;
      const tol = Math.max(WALL_JOIN_EPS, ((wall.thickness || 0.2) + (cand.thickness || 0.2)) / 2);
      const tc = wallParamNear(cand, px, pz, tol);
      if (tc == null) continue;
      // 转角优先：与当前墙方向偏差越大越像"转弯的邻墙"，共线延续靠后；
      // 完全同向（延长线）不算邻墙。同分取 id 较小者保证确定性
      const [cax, caz] = wallDir(cand);
      const turn = Math.abs(cax * dz - caz * dx);
      const score = turn - (cand.id < wallId ? 1e-9 : 0);
      if (turn < 1e-6) continue;
      if (!best || score > best.score) best = { cand, tc, score };
    }
    if (!best) return null;
    const candSeg = segOfNode(segmentsForWall(wallSegments, best.cand.id), best.tc);
    const candFace = pickNeighborFace(best.cand, candSeg, room,
      towardDisplay ? displayDir : [-displayDir[0], -displayDir[1]]);
    if (candFace == null) return null;
    return {
      wallId: best.cand.id,
      face: candFace,
      seg: { id: candSeg.id, wallId: candSeg.wallId, index: candSeg.index, t0: candSeg.t0, t1: candSeg.t1 },
    };
  };

  // B 面：左边界=t0、右边界=t1；A 面反向：左边界=t1、右边界=t0
  const leftT = face === 1 ? t0 : t1;
  const rightT = face === 1 ? t1 : t0;
  return {
    left: findNeighbor(leftT, false),
    right: findNeighbor(rightT, true),
  };
}

// ---------- 房间检测（平面直线图的面遍历） ----------

function vkey(p) {
  return `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[(i + 1) % pts.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

function canonicalKey(pts) {
  // 旋转到字典序最小的起点，正向/反向取较小者，形成稳定 key
  const strs = pts.map(p => vkey(p));
  let bestIdx = 0;
  for (let i = 1; i < strs.length; i++) {
    if (strs[i] < strs[bestIdx]) bestIdx = i;
  }
  const n = strs.length;
  const seqA = [], seqB = [];
  for (let i = 0; i < n; i++) {
    seqA.push(strs[(bestIdx + i) % n]);
    seqB.push(strs[(bestIdx - i + n) % n]);
  }
  const a = seqA.join('|'), b = seqB.join('|');
  return a < b ? a : b;
}

export function detectRooms(walls) {
  // 顶点集合
  const vertices = new Map(); // key -> {x, z}
  const addV = (x, z) => {
    const k = `${x.toFixed(3)},${z.toFixed(3)}`;
    if (!vertices.has(k)) vertices.set(k, { x, z, edges: [] });
    return k;
  };

  // 收集所有交点并切分墙
  const rawWalls = walls.map(w => ({ w, cuts: [0, wallLen(w)], segs: [] }));
  for (let i = 0; i < rawWalls.length; i++) {
    for (let j = i + 1; j < rawWalls.length; j++) {
      const p = segIntersect(rawWalls[i].w, rawWalls[j].w);
      if (p) {
        rawWalls[i].cuts.push(p.t1);
        rawWalls[j].cuts.push(p.t2);
      }
    }
  }

  const edgeInfos = [];
  for (const rw of rawWalls) {
    const len = wallLen(rw.w);
    const cuts = [...new Set(rw.cuts.map(c => Math.min(Math.max(c, 0), len)))].sort((a, b) => a - b);
    const [dx, dz] = wallDir(rw.w);
    for (let i = 0; i < cuts.length - 1; i++) {
      const t1 = cuts[i], t2 = cuts[i + 1];
      if (t2 - t1 < 0.001) continue;
      const p1 = [rw.w.start[0] + dx * t1, rw.w.start[1] + dz * t1];
      const p2 = [rw.w.start[0] + dx * t2, rw.w.start[1] + dz * t2];
      const k1 = addV(p1[0], p1[1]), k2 = addV(p2[0], p2[1]);
      // a→b 方向与墙 start→end 一致；t0/t1 为沿原始墙的 0~1 归一化坐标
      const info = { a: k1, b: k2, wallId: rw.w.id, t0: t1 / len, t1: t2 / len };
      edgeInfos.push(info);
      vertices.get(k1).edges.push(info);
      vertices.get(k2).edges.push(info);
    }
  }

  // 每个顶点对关联边按角度排序（逆时针）
  for (const [k, v] of vertices) {
    v.angles = v.edges.map(e => {
      const other = e.a === k ? e.b : e.a;
      const o = vertices.get(other);
      return { e, angle: Math.atan2(o.z - v.z, o.x - v.x) };
    }).sort((p, q) => p.angle - q.angle);
  }

  // 最左转面遍历
  const visited = new Set();
  const faces = [];
  const halfFace = new Map(); // 有向半边 → 面序号（记录每条半边左侧的房间面）
  for (const e of edgeInfos) {
    for (const [kFrom, kTo] of [[e.a, e.b], [e.b, e.a]]) {
      const halfKey = kFrom + '>' + kTo;
      if (visited.has(halfKey)) continue;
      const pts = [];
      const faceIdx = faces.length;
      let curFrom = kFrom, curTo = kTo;
      let guard = 0;
      while (guard++ < 5000) {
        visited.add(curFrom + '>' + curTo);
        halfFace.set(curFrom + '>' + curTo, faceIdx);
        // 在 curTo 处，从指向 curFrom 的边开始，逆时针取下一条（左转）
        const vt = vertices.get(curTo);
        const jdx = vt.angles.findIndex(a => {
          const other = a.e.a === curTo ? a.e.b : a.e.a;
          return other === curFrom;
        });
        const n = vt.angles.length;
        const next = vt.angles[(jdx + 1) % n];
        pts.push([vt.x, vt.z]);
        curFrom = curTo;
        const nextOther = next.e.a === curFrom ? next.e.b : next.e.a;
        curTo = nextOther;
        if (curFrom === kFrom && curTo === kTo) break;
      }
      if (pts.length >= 3) faces.push(pts);
    }
  }

  // 按面积过滤：去掉外平面，保留面积在一定范围内的环。
  // 注意 faceKey 必须以"面发现顺序"（faces 下标）索引——halfFace 记录的是发现序号；
  // 外平面按面积排序取最大者，但 key 数组不能按排序后下标建，否则多房间时左右归属会错位
  const areas = faces.map(f => Math.abs(polygonArea(f)));
  let exteriorIdx = 0;
  for (let i = 1; i < faces.length; i++) {
    if (areas[i] > areas[exteriorIdx]) exteriorIdx = i;
  }
  const faceKey = faces.map((f, i) => {
    if (areas[i] < 0.5 || i === exteriorIdx) return null; // 微面与外平面不算房间
    return canonicalKey(f);
  });
  const roomIdx = faces.map((f, i) => i)
    .filter(i => faceKey[i] != null)
    .sort((a, b) => areas[b] - areas[a]);
  const rooms = roomIdx.map(i => ({ pts: faces[i], area: areas[i] }));
  // 每条墙子段的 A面/B面 侧房间：半边 a→b（与墙同向）左侧是 A面侧，b→a 左侧是 B面侧
  const segRooms = new Map(); // wallId -> [{t0, t1, left, right}]
  for (const e of edgeInfos) {
    let arr = segRooms.get(e.wallId);
    if (!arr) { arr = []; segRooms.set(e.wallId, arr); }
    const left = faceKey[halfFace.get(e.a + '>' + e.b)] ?? null;
    const right = faceKey[halfFace.get(e.b + '>' + e.a)] ?? null;
    arr.push({ t0: e.t0, t1: e.t1, left, right });
  }
  return {
    rooms: rooms.map(f => ({
      key: canonicalKey(f.pts),
      points: f.pts,
      area: f.area,
    })),
    segRooms,
  };
}

function segIntersect(w1, w2) {
  const [x1, z1] = w1.start, [x2, z2] = w1.end;
  const [x3, z3] = w2.start, [x4, z4] = w2.end;
  const d = (x2 - x1) * (z4 - z3) - (z2 - z1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((x3 - x1) * (z4 - z3) - (z3 - z1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (z2 - z1) - (z3 - z1) * (x2 - x1)) / d;
  // 闭区间：墙端点落在另一墙中间（T 型连接）也要切分
  const eps = 1e-6;
  if (t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps) {
    return { t1: t * Math.hypot(x2 - x1, z2 - z1), t2: u * Math.hypot(x4 - x3, z4 - z3) };
  }
  return null;
}

// ---------- 逻辑墙段（派生拆分） ----------
// 持久化层永远保存原始整墙；墙被 T/X 交叉分到两个房间时，
// 电路编辑与 3D 预览把墙视为多面独立的"逻辑墙段"，纯派生、随几何实时重算

// 把 detectRooms 的 segRooms（每墙按切点切出的子段 + 两侧房间）合并成逻辑墙段：
// 相邻且 (left,right) 完全相同的子段合并——段边界恰好是房间归属发生变化的切点；
// 未被拆分的墙恒为单段 [0,1]。返回 Map<wallId, [{id, wallId, index, t0, t1, left, right}]>
// walls 用于换算子段米制长度：手绘 T 连接常见出头/欠头，短于墙厚的小尖段属制图误差，
// 吸收回邻居——T 型只拆宿主墙，stem 墙保持整段；真实出头（≥墙厚）仍照常拆分。
export function buildWallSegments(segRooms, walls) {
  const wallById = new Map((walls || []).map(w => [w.id, w]));
  const out = new Map();
  for (const [wallId, subs] of segRooms) {
    const wall = wallById.get(wallId);
    const minSeg = wall ? Math.max(wall.thickness || 0.2, 0.05) : Infinity;
    const len = wall ? wallLen(wall) : 1;
    const merged = [];
    for (const s of subs) {
      const last = merged[merged.length - 1];
      if (last && last.left === s.left && last.right === s.right && Math.abs(last.t1 - s.t0) < 1e-9) {
        last.t1 = s.t1;
      } else {
        merged.push({ t0: s.t0, t1: s.t1, left: s.left, right: s.right });
      }
    }
    // 吸收微小子段：端部并入唯一邻居，中间并入较长的邻居；只剩一段时不处理。
    // minSeg 为 Infinity（缺 walls）时整体跳过吸收
    let changed = true;
    while (changed && merged.length > 1) {
      changed = false;
      for (let i = 0; i < merged.length; i++) {
        if (!Number.isFinite(minSeg) || (merged[i].t1 - merged[i].t0) * len >= minSeg) continue;
        let j;
        if (i === 0) j = 1;
        else if (i === merged.length - 1) j = merged.length - 2;
        else j = (merged[i - 1].t1 - merged[i - 1].t0) >= (merged[i + 1].t1 - merged[i + 1].t0) ? i - 1 : i + 1;
        merged[j].t0 = Math.min(merged[j].t0, merged[i].t0);
        merged[j].t1 = Math.max(merged[j].t1, merged[i].t1);
        merged.splice(i, 1);
        changed = true;
        break; // 下标已变化，重新扫描（每墙切点数很少）
      }
    }
    out.set(wallId, merged.map((m, i) => ({
      id: `${wallId}#${i}`,
      wallId,
      index: i,
      t0: m.t0,
      t1: m.t1,
      left: m.left,
      right: m.right,
    })));
  }
  return out;
}

// 未出现在 segRooms 里的墙（孤立墙/无房间）补一个整墙段
export function segmentsForWall(wallSegments, wallId) {
  return wallSegments.get(wallId) || [{
    id: `${wallId}#0`, wallId, index: 0, t0: 0, t1: 1, left: null, right: null,
  }];
}

// 节点（pos 沿原始墙 0~1）所属的逻辑墙段；半开区间 [t0,t1)，末段闭区间——
// 恰落在切点上的节点归属右侧段（确定性规则）
export function segOfNode(segs, pos) {
  if (!segs || !segs.length) return null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (i === segs.length - 1) {
      if (pos >= s.t0 - 1e-9 && pos <= s.t1 + 1e-9) return s;
    } else if (pos >= s.t0 - 1e-9 && pos < s.t1 - 1e-9) {
      return s;
    }
  }
  return segs[segs.length - 1];
}

// 面范围段：把相邻的"命中面同侧房间相同"的逻辑墙段合并成一个范围。
// T/X 型拆分只作用于被接触的一面：stem 只改变接触侧的房间归属，
// 未被接触的一面沿墙房间不变 → 合并为整面范围（可整面悬停/展开）；
// X 型交叉两面房间都在交点变化 → 两面都拆。边界取 stem 中心线（与
// 逻辑段一致），落在接头覆盖条内的节点仍归属某一侧，不会失联。
// pos 为原始墙 0~1 坐标，半开区间归属与 segOfNode 一致（切点归右侧）；
// 返回段快照 {id, wallId, index, t0, t1}，无段时返回 null
export function faceSegOf(segs, face, pos) {
  if (!segs || !segs.length) return null;
  const side = face === 0 ? 'left' : 'right';
  const groups = [];
  for (const s of segs) {
    const last = groups[groups.length - 1];
    if (last && last[0][side] === s[side]) last.push(s);
    else groups.push([s]);
  }
  const t = Math.min(1, Math.max(0, pos));
  for (let g = 0; g < groups.length; g++) {
    const first = groups[g][0], lastSeg = groups[g][groups[g].length - 1];
    const inRange = g === groups.length - 1
      ? t >= first.t0 - 1e-9 && t <= lastSeg.t1 + 1e-9
      : t >= first.t0 - 1e-9 && t < lastSeg.t1 - 1e-9;
    if (inRange) {
      return { id: `${first.wallId}#${g}`, wallId: first.wallId, index: g, t0: first.t0, t1: lastSeg.t1 };
    }
  }
  // 防御：浮点间隙导致未命中时取最近的组
  let best = 0, bestD = Infinity;
  groups.forEach((grp, g) => {
    const d = t < grp[0].t0 ? grp[0].t0 - t : t > grp[grp.length - 1].t1 ? t - grp[grp.length - 1].t1 : 0;
    if (d < bestD) { bestD = d; best = g; }
  });
  const grp = groups[best];
  return { id: `${grp[0].wallId}#${best}`, wallId: grp[0].wallId, index: best, t0: grp[0].t0, t1: grp[grp.length - 1].t1 };
}

// 段内坐标换算：t（原始墙 0~1）↔ 段内 0~1
export function segLocalPos(seg, t) {
  return (t - seg.t0) / (seg.t1 - seg.t0);
}
export function segFromLocal(seg, local) {
  return seg.t0 + local * (seg.t1 - seg.t0);
}

// 段内是否有带电路的节点
export function segHasCircuit(data, circuits, seg) {
  return data.nodes.some(n =>
    n.wall === seg.wallId &&
    circuits.nodeCircuit.has(n.id) &&
    (seg.t1 - seg.t0 >= 1 - 1e-9
      ? n.pos >= 0 && n.pos <= 1
      : n.pos >= seg.t0 - 1e-9 && n.pos < seg.t1 - 1e-9));
}

export function pointInRoom(x, z, room) {
  let inside = false;
  const pts = room.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// 房间显示名：显式命名 > 按面积降序分配 roomNameHints > 兜底“房间N”。
// hint 分配会写入 data.roomNames（沿用 3D 标签的既有行为，导出 JSON 时成为显式命名）。
// 返回 Map<room.key, 显示名>，名称与 rooms 数组顺序无关（兜底序号按传入数组下标）。
export function resolveRoomNames(data, rooms) {
  const names = data.roomNames || (data.roomNames = {});
  const hints = [...(data.roomNameHints || [])];
  const sorted = [...rooms].sort((a, b) => b.area - a.area);
  for (const room of sorted) {
    if (!names[room.key] && hints.length) names[room.key] = hints.shift();
  }
  const result = new Map();
  rooms.forEach((room, i) => {
    result.set(room.key, names[room.key] || `房间${i + 1}`);
  });
  return result;
}

// ---------- 线路计算 ----------

// 返回 { circuits: [{ breakerId, label, color, wireIds:Set, nodeIds:Set, wallIds:Set }], wireCircuit: Map<wireId, idx>, nodeCircuit: Map<nodeId, idx>, wallsWithCircuit: Set<wallId> }
// 线路 = 从断路器终端节点出发，沿电线 + links（穿墙/转角连通）遍历到的连通分量
export function computeCircuits(data) {
  const parent = new Map();
  const nodesById = new Map(data.nodes.map(n => [n.id, n]));
  const find = x => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const w of data.wires) {
    union('n:' + w.from, 'n:' + w.to);
  }
  for (const l of (data.links || [])) {
    if (l && l.a && l.b) union('n:' + l.a, 'n:' + l.b);
  }

  const circuits = [];
  const wireCircuit = new Map();
  const nodeCircuit = new Map();
  const wallsWithCircuit = new Set();
  const box = findBreakerBox(data);
  if (box) {
    box.breakers.forEach((br, i) => {
      const color = CIRCUIT_COLORS[i % CIRCUIT_COLORS.length];
      const circuit = { breakerId: br.id, label: br.label, color, wireIds: new Set(), nodeIds: new Set(), wallIds: new Set() };
      const terminal = br.terminal ? 'n:' + br.terminal : null;
      if (terminal && parent.has(terminal)) {
        const root = find(terminal);
        for (const w of data.wires) {
          if (parent.has('n:' + w.from) && find('n:' + w.from) === root) {
            circuit.wireIds.add(w.id);
            circuit.nodeIds.add(w.from);
            circuit.nodeIds.add(w.to);
            wireCircuit.set(w.id, i);
          }
        }
        for (const nid of circuit.nodeIds) {
          nodeCircuit.set(nid, i);
          const node = nodesById.get(nid);
          if (node) {
            circuit.wallIds.add(node.wall);
            wallsWithCircuit.add(node.wall);
          }
        }
      }
      circuits.push(circuit);
    });
  }
  return { circuits, wireCircuit, nodeCircuit, wallsWithCircuit };
}

// 从某节点出发找的电线
export function wiresAt(data, nodeId) {
  return data.wires.filter(w => w.from === nodeId || w.to === nodeId);
}

export function validateData(data) {
  if (!data || typeof data !== 'object') return '数据不是对象';
  if (data.version !== 2) return `不支持的版本: ${data.version}`;
  if (!Array.isArray(data.walls) || !Array.isArray(data.nodes) || !Array.isArray(data.wires)) {
    return 'walls/nodes/wires 必须是数组';
  }
  // 强电箱是特殊设备节点，最多一个；尚未放置（空户型）是允许的
  const boxes = data.nodes.filter(n => n.deviceType === 'breakerBox');
  if (boxes.length > 1) return '强电箱最多一个';
  // 节点 pos 为沿原始墙的 0~1 归一化坐标
  const wallIds = new Set(data.walls.map(w => w.id));
  for (const n of data.nodes) {
    if (!wallIds.has(n.wall)) return `节点 ${n.id} 引用了不存在的墙`;
    if (!(n.pos >= 0) || !(n.pos <= 1)) return `节点 ${n.id} 的 pos 必须是 0~1 归一化坐标`;
  }
  // doors 为可选字段（旧数据没有）：存在时须为数组且 wall 引用有效
  if (data.doors != null) {
    if (!Array.isArray(data.doors)) return 'doors 必须是数组';
    const wallIds = new Set(data.walls.map(w => w.id));
    for (const d of data.doors) {
      if (!d || typeof d !== 'object' || !wallIds.has(d.wall)) return '门引用了不存在的墙';
      if (!(d.width > 0) || !(d.pos >= 0)) return '门的宽度/位置无效';
    }
  }
  return null;
}
