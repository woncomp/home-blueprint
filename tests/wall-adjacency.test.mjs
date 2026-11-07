import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectRooms, buildWallSegments, segmentsForWall,
  adjacentWallViews, wallFaceCorner, wirePathPoints,
} from '../js/model.js';
import { WallFaceDialog } from '../js/wallface.js';

// 默认户型拓扑：8×6 外圈 + 中间横墙 w5 + 竖墙 w6（T 型）
function floorplan() {
  return [
    { id: 'w1', start: [0, 0], end: [8, 0], height: 2.8, thickness: 0.2 },
    { id: 'w2', start: [8, 0], end: [8, 6], height: 2.8, thickness: 0.2 },
    { id: 'w3', start: [8, 6], end: [0, 6], height: 2.8, thickness: 0.2 },
    { id: 'w4', start: [0, 6], end: [0, 0], height: 2.8, thickness: 0.2 },
    { id: 'w5', start: [0, 3.5], end: [8, 3.5], height: 2.8, thickness: 0.2 },
    { id: 'w6', start: [4, 0], end: [4, 3.5], height: 2.8, thickness: 0.2 },
  ];
}

function segsMap(walls) {
  const { segRooms } = detectRooms(walls);
  return buildWallSegments(segRooms, walls);
}

test('相邻墙面：w3 B 面（客厅侧）左邻 w2、右邻 w4，均为室内面', () => {
  const walls = floorplan();
  const adj = adjacentWallViews(walls, segsMap(walls), 'w3', 1, null);
  assert.equal(adj.left.wallId, 'w2');
  assert.equal(adj.left.face, 1);
  assert.equal(adj.right.wallId, 'w4');
  assert.equal(adj.right.face, 1);
});

test('相邻墙面：w4 B 面左邻 w3、右邻 w1', () => {
  const walls = floorplan();
  const adj = adjacentWallViews(walls, segsMap(walls), 'w4', 1, null);
  assert.equal(adj.left.wallId, 'w3');
  assert.equal(adj.left.face, 1);
  assert.equal(adj.right.wallId, 'w1');
  assert.equal(adj.right.face, 1);
});

test('相邻墙面：w1 B 面（卧室侧）左邻 w4、右邻 w2（w2 需 B 面才朝室内）', () => {
  const walls = floorplan();
  const adj = adjacentWallViews(walls, segsMap(walls), 'w1', 1, null);
  assert.equal(adj.left.wallId, 'w4');
  assert.equal(adj.left.face, 1);
  assert.equal(adj.right.wallId, 'w2');
  assert.equal(adj.right.face, 1); // w2 的 B 面 (-x) 朝室内
});

test('相邻墙面：外侧面（A 面）回退到几何规则，选择外表面', () => {
  const walls = floorplan();
  const adj = adjacentWallViews(walls, segsMap(walls), 'w3', 0, null);
  assert.equal(adj.left.wallId, 'w4');
  assert.equal(adj.left.face, 0); // w4 A 面 (-x) 朝外
  assert.equal(adj.right.wallId, 'w2');
  assert.equal(adj.right.face, 0); // w2 A 面 (+x) 朝外
});

test('相邻墙面：T 型端点（w6 底端接 w1）能找到宿主墙', () => {
  const walls = floorplan();
  const adj = adjacentWallViews(walls, segsMap(walls), 'w6', 1, null);
  // w6 (4,0)-(4,3.5) B 面 (+x) 朝卧室B；底端 (4,0) 在 w1 墙身上
  assert.equal(adj.left.wallId, 'w1');
  // w1 在 x=4 处被 w6 拆段，应取包含 t=0.5 的段（半开区间归右侧）
  assert.equal(adj.left.seg.index, 1);
  // 顶端 (4,3.5) 接 w5 墙身
  assert.equal(adj.right.wallId, 'w5');
});

test('相邻墙面：带逻辑段参数时按段边界找邻墙', () => {
  const walls = floorplan();
  const wsegs = segsMap(walls);
  const w1segs = segmentsForWall(wsegs, 'w1');
  const seg0 = { id: 'w1#0', wallId: 'w1', index: 0, t0: 0, t1: 0.5 };
  const adj = adjacentWallViews(walls, wsegs, 'w1', 1, seg0);
  assert.equal(adj.left.wallId, 'w4');
  assert.equal(adj.right.wallId, 'w6'); // 段右边界在 (4,0)，T 型接 w6
  assert.equal(adj.right.seg.index, 0);
  assert.ok(w1segs.length >= 1);
});

test('相邻墙面：孤立墙没有邻居', () => {
  const walls = [{ id: 'lonely', start: [0, 0], end: [4, 0], height: 2.8, thickness: 0.2 }];
  const adj = adjacentWallViews(walls, segsMap(walls), 'lonely', 1, null);
  assert.equal(adj.left, null);
  assert.equal(adj.right, null);
});

test('墙面角点：w3/w4 内角（面线交点在房间内侧）', () => {
  const walls = floorplan();
  const byId = new Map(walls.map(w => [w.id, w]));
  // w3 B 面线 z=5.9，w4 B 面线 x=0.1 → 交点 (0.1, 5.9)
  const c = wallFaceCorner(byId, 'w3', 1, 'w4', 1);
  assert.ok(Math.abs(c[0] - 0.1) < 1e-9);
  assert.ok(Math.abs(c[1] - 5.9) < 1e-9);
});

test('墙面角点：w3/w4 外角（面线交点在建筑外侧）', () => {
  const walls = floorplan();
  const byId = new Map(walls.map(w => [w.id, w]));
  // w3 A 面线 z=6.1，w4 A 面线 x=-0.1 → 交点 (-0.1, 6.1)
  const c = wallFaceCorner(byId, 'w3', 0, 'w4', 0);
  assert.ok(Math.abs(c[0] + 0.1) < 1e-9);
  assert.ok(Math.abs(c[1] - 6.1) < 1e-9);
});

test('墙面角点：T 型（w6 顶端接 w5）交点允许面线偏移越界', () => {
  const walls = floorplan();
  const byId = new Map(walls.map(w => [w.id, w]));
  // w5 B 面线 z=3.6（+z 侧为下半空间），w6 A 面线 x=4.1 → 交点 (4.1, 3.6)
  const c = wallFaceCorner(byId, 'w6', 0, 'w5', 1);
  assert.ok(Math.abs(c[0] - 4.1) < 1e-9);
  assert.ok(Math.abs(c[1] - 3.6) < 1e-9);
});

test('墙面角点：不同墙厚按各自半厚偏移', () => {
  const walls = [
    { id: 'a', start: [0, 0], end: [8, 0], height: 2.8, thickness: 0.3 },
    { id: 'b', start: [8, 0], end: [8, 6], height: 2.8, thickness: 0.1 },
  ];
  const byId = new Map(walls.map(w => [w.id, w]));
  // a B 面线 z=+0.15，b B 面线 x=8-0.05 → 交点 (7.95, 0.15)
  const c = wallFaceCorner(byId, 'a', 1, 'b', 1);
  assert.ok(Math.abs(c[0] - 7.95) < 1e-9);
  assert.ok(Math.abs(c[1] - 0.15) < 1e-9);
});

test('墙面角点：平行墙、同墙、互不相连的墙返回 null', () => {
  const walls = [
    { id: 'a', start: [0, 0], end: [8, 0], height: 2.8, thickness: 0.2 },
    { id: 'b', start: [0, 2], end: [8, 2], height: 2.8, thickness: 0.2 }, // 平行
    { id: 'c', start: [20, 0], end: [20, 6], height: 2.8, thickness: 0.2 }, // 不相连
  ];
  const byId = new Map(walls.map(w => [w.id, w]));
  assert.equal(wallFaceCorner(byId, 'a', 1, 'b', 1), null);
  assert.equal(wallFaceCorner(byId, 'a', 1, 'a', 0), null);
  assert.equal(wallFaceCorner(byId, 'a', 1, 'c', 0), null);
});

test('3D 路径：同墙电线保持横平竖直（中点垂直折角）', () => {
  const walls = floorplan();
  const byId = new Map(walls.map(w => [w.id, w]));
  const pts = wirePathPoints(byId,
    { wall: 'w3', face: 1, pos: 0.5, height: 0.3 },
    { wall: 'w3', face: 1, pos: 0.75, height: 1.3 });
  // w3 (8,6)-(0,6) B 面 z=5.9：pos 0.5→x=4，pos 0.75→x=2
  assert.deepEqual(pts, [[4, 0.3, 5.9], [3, 0.3, 5.9], [3, 1.3, 5.9], [2, 1.3, 5.9]]);
});

test('3D 路径：相邻跨墙电线经公共墙面角点（水平段在各自墙面）', () => {
  const walls = floorplan();
  const byId = new Map(walls.map(w => [w.id, w]));
  const pts = wirePathPoints(byId,
    { wall: 'w3', face: 1, pos: 0.875, height: 0.3 },  // x=1
    { wall: 'w4', face: 1, pos: 0.25, height: 1.3 });  // z=4.5
  // 内角 (0.1, 5.9)：起点 → 起点高度角点 → 终点高度角点 → 终点
  const expected = [
    [1, 0.3, 5.9],
    [0.1, 0.3, 5.9],
    [0.1, 1.3, 5.9],
    [0.1, 1.3, 4.5],
  ];
  assert.equal(pts.length, expected.length);
  for (let i = 0; i < pts.length; i++) {
    for (let j = 0; j < 3; j++) assert.ok(Math.abs(pts[i][j] - expected[i][j]) < 1e-9, `pts[${i}][${j}]=${pts[i][j]}`);
  }
  // 水平段确实贴在两面墙上（z=5.9 / x=0.1），竖直段沿公共拐角 x=0.1,z=5.9
  assert.ok(Math.abs(pts[0][2] - 5.9) < 1e-9 && Math.abs(pts[1][2] - 5.9) < 1e-9);
  assert.ok(Math.abs(pts[2][0] - 0.1) < 1e-9 && Math.abs(pts[3][0] - 0.1) < 1e-9);
  assert.ok(Math.abs(pts[1][0] - pts[2][0]) < 1e-9 && Math.abs(pts[1][2] - pts[2][2]) < 1e-9);
});

test('3D 路径：不相邻跨墙电线回退横平竖直路径', () => {
  const walls = floorplan();
  const byId = new Map(walls.map(w => [w.id, w]));
  // w1 与 w3 平行不相连
  const pts = wirePathPoints(byId,
    { wall: 'w1', face: 1, pos: 0.5, height: 0.3 },
    { wall: 'w3', face: 1, pos: 0.5, height: 0.3 });
  assert.deepEqual(pts, [[4, 0.3, 0.1], [4, 0.3, 3], [4, 0.3, 3], [4, 0.3, 5.9]].filter(
    (p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1], p[2] - arr[i - 1][2]) > 0.01,
  ));
});

test('3D 路径：两端同点等退化情况不报错', () => {
  const walls = floorplan();
  const byId = new Map(walls.map(w => [w.id, w]));
  const pts = wirePathPoints(byId,
    { wall: 'w3', face: 1, pos: 0.5, height: 0.3 },
    { wall: 'w3', face: 1, pos: 0.5, height: 0.3 });
  assert.equal(pts, null);
  assert.equal(wirePathPoints(byId, { wall: 'missing', face: 1, pos: 0.5, height: 0.3 },
    { wall: 'w3', face: 1, pos: 0.5, height: 0.3 }), null);
});

// ---------- 三墙展开对话框 ----------

// 无 DOM 环境：只 stub open/computeViews 依赖的最小属性
function makeDialog(data, wallId, face, seg) {
  const notifications = [];
  const dialog = Object.assign(Object.create(WallFaceDialog.prototype), {
    dialog: { classList: { remove() {}, add() {}, contains() { return false; } } },
    scroll: { clientHeight: 500, clientWidth: 900, scrollLeft: 0 },
    svg: {},
    titleEl: { textContent: '' },
    infoEl: { innerHTML: '' },
    selectedNodeId: null,
    selectedWireId: null,
    dragging: null,
    snapGuideH: null,
    cbs: { onNotify: msg => notifications.push(msg), onSelect() {}, onChange() {} },
    setTool(tool) { this.tool = tool; },
    render() {},
    renderInfo() {},
  });
  dialog.notifications = notifications;
  dialog.open(data, wallId, face, 'edit', seg);
  dialog.computeViews();
  return dialog;
}

function floorData() {
  return {
    walls: floorplan(),
    nodes: [
      { id: 'a', type: 'turn', wall: 'w3', face: 1, pos: 0.5, height: 0.3 },   // w3 B 面
      { id: 'b', type: 'turn', wall: 'w4', face: 1, pos: 0.25, height: 1.3 },  // w4 B 面
      { id: 'c', type: 'turn', wall: 'w2', face: 1, pos: 0.75, height: 0.3 },  // w2 B 面靠角段（z=1.5）
      { id: 'd', type: 'turn', wall: 'w1', face: 1, pos: 0.5, height: 0.3 },   // w1 B 面
    ],
    wires: [],
    links: [],
  };
}

test('三墙视图：w3 B 面打开为 左=w2 / 当前=w3 / 右=w4，统一比例、底边对齐', () => {
  const dlg = makeDialog(floorData(), 'w3', 1, null);
  assert.deepEqual(dlg.views.map(v => [v.role, v.wallId, v.face]), [
    ['left', 'w2', 1], ['active', 'w3', 1], ['right', 'w4', 1],
  ]);
  for (const v of dlg.views) assert.equal(v.reversed, false); // B 面不反向
  // 底边对齐：所有面板 bandTop = heightY(h)
  const tops = dlg.views.map(v => dlg.heightY(v.h));
  assert.ok(tops.every(t => Math.abs(t - tops[0]) < 1e-9));
  // 面板依次排布，间距 PANEL_GAP
  for (let i = 1; i < dlg.views.length; i++) {
    const gap = dlg.views[i].baseX - (dlg.views[i - 1].baseX + dlg.views[i - 1].w);
    assert.ok(Math.abs(gap - 40) < 1e-9, `gap ${gap}`);
  }
});

test('三墙视图：A 面（外侧面）水平反向，但持久化 pos 不变', () => {
  const data = floorData();
  const dlg = makeDialog(data, 'w3', 0, null);
  const active = dlg.activeView();
  assert.equal(active.reversed, true);
  const node = { wall: 'w3', face: 0, pos: 0.25, height: 1 };
  // pos=0.25（w3 start 端附近，x=6）→ 反向显示应在面板右侧
  const x = dlg.posX(active, dlg.localOf(node, active));
  assert.ok(x > active.baseX + active.w / 2);
  // 往返映射一致
  assert.ok(Math.abs(dlg.xPos(active, x) - dlg.localOf(node, active)) < 1e-9);
  assert.equal(node.pos, 0.25);
});

test('三墙视图：跨墙电线端点映射到各自面板（xPos/localOf 往返）', () => {
  const dlg = makeDialog(floorData(), 'w3', 1, null);
  const w3 = dlg.views.find(v => v.wallId === 'w3');
  const w4 = dlg.views.find(v => v.wallId === 'w4');
  const a = dlg.data.nodes.find(n => n.id === 'a'); // w3 pos 0.5
  const b = dlg.data.nodes.find(n => n.id === 'b'); // w4 pos 0.25
  const xa = dlg.posX(w3, dlg.localOf(a, w3));
  const xb = dlg.posX(w4, dlg.localOf(b, w4));
  assert.ok(xa >= w3.baseX && xa <= w3.baseX + w3.w);
  assert.ok(xb >= w4.baseX && xb <= w4.baseX + w4.w);
  assert.ok(Math.abs(dlg.xPos(w3, xa) - 4) < 1e-9);   // w3 pos0.5 → 段内 4m
  assert.ok(Math.abs(dlg.xPos(w4, xb) - 1.5) < 1e-9); // w4 pos0.25 → 段内 1.5m（起点 z=6 起算）
});

test('跨墙电线校验：当前墙↔邻墙合法，邻墙内部/左右邻墙互连/不可见端点拒绝', () => {
  const dlg = makeDialog(floorData(), 'w3', 1, null);
  const [a, b, c] = ['a', 'b', 'c'].map(id => dlg.data.nodes.find(n => n.id === id));
  assert.equal(dlg.wirePairError(a, b), null);   // w3 ↔ w4（当前↔右邻）
  assert.equal(dlg.wirePairError(a, a), null); // 同节点同面板：由 onNodeMouseDown 拦截，校验器放行
  assert.equal(dlg.wirePairError(b, c), '只能连接当前墙与相邻墙面（不能绕过当前墙连左右邻墙）'); // w4 ↔ w2
  assert.equal(dlg.wirePairError(b, b), '相邻墙内部连线请先把该墙设为当前墙'); // 同一邻墙面板内
  const invisible = { wall: 'w1', face: 0, pos: 0.5, height: 0.3 }; // w1 A 面不可见
  assert.match(dlg.wirePairError(a, invisible), /都在当前展开的墙面内/);
});

test('跨墙电线校验：当前墙同面内正常', () => {
  const data = floorData();
  data.nodes.push({ id: 'e', type: 'turn', wall: 'w3', face: 1, pos: 0.75, height: 1.3 });
  const dlg = makeDialog(data, 'w3', 1, null);
  const a = data.nodes.find(n => n.id === 'a');
  const e = data.nodes.find(n => n.id === 'e');
  assert.equal(dlg.wirePairError(a, e), null);
});

test('当前墙切换：activateView 换墙/面/段并清理 pending 与选择', () => {
  const data = floorData();
  const dlg = makeDialog(data, 'w3', 1, null);
  const right = dlg.views.find(v => v.role === 'right');
  dlg.wirePending = 'a';
  dlg.linkPending = 'a';
  dlg.selectedNodeId = 'a';
  dlg.selectedWireId = 'w1';
  let cleared = 0;
  dlg.cbs.onSelect = sel => { if (sel === null) cleared++; };
  dlg.activateView(right);
  assert.equal(dlg.wallId, 'w4');
  assert.equal(dlg.face, 1);
  assert.equal(dlg.seg && dlg.seg.wallId, 'w4');
  assert.equal(dlg.wirePending, null);
  assert.equal(dlg.linkPending, null);
  assert.equal(dlg.selectedNodeId, null);
  assert.equal(dlg.selectedWireId, null);
  assert.equal(dlg.dragging, null);
  assert.equal(cleared, 1);
  // 切换后重新以 w4 该墙段为中心：左邻 w3，右邻 w5（段边界 (0,3.5) 恰是 w5 的 T 型交接）
  dlg.computeViews();
  assert.deepEqual(dlg.views.map(v => [v.role, v.wallId]), [
    ['left', 'w3'], ['active', 'w4'], ['right', 'w5'],
  ]);
  // 新墙上的节点现在可编辑，旧墙变为邻墙只读
  const b = data.nodes.find(n => n.id === 'b');
  const a = data.nodes.find(n => n.id === 'a');
  assert.equal(dlg.isActiveNode(b), true);
  assert.equal(dlg.isActiveNode(a), false);
});

test('节点归属：viewOfNode 按墙/面/段匹配可见视图', () => {
  const dlg = makeDialog(floorData(), 'w3', 1, null);
  const a = dlg.data.nodes.find(n => n.id === 'a');
  const b = dlg.data.nodes.find(n => n.id === 'b');
  assert.equal(dlg.viewOfNode(a).role, 'active');
  assert.equal(dlg.viewOfNode(b).role, 'right');
  assert.equal(dlg.viewOfNode({ wall: 'w1', face: 1, pos: 0.5, height: 0 }), null); // 不可见
});
