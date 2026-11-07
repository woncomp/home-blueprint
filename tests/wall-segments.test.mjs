import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectRooms, buildWallSegments, segmentsForWall, segOfNode, faceSegOf,
  segLocalPos, segFromLocal, segHasCircuit, computeCircuits,
  normalizeData, validateData, nodeWorldPos,
} from '../js/model.js';
import { WallFaceDialog } from '../js/wallface.js';

// 8×6 外圈
function square() {
  return [
    { id: 'w1', start: [0, 0], end: [8, 0], height: 2.8, thickness: 0.2 },
    { id: 'w2', start: [8, 0], end: [8, 6], height: 2.8, thickness: 0.2 },
    { id: 'w3', start: [8, 6], end: [0, 6], height: 2.8, thickness: 0.2 },
    { id: 'w4', start: [0, 6], end: [0, 0], height: 2.8, thickness: 0.2 },
  ];
}

function segsOf(walls, wallId) {
  const { segRooms } = detectRooms(walls);
  return segmentsForWall(buildWallSegments(segRooms, walls), wallId);
}

test('T 型贯通隔墙：宿主墙拆成两段，段边界在切点', () => {
  const walls = [...square(), { id: 'w5', start: [4, 0], end: [4, 6], height: 2.8, thickness: 0.2 }];
  const { rooms } = detectRooms(walls);
  assert.equal(rooms.length, 2);

  const w1 = segsOf(walls, 'w1');
  assert.equal(w1.length, 2);
  assert.ok(Math.abs(w1[0].t0 - 0) < 1e-9 && Math.abs(w1[0].t1 - 0.5) < 1e-9);
  assert.ok(Math.abs(w1[1].t0 - 0.5) < 1e-9 && Math.abs(w1[1].t1 - 1) < 1e-9);
  assert.equal(w1[0].id, 'w1#0');
  assert.equal(w1[1].id, 'w1#1');
  // 两段 B 面侧分属不同房间（w1 的 A 面朝外，left 为 null）
  assert.equal(w1[0].left, null);
  assert.notEqual(w1[0].right, w1[1].right);

  const w3 = segsOf(walls, 'w3');
  assert.equal(w3.length, 2);
  assert.ok(Math.abs(w3[0].t1 - 0.5) < 1e-9);

  // 隔墙自身两侧都是房间，但整段房间归属一致 → 不拆
  const w5 = segsOf(walls, 'w5');
  assert.equal(w5.length, 1);
  assert.ok(Math.abs(w5[0].t0 - 0) < 1e-9 && Math.abs(w5[0].t1 - 1) < 1e-9);
});

test('T 型 stem 两端出头 1cm：小尖段短于墙厚被吸收，stem 保持整段', () => {
  const walls = [...square(), { id: 'w5', start: [4, -0.01], end: [4, 6.01], height: 2.8, thickness: 0.2 }];
  const w5 = segsOf(walls, 'w5');
  assert.equal(w5.length, 1);
  assert.ok(Math.abs(w5[0].t0 - 0) < 1e-9 && Math.abs(w5[0].t1 - 1) < 1e-9);
  // 宿主墙仍按房间归属拆分
  const w1 = segsOf(walls, 'w1');
  assert.equal(w1.length, 2);
  assert.ok(Math.abs(w1[0].t1 - 0.5) < 1e-9);
});

test('T 型 stem 单端出头 1cm：stem 不拆，宿主在切点拆分', () => {
  const walls = [...square(), { id: 'w5', start: [4, 0], end: [4, 6.01], height: 2.8, thickness: 0.2 }];
  assert.equal(segsOf(walls, 'w5').length, 1);
  const w3 = segsOf(walls, 'w3');
  assert.equal(w3.length, 2);
  assert.ok(Math.abs(w3[0].t1 - 0.5) < 1e-9);
});

test('T 型 stem 出头 0.5m（≥墙厚）：真实可见墙段，stem 保持拆分', () => {
  const walls = [...square(), { id: 'w5', start: [4, -0.5], end: [4, 6], height: 2.8, thickness: 0.2 }];
  const w5 = segsOf(walls, 'w5');
  assert.equal(w5.length, 2);
  // 段边界在越墙切点 0.5 / 6.5
  assert.ok(Math.abs(w5[0].t1 - 0.5 / 6.5) < 1e-9);
  assert.ok(Math.abs(w5[1].t0 - 0.5 / 6.5) < 1e-9);
});

test('死端短墙：两侧房间不变，不拆分', () => {
  const walls = [...square(), { id: 'stub', start: [2, 0], end: [2, 2], height: 2.8, thickness: 0.2 }];
  const { rooms } = detectRooms(walls);
  assert.equal(rooms.length, 1);

  assert.equal(segsOf(walls, 'stub').length, 1);
  // T 点两侧子段 (left,right) 相同 → 宿主墙也不拆
  assert.equal(segsOf(walls, 'w1').length, 1);
});

test('X 型交叉：两墙都在交点拆分', () => {
  const walls = [
    ...square(),
    { id: 'w5', start: [4, 0], end: [4, 6], height: 2.8, thickness: 0.2 },
    { id: 'w6', start: [0, 3], end: [8, 3], height: 2.8, thickness: 0.2 },
  ];
  const { rooms } = detectRooms(walls);
  assert.equal(rooms.length, 4);

  for (const id of ['w1', 'w3', 'w5', 'w6']) {
    const segs = segsOf(walls, id);
    assert.equal(segs.length, 2, `${id} 应拆成两段`);
    assert.ok(Math.abs(segs[0].t1 - 0.5) < 1e-9 && Math.abs(segs[1].t0 - 0.5) < 1e-9, `${id} 段边界应在 0.5`);
  }
});

test('删除隔断墙：逻辑段自动合并回整墙', () => {
  const withDivider = [...square(), { id: 'w5', start: [4, 0], end: [4, 6], height: 2.8, thickness: 0.2 }];
  assert.equal(segsOf(withDivider, 'w1').length, 2);
  // 模拟删除隔断墙后重算（派生计算，无数据转换）
  assert.equal(segsOf(square(), 'w1').length, 1);
});

test('拖动重新分房后拆分会随之变化（纯派生，重算即可）', () => {
  const walls = [...square(), { id: 'w5', start: [4, 0], end: [4, 6], height: 2.8, thickness: 0.2 }];
  const before = segsOf(walls, 'w1');
  assert.ok(Math.abs(before[0].t1 - 0.5) < 1e-9);
  // 把隔墙从 x=4 拖到 x=2
  walls[4].start = [2, 0];
  walls[4].end = [2, 6];
  const after = segsOf(walls, 'w1');
  assert.equal(after.length, 2);
  assert.ok(Math.abs(after[0].t1 - 0.25) < 1e-9, `段边界应随切点移动到 0.25，实际 ${after[0].t1}`);
});

test('节点→段归属：半开区间，恰在切点上的节点归右侧段', () => {
  const walls = [
    ...square(),
    { id: 'w5', start: [4, 0], end: [4, 6], height: 2.8, thickness: 0.2 },
    { id: 'w6', start: [0, 3], end: [8, 3], height: 2.8, thickness: 0.2 },
  ];
  const segs = segsOf(walls, 'w1');
  assert.equal(segOfNode(segs, 0.2).id, 'w1#0');
  assert.equal(segOfNode(segs, 0.5).id, 'w1#1'); // 切点归右侧段
  assert.equal(segOfNode(segs, 0.9999).id, 'w1#1');
  assert.equal(segOfNode(segs, 1).id, 'w1#1'); // 末段闭区间
});

test('段内坐标换算：local ↔ 整墙 t01 互逆', () => {
  const seg = { id: 'w9#1', wallId: 'w9', index: 1, t0: 0.5, t1: 1 };
  assert.ok(Math.abs(segLocalPos(seg, 0.75) - 0.5) < 1e-12);
  assert.ok(Math.abs(segFromLocal(seg, 0.5) - 0.75) < 1e-12);
  assert.ok(Math.abs(segFromLocal(seg, segLocalPos(seg, 0.9)) - 0.9) < 1e-12);
  const seg0 = { id: 'w9#0', wallId: 'w9', index: 0, t0: 0, t1: 0.5 };
  assert.ok(Math.abs(segLocalPos(seg0, 0.25) - 0.5) < 1e-12);
});

test('段电路判断：只统计落在段范围内的节点', () => {
  const walls = [...square(), { id: 'w5', start: [4, 0], end: [4, 6], height: 2.8, thickness: 0.2 }];
  const data = {
    nodes: [
      { id: 'bb', type: 'device', deviceType: 'breakerBox', wall: 'w1', face: 0, pos: 0.25, height: 1.6, breakers: [{ id: 'br1', label: 'B1', terminal: 't1' }] },
      { id: 't1', type: 'terminal', wall: 'w1', face: 0, pos: 0.25, height: 1.6 },
      { id: 'n1', type: 'device', deviceType: 'socket', wall: 'w1', face: 0, pos: 0.75, height: 0.3 },
    ],
    wires: [{ id: 'e1', from: 't1', to: 'n1' }],
    links: [],
  };
  const circuits = computeCircuits(data);
  const segs = segsOf(walls, 'w1');
  const left = segs.find(s => s.index === 0);   // [0, 0.5)
  const right = segs.find(s => s.index === 1);  // [0.5, 1]
  assert.equal(segHasCircuit(data, circuits, left), true);  // bb + t1 在左段
  assert.equal(segHasCircuit(data, circuits, right), true); // n1 在右段
  const far = { ...left, t0: 0.55, t1: 0.6 };
  assert.equal(segHasCircuit(data, circuits, far), false);
});

test('v1（米制 pos）→ v2 迁移：除以墙长、clamp、4 位小数', () => {
  const data = {
    version: 1,
    walls: [
      { id: 'a', start: [0, 0], end: [4, 0], height: 2.8, thickness: 0.2 },
      { id: 'b', start: [0, 0], end: [0, 10], height: 2.8, thickness: 0.2 },
    ],
    nodes: [
      { id: 'n1', type: 'device', deviceType: 'socket', wall: 'a', face: 0, pos: 1, height: 0.3 },
      { id: 'n2', type: 'turn', wall: 'a', face: 0, pos: 3, height: 1.2 },
      { id: 'n3', type: 'device', deviceType: 'light', wall: 'b', face: 1, pos: 5, height: 2.4 },
    ],
    wires: [],
    links: [],
  };
  normalizeData(data);
  assert.equal(data.version, 2);
  assert.equal(data.nodes.find(n => n.id === 'n1').pos, 0.25);
  assert.equal(data.nodes.find(n => n.id === 'n2').pos, 0.75);
  assert.equal(data.nodes.find(n => n.id === 'n3').pos, 0.5);
  // 迁移后世界坐标不变
  const byId = new Map(data.walls.map(w => [w.id, w]));
  assert.deepEqual(nodeWorldPos(data.nodes[0], byId), [1, 0.3, -0.1]);
  assert.equal(validateData(data), null);
});

test('validateData：v2 要求 pos∈[0,1]，门仍是米数', () => {
  const base = {
    version: 2,
    walls: [{ id: 'a', start: [0, 0], end: [4, 0], height: 2.8, thickness: 0.2 }],
    nodes: [],
    wires: [],
    links: [],
    doors: [{ id: 'd1', wall: 'a', pos: 2, width: 0.9, face: 0, height: 2.0 }],
  };
  assert.equal(validateData(base), null);
  assert.ok(validateData({ ...base, version: 1 }));
  assert.ok(validateData({
    ...base,
    nodes: [{ id: 'x', type: 'turn', wall: 'a', face: 0, pos: 1.5, height: 1 }],
  }));
  assert.ok(validateData({
    ...base,
    nodes: [{ id: 'x', type: 'turn', wall: 'a', face: 0, pos: -0.1, height: 1 }],
  }));
});

test('面范围段：T 型只拆被接触的一面，自由面整墙一个范围', () => {
  // 默认户型拓扑：客厅带门横墙 w5（0,3.5→8,3.5），竖墙 w6 从南侧（卧室侧）接入
  const walls = [
    ...square(),
    { id: 'w5', start: [0, 3.5], end: [8, 3.5], height: 2.8, thickness: 0.2 },
    { id: 'w6', start: [4, 0], end: [4, 3.5], height: 2.8, thickness: 0.2 },
  ];
  const w5segs = segsOf(walls, 'w5');
  assert.equal(w5segs.length, 2);
  // 客厅侧（B 面，未被 w6 接触）：沿墙房间不变 → 整面一个范围
  const living = faceSegOf(w5segs, 1, 0.25);
  assert.ok(Math.abs(living.t0 - 0) < 1e-9 && Math.abs(living.t1 - 1) < 1e-9);
  // 卧室侧（A 面，被 w6 接触）：房间在接入点变化 → 两段，边界在 stem 中心线
  const bedL = faceSegOf(w5segs, 0, 0.25);
  const bedR = faceSegOf(w5segs, 0, 0.75);
  assert.ok(Math.abs(bedL.t0 - 0) < 1e-9 && Math.abs(bedL.t1 - 0.5) < 1e-9);
  assert.ok(Math.abs(bedR.t0 - 0.5) < 1e-9 && Math.abs(bedR.t1 - 1) < 1e-9);
  assert.equal(bedR.index, 1);
  // 切点归右侧（与 segOfNode 一致）
  assert.equal(faceSegOf(w5segs, 0, 0.5).index, 1);
  // stem 墙两面都保持整段
  const w6segs = segsOf(walls, 'w6');
  for (const face of [0, 1]) {
    const s = faceSegOf(w6segs, face, 0.5);
    assert.ok(Math.abs(s.t0 - 0) < 1e-9 && Math.abs(s.t1 - 1) < 1e-9);
  }
  // 外墙 w1：w6 起点落在其墙身 → 室内侧拆分，外侧（自由面）整墙
  const w1segs = segsOf(walls, 'w1');
  const outer = faceSegOf(w1segs, 0, 0.75);
  assert.ok(Math.abs(outer.t0 - 0) < 1e-9 && Math.abs(outer.t1 - 1) < 1e-9);
  assert.ok(Math.abs(faceSegOf(w1segs, 1, 0.25).t1 - 0.5) < 1e-9);
});

test('面范围段：X 型交叉两面都在交点拆分', () => {
  const walls = [
    ...square(),
    { id: 'w5', start: [4, 0], end: [4, 6], height: 2.8, thickness: 0.2 },
    { id: 'w6', start: [0, 3], end: [8, 3], height: 2.8, thickness: 0.2 },
  ];
  const w5segs = segsOf(walls, 'w5');
  assert.equal(w5segs.length, 2);
  for (const face of [0, 1]) {
    const left = faceSegOf(w5segs, face, 0.25);
    const right = faceSegOf(w5segs, face, 0.75);
    assert.ok(Math.abs(left.t1 - 0.5) < 1e-9, `face ${face} 左段应止于交点`);
    assert.ok(Math.abs(right.t0 - 0.5) < 1e-9, `face ${face} 右段应起于交点`);
  }
});

test('面范围段：死端短墙不改变房间归属，宿主两面都整墙', () => {
  const walls = [...square(), { id: 'stub', start: [2, 0], end: [2, 2], height: 2.8, thickness: 0.2 }];
  const w1segs = segsOf(walls, 'w1');
  assert.equal(w1segs.length, 1);
  for (const face of [0, 1]) {
    const s = faceSegOf(w1segs, face, 0.4);
    assert.ok(Math.abs(s.t0 - 0) < 1e-9 && Math.abs(s.t1 - 1) < 1e-9);
  }
});

test('面范围段：同侧房间相同的相邻段合并，异侧保留；空段返回 null', () => {
  const segs = [
    { id: 'x#0', wallId: 'x', index: 0, t0: 0, t1: 0.4, left: 'R1', right: 'R2' },
    { id: 'x#1', wallId: 'x', index: 1, t0: 0.4, t1: 0.7, left: 'R1', right: 'R3' },
    { id: 'x#2', wallId: 'x', index: 2, t0: 0.7, t1: 1, left: 'R4', right: 'R3' },
  ];
  // A 面 left：R1|R1|R4 → [0,0.7] + [0.7,1]
  const a0 = faceSegOf(segs, 0, 0.5);
  assert.ok(Math.abs(a0.t0 - 0) < 1e-9 && Math.abs(a0.t1 - 0.7) < 1e-9 && a0.index === 0);
  const a1 = faceSegOf(segs, 0, 0.85);
  assert.ok(Math.abs(a1.t0 - 0.7) < 1e-9 && Math.abs(a1.t1 - 1) < 1e-9 && a1.index === 1);
  // B 面 right：R2|R3|R3 → [0,0.4] + [0.4,1]；切点归右
  const b0 = faceSegOf(segs, 1, 0.2);
  assert.ok(Math.abs(b0.t1 - 0.4) < 1e-9 && b0.index === 0);
  const b1 = faceSegOf(segs, 1, 0.4);
  assert.ok(Math.abs(b1.t0 - 0.4) < 1e-9 && Math.abs(b1.t1 - 1) < 1e-9 && b1.index === 1);
  // 外侧面（null 房间）同样合并
  const outer = [
    { id: 'y#0', wallId: 'y', index: 0, t0: 0, t1: 0.5, left: null, right: 'A' },
    { id: 'y#1', wallId: 'y', index: 1, t0: 0.5, t1: 1, left: null, right: 'B' },
  ];
  const whole = faceSegOf(outer, 0, 0.9);
  assert.ok(Math.abs(whole.t0 - 0) < 1e-9 && Math.abs(whole.t1 - 1) < 1e-9);
  // pos 超界 clamp；空段 null
  assert.ok(Math.abs(faceSegOf(segs, 0, 2).t1 - 1) < 1e-9);
  assert.equal(faceSegOf([], 0, 0.5), null);
  assert.equal(faceSegOf(null, 0, 0.5), null);
});

test('wallface：open 带段参数时只显示该段内的节点，段内米制映射正确', () => {
  const data = {
    walls: [{ id: 'w1', start: [0, 0], end: [8, 0], height: 2.8, thickness: 0.2 }],
    nodes: [
      { id: 'a', wall: 'w1', face: 0, pos: 0.25, height: 1 },   // 段 0（[0,0.5)）
      { id: 'b', wall: 'w1', face: 0, pos: 0.5, height: 1 },    // 恰在切点 → 段 1
      { id: 'c', wall: 'w1', face: 0, pos: 0.75, height: 1 },   // 段 1
      { id: 'd', wall: 'w1', face: 1, pos: 0.25, height: 1 },   // 另一面
    ],
  };
  const seg1 = { id: 'w1#1', wallId: 'w1', index: 1, t0: 0.5, t1: 1 };
  let renderedNodes;
  const dialog = Object.assign(Object.create(WallFaceDialog.prototype), {
    dialog: { classList: { remove() {} } },
    selectedNodeId: null,
    selectedWireId: null,
    dragging: null,
    setTool(tool) { this.tool = tool; },
    render() { renderedNodes = this.nodesOnFace(); },
  });
  dialog.open(data, 'w1', 0, 'edit', seg1);

  assert.deepEqual(renderedNodes.map(n => n.id), ['b', 'c']);
  // 段 1 长 0.5 × 8m = 4m；pos=0.75 → 段内 (0.75-0.5)*8 = 2m
  assert.ok(Math.abs(dialog.localOf(data.nodes[2]) - 2) < 1e-9);
  // 写回：段内 2m → t01 0.75
  assert.ok(Math.abs(dialog.tOf(2) - 0.75) < 1e-9);
  // 整墙打开（seg=null）时该面全部可见
  dialog.open(data, 'w1', 0, 'edit', null);
  assert.deepEqual(renderedNodes.map(n => n.id), ['a', 'b', 'c']);
});
