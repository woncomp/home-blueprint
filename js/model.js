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

let idCounter = 1;
export function genId(prefix) {
  return `${prefix}${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

export function createEmptyData() {
  return {
    version: 1,
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
      data.nodes.push(createBreakerBox(first.id, 1, Math.round((wallLen(first) / 2) * 100) / 100));
    } else if (!data.walls.some(w => w.id === box.wall)) {
      box.wall = first.id;
      box.face = 1;
      box.pos = Math.round((wallLen(first) / 2) * 100) / 100;
    }
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

// 节点在世界坐标中的位置（墙面上的点）
export function nodeWorldPos(node, wallsById) {
  const wall = wallsById.get(node.wall);
  if (!wall) return null;
  const [dx, dz] = wallDir(wall);
  const off = (wall.thickness || 0.2) / 2;
  const [nx, nz] = wallNormal(wall, node.face);
  return [
    wall.start[0] + dx * node.pos + nx * off,
    node.height,
    wall.start[1] + dz * node.pos + nz * off,
  ];
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
      const info = { a: k1, b: k2 };
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
  for (const e of edgeInfos) {
    for (const [kFrom, kTo] of [[e.a, e.b], [e.b, e.a]]) {
      const halfKey = kFrom + '>' + kTo;
      if (visited.has(halfKey)) continue;
      const pts = [];
      let curFrom = kFrom, curTo = kTo;
      let guard = 0;
      while (guard++ < 5000) {
        visited.add(curFrom + '>' + curTo);
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

  // 按面积过滤：去掉外平面，保留面积在一定范围内的环
  const withArea = faces.map(f => ({ pts: f, area: Math.abs(polygonArea(f)) }));
  withArea.sort((a, b) => b.area - a.area);
  const rooms = [];
  for (let i = 0; i < withArea.length; i++) {
    const f = withArea[i];
    if (f.area < 0.5) continue;
    // 外平面包含所有点；如果一个环的所有顶点都落在某个更大环内且贴边，则跳过
    let isOuter = i === 0;
    if (!isOuter) rooms.push(f);
  }
  return rooms.map((f, i) => ({
    key: canonicalKey(f.pts),
    points: f.pts,
    area: Math.abs(polygonArea(f.pts)),
  }));
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

export function pointInRoom(x, z, room) {
  let inside = false;
  const pts = room.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
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
  if (data.version !== 1) return `不支持的版本: ${data.version}`;
  if (!Array.isArray(data.walls) || !Array.isArray(data.nodes) || !Array.isArray(data.wires)) {
    return 'walls/nodes/wires 必须是数组';
  }
  // 强电箱是特殊设备节点，最多一个；尚未放置（空户型）是允许的
  const boxes = data.nodes.filter(n => n.deviceType === 'breakerBox');
  if (boxes.length > 1) return '强电箱最多一个';
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
