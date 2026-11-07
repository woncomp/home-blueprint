import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWallShell, locateWall, computeWallCells, wallRects } from '../js/wallgeometry.js';

// ---------- 构造与统计工具 ----------

function wall(id, x1, z1, x2, z2, opts = {}) {
  return {
    id,
    start: [x1, z1],
    end: [x2, z2],
    height: opts.height ?? 2.8,
    thickness: opts.thickness ?? 0.2,
  };
}

function door(id, wallId, pos, width, height = 2.0) {
  return { id, wall: wallId, pos, width, height, face: 0 };
}

function tris(shell) {
  const { positions, normals } = shell;
  const out = [];
  for (let i = 0; i < positions.length; i += 9) {
    out.push({
      v: [
        [positions[i], positions[i + 1], positions[i + 2]],
        [positions[i + 3], positions[i + 4], positions[i + 5]],
        [positions[i + 6], positions[i + 7], positions[i + 8]],
      ],
      n: [normals[i], normals[i + 1], normals[i + 2]],
    });
  }
  return out;
}

function area(t) {
  const [a, b, c] = t.v;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

const sumArea = list => list.reduce((s, t) => s + area(t), 0);

function assertClean(shell) {
  const ts = tris(shell);
  // 无退化三角形
  for (const t of ts) {
    assert.ok(area(t) > 1e-10, `degenerate triangle: ${JSON.stringify(t.v)}`);
  }
  // 法线均为单位向量
  for (const t of ts) {
    const len = Math.hypot(t.n[0], t.n[1], t.n[2]);
    assert.ok(Math.abs(len - 1) < 1e-9, `non-unit normal: ${JSON.stringify(t.n)}`);
  }
  // 无重复三角形（顶点三元组排序后哈希）
  const seen = new Set();
  for (const t of ts) {
    const key = t.v.map(p => p.map(v => v.toFixed(6)).join(',')).sort().join('|');
    assert.ok(!seen.has(key), `duplicate triangle: ${key}`);
    seen.add(key);
  }
  return ts;
}

// ---------- 单墙 ----------

test('单墙：恰好 4 侧 + 1 顶 = 10 个三角形，顶面积 = 长×厚，无贴地底面', () => {
  const w = wall('w1', 0, 0, 3, 0);
  const shell = buildWallShell([w], []);
  const ts = assertClean(shell);
  assert.equal(ts.length, 10);
  const up = ts.filter(t => t.n[1] > 0.5);
  const down = ts.filter(t => t.n[1] < -0.5);
  assert.ok(Math.abs(sumArea(up) - 3 * 0.2) < 1e-9);
  assert.equal(down.length, 0);
  const vert = ts.filter(t => Math.abs(t.n[1]) <= 0.5);
  assert.ok(Math.abs(sumArea(vert) - 2 * (3 + 0.2) * 2.8) < 1e-9);
});

// ---------- L / T / X 连接：顶面积 == 矩形并集面积（无重叠的直接证据） ----------

test('L 连接：拐角方块由并集填满，顶面积 == 并集面积', () => {
  // A: (0,0)→(3,0)，B: (0,0)→(0,2)，共享端 (0,0) → 两端各外延 0.1
  // A 矩形 3.1×0.2 = 0.62，B 矩形 2.1×0.2 = 0.42，重叠 0.2×0.2 = 0.04
  const walls = [wall('a', 0, 0, 3, 0), wall('b', 0, 0, 0, 2)];
  const shell = buildWallShell(walls, []);
  const ts = assertClean(shell);
  const up = ts.filter(t => t.n[1] > 0.5);
  assert.ok(Math.abs(sumArea(up) - 1.0) < 1e-9, `up area ${sumArea(up)} != 1.0`);
  assert.equal(ts.filter(t => t.n[1] < -0.5).length, 0);
});

test('T 连接：顶面积 == 并集面积，无内部隐藏面', () => {
  // A: (0,0)→(4,0) 自由端平齐 4×0.2 = 0.8；B: (2,-1)→(2,1) 穿过 A 2×0.2 = 0.4
  // 无外延（B 两端自由），重叠 0.2×0.2 = 0.04 → 并集 1.16
  const walls = [wall('a', 0, 0, 4, 0), wall('b', 2, -1, 2, 1)];
  const shell = buildWallShell(walls, []);
  const ts = assertClean(shell);
  const up = ts.filter(t => t.n[1] > 0.5);
  assert.ok(Math.abs(sumArea(up) - 1.16) < 1e-9, `up area ${sumArea(up)} != 1.16`);
});

test('X 十字交叉：并集面积正确、无重叠（旧实现此处两墙整体重叠）', () => {
  // A: (0,0)→(4,0) 面积 0.8；B: (1.5,-1)→(2.5,1) 长 √5，面积 0.2√5
  // 两条带交集面积 = 0.2×0.2/sinθ，sinθ = 2/√5 → 0.02√5
  const walls = [wall('a', 0, 0, 4, 0), wall('b', 1.5, -1, 2.5, 1)];
  const shell = buildWallShell(walls, []);
  const ts = assertClean(shell);
  const expected = 0.8 + 0.18 * Math.sqrt(5);
  const up = ts.filter(t => t.n[1] > 0.5);
  // 斜墙角点经 0.1mm 网格吸附，面积有 ~1e-4 量级误差（旧实现误差 0.02√5 ≈ 0.045）
  assert.ok(Math.abs(sumArea(up) - expected) < 1e-3, `up area ${sumArea(up)} != ${expected}`);
});

// ---------- 门洞 ----------

test('带门墙：门楣底面/真实门洞/门垛面积全部正确', () => {
  // 墙 (0,0)→(3,0) h=2.8 t=0.2；门 pos=1.5 w=0.9 h=2.0
  const w = wall('w1', 0, 0, 3, 0);
  const d = door('d1', 'w1', 1.5, 0.9);
  const shell = buildWallShell([w], [d]);
  const ts = assertClean(shell);

  // 门楣底面朝下：面积 == 门宽×厚
  const down = ts.filter(t => t.n[1] < -0.5);
  assert.ok(Math.abs(sumArea(down) - 0.9 * 0.2) < 1e-9, `down area ${sumArea(down)} != 0.18`);

  // A 面（face 0，法线 [dz,-dx] = (0,-1) 即 -z 侧）竖直面积 == 长×高 − 门宽×门高
  const vertA = ts.filter(t => t.n[2] < -0.5);
  assert.ok(Math.abs(sumArea(vertA) - (3 * 2.8 - 0.9 * 2.0)) < 1e-6, `face0 area ${sumArea(vertA)} != 6.6`);

  // 门垛：两面，各 厚×门高（顶不到 2.8 的 |n.x|≈1 的面才是门垛，自由端面到顶）
  const jamb = ts.filter(t => Math.abs(t.n[0]) > 0.5 && Math.max(...t.v.map(p => p[1])) <= 2.0 + 1e-6);
  assert.ok(Math.abs(sumArea(jamb) - 2 * 0.2 * 2.0) < 1e-9, `jamb area ${sumArea(jamb)} != 0.8`);

  // 顶面积不变（门楣顶盖补回门洞上方）
  const up = ts.filter(t => t.n[1] > 0.5);
  assert.ok(Math.abs(sumArea(up) - 3 * 0.2) < 1e-9);
});

// ---------- 不同墙高 ----------

test('不同高度相邻墙：产生台阶竖直面，顶盖出现在两个高度', () => {
  // A: (0,0)→(3,0) h=2.8；B: (0,0)→(0,2) h=2.2，共享端 (0,0)
  const walls = [wall('a', 0, 0, 3, 0, { height: 2.8 }), wall('b', 0, 0, 0, 2, { height: 2.2 })];
  const shell = buildWallShell(walls, []);
  const ts = assertClean(shell);

  // 台阶面：高度恰好 0.6 的竖直面（侧面高度是 2.8/2.2，据此区分），恰好一个四边形
  const riser = ts.filter(t => {
    if (Math.abs(t.n[1]) > 0.5) return false;
    const ys = t.v.map(p => p[1]);
    return Math.abs(Math.max(...ys) - Math.min(...ys) - 0.6) < 0.01;
  });
  assert.equal(riser.length, 2);
  assert.ok(Math.abs(sumArea(riser) - 0.6 * 0.2) < 1e-9);

  // 顶盖出现在 2.2 与 2.8 两个高度
  const levels = new Set(ts.filter(t => t.n[1] > 0.5).map(t => t.v[0][1].toFixed(3)));
  assert.deepEqual([...levels].sort(), ['2.200', '2.800']);

  // 顶总面积 == 并集面积 1.0（与等高 L 相同）
  const up = ts.filter(t => t.n[1] > 0.5);
  assert.ok(Math.abs(sumArea(up) - 1.0) < 1e-9);
});

// ---------- 中间产物与拾取辅助 ----------

test('computeWallCells：单墙一个实体单元；带门墙出现门楣区间单元', () => {
  const w = wall('w1', 0, 0, 3, 0);
  let cells = computeWallCells([w], []);
  assert.equal(cells.filter(c => c.y1 - c.y0 > 1e-9).length, 1);
  assert.deepEqual(cells.find(c => c.y1 - c.y0 > 1e-9).y0, 0);

  const d = door('d1', 'w1', 1.5, 0.9);
  cells = computeWallCells([w], [d]);
  const lintel = cells.find(c => c.doors.length > 0 && c.walls.length > 0);
  assert.ok(lintel, 'expected lintel cell');
  assert.ok(Math.abs(lintel.y0 - 2.0) < 1e-9);
  assert.ok(Math.abs(lintel.y1 - 2.8) < 1e-9);
});

test('wallRects：连接端外延半厚，自由端平齐', () => {
  const walls = [wall('a', 0, 0, 3, 0), wall('b', 0, 0, 0, 2)];
  const rects = wallRects(walls);
  const a = rects.find(r => r.wall.id === 'a');
  // A 面法线 n=(0,-1)：corners[0] = start + n*s，连接端外延后 x = -0.1
  assert.ok(Math.abs(a.corners[0][0] - -0.1) < 1e-9);
  assert.ok(Math.abs(a.corners[1][0] - 3) < 1e-9); // 自由端不平齐
  const single = wallRects([wall('s', 0, 0, 3, 0)])[0];
  assert.ok(Math.abs(single.corners[0][0] - 0) < 1e-9);
});

test('locateWall：按最近墙 + 命中点相对中心线侧判定 face，顶盖/门楣命中同样稳健', () => {
  const w = wall('w1', 0, 0, 3, 0);
  // face 0 = A 面 = 法线 [dz,-dx] = (0,-1) 一侧 → z < 0
  assert.deepEqual(locateWall([w], [1.5, 1.4, -0.1]).face, 0);
  assert.deepEqual(locateWall([w], [1.5, 1.4, 0.1]).face, 1);
  // 顶盖命中：y = 2.8，face 仍由俯视位置决定
  assert.deepEqual(locateWall([w], [1.5, 2.8, -0.05]).face, 0);
  // 门楣底面命中
  const d = door('d1', 'w1', 1.5, 0.9);
  const cells = computeWallCells([w], [d]);
  void cells;
  assert.equal(locateWall([w], [1.5, 2.0, 0]).wall.id, 'w1');
  // 远离墙体 / 高于墙顶 → null
  assert.equal(locateWall([w], [1.5, 1.4, 1.0]), null);
  assert.equal(locateWall([w], [1.5, 3.0, 0]), null);
  assert.equal(locateWall([], [1.5, 1.4, 0]), null);
});

test('locateWall：T 接头处按命中法向消歧——点 stem 墙面不归属宿主墙', () => {
  const host = wall('host', 0, 0, 8, 0); // 沿 x 轴
  const stem = wall('stem', 4, 0, 4, 3); // T 连接，沿 z 向下；A 面法线 [dz,-dx]/len = [1,0]
  // 命中点在 stem 墙面（+x 一侧），但距 host 中心线(0.01) 近于 stem(0.1)
  const p = [4.1, 1.4, 0.01];
  // 无法向：旧行为按最近中心线归属宿主
  assert.equal(locateWall([host, stem], p).wall.id, 'host');
  // 带命中法向：法向与宿主墙面垂直被过滤，正确归属 stem
  const loc = locateWall([host, stem], p, 0.05, [1, 0, 0]);
  assert.equal(loc.wall.id, 'stem');
  assert.equal(loc.face, 0);
  // 命中法向垂直于所有墙面（顶盖）：过滤后无幸存者，回退最近距离
  assert.equal(locateWall([host, stem], p, 0.05, [0, 1, 0]).wall.id, 'host');
});

// ---------- 组合场景（默认户型风格的闭环房间） ----------

test('闭环房间：顶面积 == 墙带并集面积，无重叠无重复面', () => {
  // 4×3 房间，四面墙，四个角共享端点
  const walls = [
    wall('s', 0, 0, 4, 0),
    wall('e', 4, 0, 4, 3),
    wall('n', 4, 3, 0, 3),
    wall('w', 0, 3, 0, 0),
  ];
  const shell = buildWallShell(walls, []);
  const ts = assertClean(shell);
  // 每面墙 4.2/3.2 长外延后…直接验证并集：外圈 4.2×3.2 − 内圈 3.8×2.8
  const expected = 4.2 * 3.2 - 3.8 * 2.8;
  const up = ts.filter(t => t.n[1] > 0.5);
  assert.ok(Math.abs(sumArea(up) - expected) < 1e-9, `up area ${sumArea(up)} != ${expected}`);
});

test('闭环房间带门：墙总面积守恒（竖直面 + 顶 + 门楣底）', () => {
  const walls = [
    wall('s', 0, 0, 4, 0),
    wall('e', 4, 0, 4, 3),
    wall('n', 4, 3, 0, 3),
    wall('w', 0, 3, 0, 0),
  ];
  const doors = [door('d1', 's', 2, 0.9)];
  const shell = buildWallShell(walls, doors);
  const ts = assertClean(shell);
  const down = ts.filter(t => t.n[1] < -0.5);
  assert.ok(Math.abs(sumArea(down) - 0.9 * 0.2) < 1e-9);
  // 门所在墙 s 的 A 面：位于 z = -0.1 平面、法线朝 -z 的竖直面
  // （s 墙长 4 两端连接 → 外延后 4.2；门洞真实挖空 0.9×2.0）
  const vertS = ts.filter(t => t.n[2] < -0.5 && t.v.every(p => Math.abs(p[2] - -0.1) < 1e-6));
  assert.ok(Math.abs(sumArea(vertS) - (4.2 * 2.8 - 0.9 * 2.0)) < 1e-6, `face0 area ${sumArea(vertS)}`);
});

test('空数据：空壳不报错', () => {
  const shell = buildWallShell([], []);
  assert.equal(shell.positions.length, 0);
  assert.equal(shell.normals.length, 0);
});
