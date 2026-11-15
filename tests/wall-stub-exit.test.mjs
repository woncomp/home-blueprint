import assert from 'node:assert/strict';
import test from 'node:test';
import { WallFaceDialog } from '../js/wallface.js';
import { computeCircuits } from '../js/model.js';

// ---------- 构造工具 ----------

function wall(id, x1, z1, x2, z2, opts = {}) {
  return {
    id,
    start: [x1, z1],
    end: [x2, z2],
    height: opts.height ?? 2.8,
    thickness: opts.thickness ?? 0.2,
  };
}

// 只 stub stubExitX 依赖的最小属性（data / scale），不经过 open/computeViews
function makeRawDialog(data, scale = 100) {
  return Object.assign(Object.create(WallFaceDialog.prototype), { data, scale });
}

// 合成视图：len/baseX/w 与 scale=100 配套（w = len * scale）
function viewOf(w, face, seg = null, baseX = 100) {
  const t0 = seg ? seg.t0 : 0, t1 = seg ? seg.t1 : 1;
  const len = (t1 - t0) * Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
  return { role: 'active', wallId: w.id, face, seg, wall: w, len, reversed: face === 0, baseX, w: len * 100 };
}

// ---------- stubExitX 单元测试 ----------

test('A 面：对端墙贴本墙终点拐角 → 从显示左缘出去（用户截图场景）', () => {
  // w1 (0,0)→(2,0)，w2 从终点 (2,0) 拐向 +z；面对 w1 A 面时拐角在显示左侧
  const w1 = wall('w1', 0, 0, 2, 0);
  const w2 = wall('w2', 2, 0, 2, 1.5);
  const dlg = makeRawDialog({ walls: [w1, w2] });
  const vs = viewOf(w1, 0);
  // 本端节点在显示右半（x1 > mid），旧的就近边缘启发式会错选右缘
  const selfPx = vs.baseX + vs.w * 0.75;
  const x2 = dlg.stubExitX(vs, selfPx, { wall: 'w2' });
  assert.equal(x2, vs.baseX); // 显示左缘 = 段 local len（A 面反向）
  assert.equal(x2, dlg.posX(vs, vs.len));
});

test('B 面：同一几何，对端墙贴终点拐角 → 从显示右缘出去', () => {
  const w1 = wall('w1', 0, 0, 2, 0);
  const w2 = wall('w2', 2, 0, 2, 1.5);
  const dlg = makeRawDialog({ walls: [w1, w2] });
  const vs = viewOf(w1, 1);
  const selfPx = vs.baseX + vs.w * 0.25; // 显示左半，旧启发式会选左缘
  const x2 = dlg.stubExitX(vs, selfPx, { wall: 'w2' });
  assert.equal(x2, vs.baseX + vs.w); // 显示右缘 = 段 local len（B 面不反向）
  assert.equal(x2, dlg.posX(vs, vs.len));
});

test('对端墙贴本墙起点拐角 → 从 local 0 对应的显示边缘出去', () => {
  const w1 = wall('w1', 0, 0, 2, 0);
  const w2 = wall('w2', 0, 0, 0, 1.5);
  const dlg = makeRawDialog({ walls: [w1, w2] });
  // A 面：起点在显示右缘
  const vsA = viewOf(w1, 0);
  assert.equal(dlg.stubExitX(vsA, vsA.baseX + vsA.w * 0.25, { wall: 'w2' }), vsA.baseX + vsA.w);
  // B 面：起点在显示左缘
  const vsB = viewOf(w1, 1);
  assert.equal(dlg.stubExitX(vsB, vsB.baseX + vsB.w * 0.75, { wall: 'w2' }), vsB.baseX);
});

test('段视图：对端墙贴段边界即定向（贴段起点 → local 0 边缘）', () => {
  // w1 长 4m，视图取后半段 [0.5,1]（2m~4m）；w2 在段起点 (2,0) 处拐弯
  const w1 = wall('w1', 0, 0, 4, 0);
  const w2 = wall('w2', 2, 0, 2, 1.5);
  const dlg = makeRawDialog({ walls: [w1, w2] });
  const vs = viewOf(w1, 0, { id: 's2', wallId: 'w1', index: 1, t0: 0.5, t1: 1 });
  assert.equal(vs.len, 2);
  // w2 贴段起点 t=0.5 → 从 local 0 边缘出去（A 面反向 → 显示右缘）
  assert.equal(dlg.stubExitX(vs, vs.baseX + vs.w * 0.25, { wall: 'w2' }), vs.baseX + vs.w);
});

test('对端墙不相邻（对墙/远端）→ 退回就近边缘', () => {
  const w1 = wall('w1', 0, 0, 2, 0);
  const far = wall('wfar', 0, 3, 2, 3); // 平行对墙，两端都不贴
  const dlg = makeRawDialog({ walls: [w1, far] });
  const vs = viewOf(w1, 0);
  assert.equal(dlg.stubExitX(vs, vs.baseX + vs.w * 0.75, { wall: 'wfar' }), vs.baseX + vs.w);
  assert.equal(dlg.stubExitX(vs, vs.baseX + vs.w * 0.25, { wall: 'wfar' }), vs.baseX);
});

test('共线重叠（两端都贴）→ 退回就近边缘', () => {
  const w1 = wall('w1', 0, 0, 2, 0);
  const w2 = wall('w2', 0, 0, 2, 0); // 完全重叠，at0/at1 同真，方向无从判断
  const dlg = makeRawDialog({ walls: [w1, w2] });
  const vs = viewOf(w1, 0);
  assert.equal(dlg.stubExitX(vs, vs.baseX + vs.w * 0.75, { wall: 'w2' }), vs.baseX + vs.w);
});

test('对端墙 id 不存在于数据中 → 退回就近边缘，不抛错', () => {
  const w1 = wall('w1', 0, 0, 2, 0);
  const dlg = makeRawDialog({ walls: [w1] });
  const vs = viewOf(w1, 0);
  assert.equal(dlg.stubExitX(vs, vs.baseX + vs.w * 0.25, { wall: 'ghost' }), vs.baseX);
});

// ---------- renderWires 集成：虚线端点落在邻接定向的边缘 ----------

// 最小 DOM stub：只支持 el() 与 svg.appendChild，元素属性存 attrs
function fakeEl(tag) {
  return {
    tag, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
  };
}

// 经 open/computeViews 得到真实坐标系，再裁掉邻墙视图，
// 模拟"对端墙不在三墙展开中"（用户截图场景），最后手动调 renderWires
function renderWiresInOwnView(data, wallId, face, wires, links = []) {
  const savedDoc = globalThis.document;
  globalThis.document = { createElementNS: (ns, tag) => fakeEl(tag) };
  try {
    const full = { ...data, wires, links };
    const dlg = Object.assign(Object.create(WallFaceDialog.prototype), {
      dialog: { classList: { remove() {}, add() {}, contains() { return false; } } },
      scroll: { clientHeight: 500, clientWidth: 900, scrollLeft: 0 },
      svg: fakeEl('svg'),
      titleEl: fakeEl('text'),
      infoEl: { innerHTML: '' },
      selectedNodeId: null,
      selectedWireId: null,
      selectedDoorId: null,
      dragging: null,
      snapGuideH: null,
      cbs: { onNotify() {}, onSelect() {}, onChange() {} },
      setTool(tool) { this.tool = tool; },
      render() {},
      renderInfo() {},
    });
    dlg.open(full, wallId, face, 'browse', null);
    dlg.computeViews();
    dlg.views = dlg.views.filter(v => v.role === 'active');
    dlg.circuits = computeCircuits(full);
    dlg.svg = fakeEl('svg');
    dlg.renderWires();
    return dlg;
  } finally {
    globalThis.document = savedDoc;
  }
}

test('renderWires：跨墙电线对端不可见时，虚线按墙端邻接走向正确的面板边缘', () => {
  const w1 = wall('w1', 0, 0, 2, 0);
  const w2 = wall('w2', 2, 0, 2, 1.5);
  const data = {
    walls: [w1, w2],
    nodes: [
      { id: 'a', type: 'turn', wall: 'w1', face: 0, pos: 0.5, height: 1.2 },
      { id: 'b', type: 'turn', wall: 'w2', face: 0, pos: 0.5, height: 1.0 },
    ],
  };
  const dlg = renderWiresInOwnView(data, 'w1', 0, [{ id: 'w', from: 'a', to: 'b' }]);
  const stub = dlg.svg.children.find(e => e.tag === 'polyline' && e.attrs['stroke-dasharray'] === '6 4');
  assert.ok(stub, '应渲染一条跨墙虚线');
  // 与实线一致的画线策略：横平竖直、中点折角的四段折线
  const pts = stub.attrs.points.split(' ').map(s => s.split(',').map(Number));
  assert.equal(pts.length, 4);
  assert.equal(pts[0][1], pts[1][1], '第一段应水平');
  assert.equal(pts[1][0], pts[2][0], '第二段应竖直');
  assert.equal(pts[2][1], pts[3][1], '第三段应水平');
  // A 面反向：贴终点拐角的 w2 → 出口必须是显示左缘，而非就近启发式的右缘
  const av = dlg.views[0];
  assert.equal(pts[3][0], dlg.posX(av, av.len));
  assert.ok(pts[3][0] < pts[0][0], '虚线应向左走出面板');
});

test('renderWires：跨墙连通（link）对端不可见时同样按邻接定向', () => {
  const w1 = wall('w1', 0, 0, 2, 0);
  const w2 = wall('w2', 2, 0, 2, 1.5);
  const data = {
    walls: [w1, w2],
    nodes: [
      { id: 'a', type: 'turn', wall: 'w1', face: 0, pos: 0.5, height: 1.2 },
      { id: 'b', type: 'turn', wall: 'w2', face: 0, pos: 0.5, height: 1.0 },
    ],
  };
  const dlg = renderWiresInOwnView(data, 'w1', 0, [], [{ id: 'l', a: 'a', b: 'b' }]);
  const path = dlg.svg.children.find(e => e.tag === 'path' && e.attrs.stroke === '#a06cd5');
  assert.ok(path, '应渲染一条紫色连通虚线弧');
  const av = dlg.views[0];
  const x2 = dlg.posX(av, av.len);
  const y2 = dlg.heightY(1.0); // 对端节点 b 的高度
  assert.ok(path.attrs.d.endsWith(`${x2} ${y2}`), `连通弧终点应落在显示左缘，got d=${path.attrs.d}`);
});
