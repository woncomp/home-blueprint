import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonText } from '../js/persistence.js';
import { createEmptyData } from '../js/model.js';

// 无 DOM 的纯文本解析/校验链路测试；DOM 相关的弹窗与提交行为由浏览器手工验收覆盖
function makeV2() {
  return {
    version: 2,
    walls: [{ id: 'w1', start: [0, 0], end: [4, 0], height: 2.8, thickness: 0.2 }],
    nodes: [
      { id: 'bb1', type: 'device', deviceType: 'breakerBox', wall: 'w1', face: 1, pos: 0.5, height: 1.6, label: '强电箱', breakers: [{ id: 'b1', label: '断路器 1', terminal: 't1' }] },
      { id: 't1', type: 'terminal', wall: 'w1', face: 1, pos: 0.3, height: 1.6 },
      { id: 'n2', type: 'device', deviceType: 'socket', wall: 'w1', face: 1, pos: 0.75, height: 1.2, label: '' },
      { id: 'n3', type: 'turn', wall: 'w1', face: 0, pos: 0.6, height: 0.8, label: '' },
    ],
    wires: [{ id: 'e1', from: 't1', to: 'n2', label: '' }],
    links: [{ id: 'l1', a: 'n2', b: 'n3' }],
    doors: [{ id: 'd1', wall: 'w1', pos: 1, width: 0.9, face: 0, height: 2.0 }],
    roomNames: {},
    roomNameHints: [],
  };
}

// 版本 3 断路器双端子数据（t1 为 b1 左端子，t1r 为右端子）
function makeV3() {
  const v2 = makeV2();
  return {
    ...v2,
    version: 3,
    nodes: [
      { ...v2.nodes[0], breakers: [{ id: 'b1', label: '断路器 1', terminals: { left: 't1', right: 't1r' } }] },
      v2.nodes[1], // t1
      { id: 't1r', type: 'terminal', wall: 'w1', face: 1, pos: 0.32, height: 1.6 },
      v2.nodes[2], // n2
      v2.nodes[3], // n3
    ],
  };
}

const v2Text = () => JSON.stringify(makeV2());
const v3Text = () => JSON.stringify(makeV3());

function assertParseError(text, pattern) {
  assert.throws(() => parseJsonText(text), e => pattern.test(e.message), `期望抛出 ${pattern}，实际输入: ${text.slice(0, 80)}`);
}

test('合法版本 2 数据解析后迁移为版本 3 双端子，核心内容保持不变', () => {
  const data = parseJsonText(v2Text());
  assert.equal(data.version, 3);
  assert.deepEqual(data.nodes.map(n => n.id), ['bb1', 't1', 'n2', 'n3', data.nodes[4].id]);
  assert.equal(data.wires[0].from, 't1');
  assert.equal(data.wires[0].to, 'n2');
  assert.equal(data.links[0].a, 'n2');
  assert.equal(data.doors[0].wall, 'w1');
  // 原端子保留为左侧，新增右端子节点；旧 terminal/side 字段不再出现
  const br = data.nodes[0].breakers[0];
  assert.equal(br.terminals.left, 't1');
  assert.ok(br.terminals.right && br.terminals.right !== 't1');
  assert.ok(!('terminal' in br) && !('side' in br));
  const rightNode = data.nodes.find(n => n.id === br.terminals.right);
  assert.equal(rightNode.type, 'terminal');
  assert.equal(rightNode.wall, 'w1');
});

test('版本 2 数据 side 为 right 时，原端子保留为右侧并新增左端子', () => {
  const v2 = makeV2();
  v2.nodes[0].breakers[0].side = 'right';
  const data = parseJsonText(JSON.stringify(v2));
  const br = data.nodes[0].breakers[0];
  assert.equal(br.terminals.right, 't1');
  assert.ok(br.terminals.left && br.terminals.left !== 't1');
  assert.equal(data.nodes.find(n => n.id === br.terminals.left).type, 'terminal');
  assert.ok(!('terminal' in br) && !('side' in br));
});

test('版本 2 断路器缺失 terminal 时自动补全左右双端子', () => {
  const v2 = makeV2();
  delete v2.nodes[0].breakers[0].terminal;
  const data = parseJsonText(JSON.stringify(v2));
  const br = data.nodes[0].breakers[0];
  assert.ok(br.terminals.left && br.terminals.right && br.terminals.left !== br.terminals.right);
  for (const tid of [br.terminals.left, br.terminals.right]) {
    assert.equal(data.nodes.find(n => n.id === tid).type, 'terminal');
  }
});

test('合法版本 1 数据先完成坐标迁移，再正确生成双端子', () => {
  const v1 = {
    version: 1,
    breakerBox: { id: 'bb1', wall: 'w1', face: 1, pos: 2, height: 1.6, label: '强电箱', breakers: [{ id: 'b1', label: '断路器 1', terminal: 'n1' }] },
    walls: [{ id: 'w1', start: [0, 0], end: [4, 0], height: 2.8, thickness: 0.2 }],
    nodes: [
      { id: 'n1', type: 'terminal', wall: 'w1', face: 1, pos: 2, height: 1.6 },
      { id: 'n2', type: 'device', deviceType: 'socket', wall: 'w1', face: 1, pos: 3, height: 1.2, label: '' },
    ],
    wires: [{ id: 'e1', from: 'n1', to: 'n2', label: '' }],
  };
  const data = parseJsonText(JSON.stringify(v1));
  assert.equal(data.version, 3);
  assert.ok(!('breakerBox' in data));
  assert.deepEqual(data.nodes.map(n => n.id), ['n1', 'n2', 'bb1', data.nodes[3].id]);
  // 4m 墙：2m → 0.5、3m → 0.75；顶层强电箱迁移进来的 pos 一并转换（新端子取箱体值，不再二次转换）
  assert.equal(data.nodes[0].pos, 0.5);
  assert.equal(data.nodes[1].pos, 0.75);
  assert.equal(data.nodes[2].pos, 0.5);
  assert.deepEqual(data.doors, []); // 旧数据没有门字段，自动补空数组
  const br = data.nodes[2].breakers[0];
  assert.equal(br.terminals.left, 'n1'); // side 缺省按旧默认行为归左侧
  assert.ok(br.terminals.right && br.terminals.right !== 'n1');
  assert.equal(data.nodes[3].pos, 0.5); // 新建端子坐标为箱体值，未被米数→归一化二次转换
});

test('语法错误、非对象根节点、不支持的版本、缺失核心数组均抛出明确错误', () => {
  assertParseError('{ bad json', /JSON 解析失败/);
  assertParseError('[]', /根节点必须是对象/);
  assertParseError('"布局"', /根节点必须是对象/);
  assertParseError('null', /根节点必须是对象/);
  assertParseError('42', /根节点必须是对象/);
  const bad = makeV3(); bad.version = 4;
  assertParseError(JSON.stringify(bad), /不支持的版本: 4/);
  const missing = makeV3(); delete missing.walls;
  assertParseError(JSON.stringify(missing), /walls\/nodes\/wires 必须是数组/);
  const badLinks = makeV3(); badLinks.links = {};
  assertParseError(JSON.stringify(badLinks), /links 必须是数组/);
});

test('不存在的墙/节点引用、重复核心 ID、非法节点 pos 等被拒绝', () => {
  let d = makeV3(); d.nodes[1].wall = 'w404';
  assertParseError(JSON.stringify(d), /节点 t1 引用了不存在的墙/);
  d = makeV3(); d.nodes[2].pos = 1.5;
  assertParseError(JSON.stringify(d), /pos 必须是 0~1/);
  d = makeV3(); d.nodes[2].pos = '0.75'; // 非数字同样拒绝
  assertParseError(JSON.stringify(d), /pos 必须是 0~1/);
  d = makeV3(); d.wires[0].to = 'n404';
  assertParseError(JSON.stringify(d), /电线 e1 引用了不存在的节点/);
  d = makeV3(); d.links[0].b = 'n404';
  assertParseError(JSON.stringify(d), /连通 l1 引用了不存在的节点/);
  d = makeV3(); d.doors[0].wall = 'w404';
  assertParseError(JSON.stringify(d), /门 d1 引用了不存在的墙/);
  d = makeV3(); d.nodes[1].id = d.walls[0].id; // 跨集合重复也算重复
  assertParseError(JSON.stringify(d), /重复的 id: w1/);
  d = makeV3(); d.wires[0].id = d.nodes[0].id;
  assertParseError(JSON.stringify(d), /重复的 id: bb1/);
  d = makeV3(); d.walls[0].start = [0, 'a'];
  assertParseError(JSON.stringify(d), /start\/end 必须是 \[x, z\] 坐标/);
  d = makeV3(); d.nodes[4].type = 'corner';
  assertParseError(JSON.stringify(d), /type 无效/);
});

test('版本 3 断路器端子完整性：缺失、悬空、非端子节点、左右相同、跨断路器重复均被拒绝', () => {
  let d = makeV3(); delete d.nodes[0].breakers[0].terminals;
  assertParseError(JSON.stringify(d), /缺少左右端子/);
  d = makeV3(); d.nodes[0].breakers[0].terminals = { left: 't1' };
  assertParseError(JSON.stringify(d), /缺少右侧端子/);
  d = makeV3(); d.nodes[0].breakers[0].terminals.left = 'n404';
  assertParseError(JSON.stringify(d), /引用了不存在的端子/);
  d = makeV3(); d.nodes[0].breakers[0].terminals.left = 'n2'; // 真实节点但不是 terminal
  assertParseError(JSON.stringify(d), /不是端子节点/);
  d = makeV3(); d.nodes[0].breakers[0].terminals.right = 't1'; // 左右同节点
  assertParseError(JSON.stringify(d), /左右端子引用了同一节点/);
  d = makeV3();
  d.nodes[0].breakers.push({ id: 'b2', label: '断路器 2', terminals: { left: 't1', right: 't9' } });
  d.nodes.push({ id: 't9', type: 'terminal', wall: 'w1', face: 1, pos: 0.5, height: 1.6 });
  assertParseError(JSON.stringify(d), /被多个断路器引用/);
});

test('links/doors 缺省的旧式数据仍可通过；导出的版本 3 不含旧 terminal/side 字段', () => {
  const v2 = makeV2();
  delete v2.links; delete v2.doors;
  delete v2.nodes[0].breakers[0].terminal; // 未接线的旧断路器：迁移时补双端子
  const data = parseJsonText(JSON.stringify(v2));
  assert.equal(data.wires.length, 1);
  const br = data.nodes[0].breakers[0];
  assert.ok(br.terminals.left && br.terminals.right);
  const text = JSON.stringify(data);
  assert.ok(!('terminal' in br));
  assert.ok(!('side' in br));
  assert.equal(text.match(/"side"/g), null);
});

test('空户型（无墙无箱）可通过校验', () => {
  const data = parseJsonText(JSON.stringify(createEmptyData()));
  assert.equal(data.version, 3);
  assert.equal(data.walls.length, 0);
});

test('每次解析返回全新对象，失败路径不产出任何数据', () => {
  const a = parseJsonText(v3Text());
  const b = parseJsonText(v3Text());
  assert.deepEqual(a, b);
  assert.notEqual(a, b); // 不复用同一对象，应用时整体替换而非共享引用
  assert.throws(() => parseJsonText('nope'), /JSON 解析失败/);
});
