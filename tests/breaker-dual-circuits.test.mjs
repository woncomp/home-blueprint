import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCircuits, CIRCUIT_COLORS } from '../js/model.js';

// 双端子线路归并：断路器左右两个端子各自是一个连通入口，
// 两侧下游电线/节点归入同一个断路器、同一条线路，不重复计数

function makeData() {
  return {
    version: 3,
    walls: [{ id: 'w1', start: [0, 0], end: [4, 0], height: 2.8, thickness: 0.2 }],
    nodes: [
      { id: 'bb', type: 'device', deviceType: 'breakerBox', wall: 'w1', face: 1, pos: 0.5, height: 1.6, label: '强电箱',
        breakers: [
          { id: 'b1', label: '断路器 1', terminals: { left: 't1l', right: 't1r' } },
          { id: 'b2', label: '断路器 2', terminals: { left: 't2l', right: 't2r' } },
        ] },
      { id: 't1l', type: 'terminal', wall: 'w1', face: 1, pos: 0.47, height: 1.6, label: '' },
      { id: 't1r', type: 'terminal', wall: 'w1', face: 1, pos: 0.53, height: 1.6, label: '' },
      { id: 't2l', type: 'terminal', wall: 'w1', face: 1, pos: 0.47, height: 1.47, label: '' },
      { id: 't2r', type: 'terminal', wall: 'w1', face: 1, pos: 0.53, height: 1.47, label: '' },
      { id: 'n1', type: 'device', deviceType: 'socket', wall: 'w1', face: 1, pos: 0.3, height: 0.3, label: '' },
      { id: 'n2', type: 'device', deviceType: 'socket', wall: 'w1', face: 1, pos: 0.7, height: 0.3, label: '' },
      { id: 'n3', type: 'device', deviceType: 'socket', wall: 'w1', face: 1, pos: 0.9, height: 0.3, label: '' },
    ],
    wires: [],
    links: [],
    doors: [],
  };
}

test('仅左侧接线：与旧行为一致，线路从端子沿电线收集', () => {
  const data = makeData();
  data.wires.push({ id: 'e1', from: 't1l', to: 'n1', label: '' });
  const { circuits, wireCircuit, nodeCircuit } = computeCircuits(data);
  const c0 = circuits[0];
  assert.deepEqual([...c0.wireIds].sort(), ['e1']);
  assert.ok(c0.nodeIds.has('t1l') && c0.nodeIds.has('n1'));
  assert.equal(wireCircuit.get('e1'), 0);
  assert.equal(nodeCircuit.get('n1'), 0);
  // b2 未接线：空线路
  assert.equal(circuits[1].wireIds.size, 0);
});

test('仅右侧接线：与旧行为一致', () => {
  const data = makeData();
  data.wires.push({ id: 'e1', from: 't1r', to: 'n1', label: '' });
  const { circuits } = computeCircuits(data);
  assert.deepEqual([...circuits[0].wireIds].sort(), ['e1']);
  assert.ok(circuits[0].nodeIds.has('t1r'));
});

test('左右分别接两条不相连支路：两条支路同属一个断路器，段数为两者之和', () => {
  const data = makeData();
  data.wires.push({ id: 'e1', from: 't1l', to: 'n1', label: '' });
  data.wires.push({ id: 'e2', from: 't1r', to: 'n2', label: '' });
  const { circuits, wireCircuit, nodeCircuit } = computeCircuits(data);
  const c0 = circuits[0];
  assert.deepEqual([...c0.wireIds].sort(), ['e1', 'e2']);
  assert.equal(c0.wireIds.size, 2);
  for (const nid of ['t1l', 't1r', 'n1', 'n2']) assert.ok(c0.nodeIds.has(nid));
  assert.equal(wireCircuit.get('e1'), 0);
  assert.equal(wireCircuit.get('e2'), 0);
  assert.equal(nodeCircuit.get('n1'), 0);
  assert.equal(nodeCircuit.get('n2'), 0);
});

test('两侧支路在箱外连通：仍是一条线路，电线/节点不重复统计', () => {
  const data = makeData();
  data.wires.push({ id: 'e1', from: 't1l', to: 'n1', label: '' });
  data.wires.push({ id: 'e2', from: 't1r', to: 'n2', label: '' });
  data.wires.push({ id: 'e3', from: 'n1', to: 'n2', label: '' }); // 箱外连通两条支路
  const { circuits, wireCircuit, nodeCircuit } = computeCircuits(data);
  const c0 = circuits[0];
  // e3 只处理一次：两个入口落在同一连通分量，Set 去重后恰好 3 根
  assert.equal(c0.wireIds.size, 3);
  assert.deepEqual([...c0.wireIds].sort(), ['e1', 'e2', 'e3']);
  assert.equal(wireCircuit.get('e3'), 0);
  assert.equal(nodeCircuit.get('n1'), 0);
  assert.equal(nodeCircuit.get('n2'), 0);
});

test('同一断路器两侧线路颜色相同；多个断路器的独立线路正确区分', () => {
  const data = makeData();
  data.wires.push({ id: 'e1', from: 't1l', to: 'n1', label: '' });
  data.wires.push({ id: 'e2', from: 't1r', to: 'n2', label: '' });
  data.wires.push({ id: 'e3', from: 't2l', to: 'n3', label: '' });
  const { circuits, wireCircuit, nodeCircuit } = computeCircuits(data);
  assert.equal(circuits[0].color, CIRCUIT_COLORS[0]);
  assert.equal(circuits[1].color, CIRCUIT_COLORS[1]);
  assert.notEqual(circuits[0].color, circuits[1].color);
  assert.deepEqual([...circuits[0].wireIds].sort(), ['e1', 'e2']);
  assert.deepEqual([...circuits[1].wireIds].sort(), ['e3']);
  assert.equal(wireCircuit.get('e3'), 1);
  assert.equal(nodeCircuit.get('n3'), 1);
  // b1 的线路不吞并 b2 的节点
  assert.ok(!circuits[0].nodeIds.has('n3'));
  assert.ok(!circuits[1].nodeIds.has('n1'));
});

test('两侧都未接线：断路器保持空线路', () => {
  const data = makeData();
  const { circuits } = computeCircuits(data);
  assert.equal(circuits[0].wireIds.size, 0);
  assert.equal(circuits[0].nodeIds.size, 0);
  assert.equal(circuits[1].wireIds.size, 0);
});

test('经 links 穿墙连通的两侧支路同样归入同一线路', () => {
  const data = makeData();
  data.wires.push({ id: 'e1', from: 't1l', to: 'n1', label: '' });
  data.wires.push({ id: 'e2', from: 't1r', to: 'n2', label: '' });
  data.links.push({ id: 'l1', a: 'n1', b: 'n2' }); // 连通代替电线
  const { circuits } = computeCircuits(data);
  assert.equal(circuits[0].wireIds.size, 2);
  assert.ok(circuits[0].nodeIds.has('n1') && circuits[0].nodeIds.has('n2'));
});
