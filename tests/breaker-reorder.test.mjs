import assert from 'node:assert/strict';
import test from 'node:test';
import { reorderBreakers, breakerTerminalHeight, BREAKER_BOX_SIZE } from '../js/model.js';

// 面板拖拽排序：reorderBreakers 纯重排 box.breakers 数组——
// 断路器对象（含端子 id 引用）原样搬移，只有序号变化；
// 序号决定箱体垂直位置（breakerTerminalHeight）与线路颜色（computeCircuits 按位取色）

function makeBox(n) {
  const breakers = [];
  for (let i = 0; i < n; i++) {
    breakers.push({ id: `b${i + 1}`, label: `断路器 ${i + 1}`, terminals: { left: `t${i + 1}l`, right: `t${i + 1}r` } });
  }
  return { id: 'bb', type: 'device', deviceType: 'breakerBox', wall: 'w1', face: 1, pos: 0.5, height: 1.6, breakers };
}

function ids(box) {
  return box.breakers.map(b => b.id);
}

test('from < to：前段移到中间，其余保持相对顺序', () => {
  const box = makeBox(4);
  assert.equal(reorderBreakers(box, 0, 2), true);
  assert.deepEqual(ids(box), ['b2', 'b3', 'b1', 'b4']);
});

test('from > to：后段移到最前', () => {
  const box = makeBox(4);
  assert.equal(reorderBreakers(box, 3, 0), true);
  assert.deepEqual(ids(box), ['b4', 'b1', 'b2', 'b3']);
});

test('相邻互换：from 与 to 相差 1', () => {
  const box = makeBox(3);
  assert.equal(reorderBreakers(box, 1, 2), true);
  assert.deepEqual(ids(box), ['b1', 'b3', 'b2']);
  const box2 = makeBox(3);
  assert.equal(reorderBreakers(box2, 2, 1), true);
  assert.deepEqual(ids(box2), ['b1', 'b3', 'b2']);
});

test('拖到自身：no-op', () => {
  const box = makeBox(3);
  assert.equal(reorderBreakers(box, 1, 1), false);
  assert.deepEqual(ids(box), ['b1', 'b2', 'b3']);
});

test('下标越界：no-op', () => {
  const box = makeBox(3);
  assert.equal(reorderBreakers(box, -1, 1), false);
  assert.equal(reorderBreakers(box, 0, 3), false);
  assert.equal(reorderBreakers(box, 3, 0), false);
  assert.equal(reorderBreakers(box, 0, -1), false);
  assert.deepEqual(ids(box), ['b1', 'b2', 'b3']);
});

test('非整数下标：no-op', () => {
  const box = makeBox(3);
  assert.equal(reorderBreakers(box, 0.5, 2), false);
  assert.equal(reorderBreakers(box, 0, NaN), false);
  assert.deepEqual(ids(box), ['b1', 'b2', 'b3']);
});

test('单元素箱体：唯一合法拖动是自身，返回 false', () => {
  const box = makeBox(1);
  assert.equal(reorderBreakers(box, 0, 0), false);
  assert.equal(reorderBreakers(box, 0, 1), false);
  assert.deepEqual(ids(box), ['b1']);
});

test('空箱体/缺 breakers：no-op，不抛错', () => {
  assert.equal(reorderBreakers(null, 0, 1), false);
  assert.equal(reorderBreakers({}, 0, 1), false);
  assert.equal(reorderBreakers({ breakers: [] }, 0, 1), false);
});

test('断路器对象与端子引用原样搬移（同一引用，非拷贝）', () => {
  const box = makeBox(3);
  const b1 = box.breakers[0];
  reorderBreakers(box, 0, 2);
  assert.equal(box.breakers[2], b1);
  assert.deepEqual(box.breakers[2].terminals, { left: 't1l', right: 't1r' });
});

test('重排后端子高度按新序号严格递增且与序号一致', () => {
  const box = makeBox(5);
  reorderBreakers(box, 4, 0); // 原第 5 条移到最前
  const n = box.breakers.length;
  const heights = box.breakers.map((_, i) => breakerTerminalHeight(i, n, box.height));
  for (let i = 1; i < heights.length; i++) {
    assert.ok(heights[i] > heights[i - 1], `第 ${i} 条高度应大于第 ${i - 1} 条`);
  }
  // 首/末条端子仍落在箱体垂直范围内（两端各预留 0.5 权重）
  assert.ok(heights[0] > box.height - BREAKER_BOX_SIZE.h / 2);
  assert.ok(heights[n - 1] < box.height + BREAKER_BOX_SIZE.h / 2);
});

test('重排后 validateData 可通过：端子归属唯一、无重复引用', async () => {
  const { validateData } = await import('../js/model.js');
  const box = makeBox(3);
  const data = {
    version: 4,
    walls: [{ id: 'w1', start: [0, 0], end: [4, 0], height: 2.8, thickness: 0.2 }],
    nodes: [{ id: 'n1', type: 'device', deviceType: 'socket', wall: 'w1', face: 1, pos: 0.3, height: 0.3, label: '' }],
    wires: [], links: [], doors: [],
  };
  data.nodes.unshift(box);
  for (const br of box.breakers) {
    for (const side of ['left', 'right']) {
      data.nodes.push({ id: br.terminals[side], type: 'terminal', wall: 'w1', face: 1, pos: 0.5, height: 1.6, label: '' });
    }
  }
  assert.equal(validateData(data), null);
  reorderBreakers(box, 2, 0);
  assert.equal(validateData(data), null);
});
