import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  genId, createEmptyData, createWall, createNode, createWire,
  createDoor, createBreakerBox, validateData,
} from '../js/model.js';

test('genId：空数据从 1 开始编号', () => {
  const data = createEmptyData();
  assert.equal(genId(data, 'w'), 'w1');
  assert.equal(genId(data, 'n'), 'n1');
  assert.equal(genId(data, 'd'), 'd1');
  assert.equal(genId(data, 'e'), 'e1');
  assert.equal(genId(data, 'b'), 'b1');
  assert.equal(genId(data, 'bb'), 'bb1');
});

test('genId：取同前缀最大数字 +1，忽略无数字后缀的旧式 id', () => {
  const data = createEmptyData();
  data.walls = [
    { id: 'w1', start: [0, 0], end: [1, 0], height: 2.8, thickness: 0.2 },
    { id: 'w9', start: [0, 1], end: [1, 1], height: 2.8, thickness: 0.2 },
    // 旧 genId 风格的长随机 id 不参与数字最大值计算
    { id: 'wmvnptgj9_1', start: [0, 2], end: [1, 2], height: 2.8, thickness: 0.2 },
  ];
  assert.equal(genId(data, 'w'), 'w10');
});

test('genId：目标 id 被任意类型占用时继续 +1 直到空位', () => {
  const data = createEmptyData();
  data.walls = [
    { id: 'w1', start: [0, 0], end: [1, 0], height: 2.8, thickness: 0.2 },
    { id: 'w2', start: [0, 1], end: [1, 1], height: 2.8, thickness: 0.2 },
  ];
  // 节点占用了 w3：墙编号必须跳过它（id 全局唯一，跨类型也不能撞）
  data.nodes = [{ id: 'w3', type: 'turn', wall: 'w1', face: 1, pos: 0.5, height: 1, label: '' }];
  assert.equal(genId(data, 'w'), 'w4');
});

test('genId：数字编号不跨前缀串扰（b 与 bb 各自独立）', () => {
  const data = createEmptyData();
  data.nodes = [{
    id: 'bb1', type: 'device', deviceType: 'breakerBox', wall: 'w1', face: 1,
    pos: 0.5, height: 1.6, label: '强电箱',
    breakers: [{ id: 'b1', label: '', terminals: { left: 't1', right: 't2' } }],
  }];
  assert.equal(genId(data, 'b'), 'b2');
  assert.equal(genId(data, 'bb'), 'bb2');
});

test('工厂函数：按 data 现状分配递增编号', () => {
  const data = createEmptyData();
  const w1 = createWall(data, 0, 0, 8, 0);
  assert.equal(w1.id, 'w1');
  data.walls.push(w1);
  const w2 = createWall(data, 8, 0, 8, 6);
  assert.equal(w2.id, 'w2');
  data.walls.push(w2);

  const box = createBreakerBox(data, w1.id, 1, 0.5);
  assert.equal(box.id, 'bb1');
  data.nodes.push(box);

  const n1 = createNode(data, 'device', w1.id, 1, 0.5, 0.3, 'socket');
  assert.equal(n1.id, 'n1');
  data.nodes.push(n1);
  const n2 = createNode(data, 'turn', w1.id, 1, 0.6, 2.1);
  assert.equal(n2.id, 'n2');
  data.nodes.push(n2);

  const e1 = createWire(data, n1.id, n2.id);
  assert.equal(e1.id, 'e1');
  data.wires.push(e1);

  const d1 = createDoor(data, w1.id, 2);
  assert.equal(d1.id, 'd1');
  data.doors.push(d1);

  assert.equal(validateData({ ...data, version: 4, rooms: {} }), null);
});

test('默认户型：迁移后的编号基线（新增从 w18/n21/d6/e21/b5/bb2 起）', () => {
  const data = JSON.parse(readFileSync(new URL('../data/default.json', import.meta.url), 'utf8'));
  assert.equal(validateData(data), null);
  assert.equal(genId(data, 'w'), 'w18');
  assert.equal(genId(data, 'n'), 'n21');
  assert.equal(genId(data, 'd'), 'd6');
  assert.equal(genId(data, 'e'), 'e21');
  assert.equal(genId(data, 'b'), 'b5');
  assert.equal(genId(data, 'bb'), 'bb2');
});
