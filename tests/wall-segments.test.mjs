import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectRooms, buildWallSegments, segmentsForWall, segOfNode,
  segLocalPos, segFromLocal, segHasCircuit, computeCircuits, wallPickableInView,
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

test('查看拾取资格：整墙有电路时，无电路的派生段仍可拾取', () => {
  // 默认户型客厅带门墙（w5 横墙）拓扑：w6 竖墙中点接入，w5 被拆成左右两段
  const walls = [
    ...square(),
    { id: 'w5', start: [0, 3.5], end: [8, 3.5], height: 2.8, thickness: 0.2 },
    { id: 'w6', start: [4, 0], end: [4, 3.5], height: 2.8, thickness: 0.2 },
  ];
  const data = {
    nodes: [
      { id: 'bb', type: 'device', deviceType: 'breakerBox', wall: 'w3', face: 1, pos: 0.5, height: 1.6, breakers: [{ id: 'br1', label: 'B1', terminal: 't1' }] },
      { id: 't1', type: 'terminal', wall: 'w3', face: 1, pos: 0.5, height: 1.6 },
      { id: 'n1', type: 'device', deviceType: 'socket', wall: 'w5', face: 1, pos: 0.9, height: 0.3 },
    ],
    wires: [{ id: 'e1', from: 't1', to: 'n1' }],
    links: [],
  };
  const circuits = computeCircuits(data);
  const w5segs = segsOf(walls, 'w5');
  const left = w5segs.find(s => s.index === 0);  // [0, 0.5)
  const right = w5segs.find(s => s.index === 1); // [0.5, 1]
  assert.equal(segHasCircuit(data, circuits, left), false);
  assert.equal(segHasCircuit(data, circuits, right), true);
  // 左段本身无电路，但原始墙 w5 有电路 → 查看模式下整墙两段都可拾取
  assert.equal(wallPickableInView(data, circuits, left.wallId), true);
  assert.equal(wallPickableInView(data, circuits, right.wallId), true);
});

test('查看拾取资格：完全无电路且不是强电箱所在墙的墙不可拾取', () => {
  const data = {
    nodes: [
      { id: 'bb', type: 'device', deviceType: 'breakerBox', wall: 'w3', face: 1, pos: 0.5, height: 1.6, breakers: [{ id: 'br1', label: 'B1', terminal: 't1' }] },
      { id: 't1', type: 'terminal', wall: 'w3', face: 1, pos: 0.5, height: 1.6 },
      { id: 'n1', type: 'device', deviceType: 'socket', wall: 'w3', face: 1, pos: 0.75, height: 0.3 },
    ],
    wires: [{ id: 'e1', from: 't1', to: 'n1' }],
    links: [],
  };
  const circuits = computeCircuits(data);
  assert.equal(wallPickableInView(data, circuits, 'w3'), true);
  assert.equal(wallPickableInView(data, circuits, 'w1'), false);
  assert.equal(wallPickableInView(data, circuits, 'nope'), false);
});

test('查看拾取资格：强电箱所在墙整体豁免（即使该墙本身无电路）', () => {
  const data = {
    nodes: [
      { id: 'bb', type: 'device', deviceType: 'breakerBox', wall: 'w1', face: 0, pos: 0.25, height: 1.6, breakers: [] },
    ],
    wires: [],
    links: [],
  };
  const circuits = computeCircuits(data);
  assert.equal(circuits.wallsWithCircuit.size, 0);
  assert.equal(wallPickableInView(data, circuits, 'w1'), true);
  assert.equal(wallPickableInView(data, circuits, 'w2'), false);
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
