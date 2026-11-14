import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCircuits, deviceDisplayColor, DEVICE_TYPES, CIRCUIT_COLORS,
} from '../js/model.js';

// 强电箱 + 两个断路器，各带一路插座；另有一个未接线的插座
function fixture() {
  return {
    nodes: [
      { id: 'bb', type: 'device', deviceType: 'breakerBox', wall: 'w1', face: 0, pos: 0.25, height: 1.6, breakers: [
        { id: 'br1', label: 'B1', terminals: { left: 't1', right: null } },
        { id: 'br2', label: 'B2', terminals: { left: 't2', right: null } },
      ] },
      { id: 't1', type: 'terminal', wall: 'w1', face: 0, pos: 0.2, height: 1.6 },
      { id: 't2', type: 'terminal', wall: 'w1', face: 0, pos: 0.3, height: 1.6 },
      { id: 's1', type: 'device', deviceType: 'socket', wall: 'w1', face: 0, pos: 0.75, height: 0.3 },
      { id: 's2', type: 'device', deviceType: 'socket', wall: 'w2', face: 1, pos: 0.5, height: 0.3 },
      { id: 'sw1', type: 'device', deviceType: 'switch', wall: 'w1', face: 0, pos: 0.6, height: 1.3 },
      { id: 'l1', type: 'device', deviceType: 'light', wall: 'w2', face: 1, pos: 0.7, height: 2.4 },
      { id: 's3', type: 'device', deviceType: 'socket', wall: 'w2', face: 1, pos: 0.9, height: 0.3 },
    ],
    wires: [
      { id: 'e1', from: 't1', to: 's1' },
      { id: 'e2', from: 't1', to: 'sw1' },
      { id: 'e3', from: 't2', to: 's2' },
      { id: 'e4', from: 's2', to: 'l1' },
    ],
    links: [],
  };
}

test('插座颜色跟随所属线路颜色', () => {
  const data = fixture();
  const circuits = computeCircuits(data);
  const byId = new Map(data.nodes.map(n => [n.id, n]));
  // s1 经 t1 属 br1 线路（索引 0）
  assert.equal(deviceDisplayColor(byId.get('s1'), circuits), CIRCUIT_COLORS[0]);
  // s2 经 t2 属 br2 线路（索引 1）
  assert.equal(deviceDisplayColor(byId.get('s2'), circuits), CIRCUIT_COLORS[1]);
});

test('开关/灯具即使在线路上也保持类型色', () => {
  const data = fixture();
  const circuits = computeCircuits(data);
  const byId = new Map(data.nodes.map(n => [n.id, n]));
  assert.equal(deviceDisplayColor(byId.get('sw1'), circuits), DEVICE_TYPES.switch.color);
  assert.equal(deviceDisplayColor(byId.get('l1'), circuits), DEVICE_TYPES.light.color);
});

test('未接线路的插座回退类型色；无线路信息时同样回退', () => {
  const data = fixture();
  const circuits = computeCircuits(data);
  const byId = new Map(data.nodes.map(n => [n.id, n]));
  // s3 没有任何电线连接
  assert.equal(deviceDisplayColor(byId.get('s3'), circuits), DEVICE_TYPES.socket.color);
  // 不传 circuitInfo 时直接返回类型色
  assert.equal(deviceDisplayColor(byId.get('s1'), null), DEVICE_TYPES.socket.color);
  assert.equal(deviceDisplayColor(byId.get('sw1'), undefined), DEVICE_TYPES.switch.color);
});
