import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  detectRooms, canonicalWallKey, assignRoomKeys, reconcileRooms,
  resolveRoomNames, roomLabelPoint, roomLabelUV, getRoomRecord,
  ensureRoomRecord, pruneRoomRecord, validateData, roomBBox,
} from '../js/model.js';
import { parseJsonText } from '../js/persistence.js';

// 4m × 3m 矩形房间（顶边 w1，顺时针）
function rectWalls() {
  return [
    { id: 'w1', start: [0, 0], end: [4, 0], height: 2.8, thickness: 0.2 },
    { id: 'w2', start: [4, 0], end: [4, 3], height: 2.8, thickness: 0.2 },
    { id: 'w3', start: [4, 3], end: [0, 3], height: 2.8, thickness: 0.2 },
    { id: 'w4', start: [0, 3], end: [0, 0], height: 2.8, thickness: 0.2 },
  ];
}

// 矩形房间 + 伸入室内的死端短墙 stub（挂在 w1 中点）
function rectWithStub() {
  return [...rectWalls(), { id: 'stub', start: [2, 0], end: [2, 1], height: 2.8, thickness: 0.2 }];
}

// 贯通 T：w1 为宿主，w5 分隔出左右两个房间
function tWalls() {
  return [
    { id: 'w1', start: [0, 0], end: [6, 0], height: 2.8, thickness: 0.2 },
    { id: 'w6', start: [0, 0], end: [0, 2], height: 2.8, thickness: 0.2 },
    { id: 'w5', start: [3, 0], end: [3, 2], height: 2.8, thickness: 0.2 },
    { id: 'w7', start: [0, 2], end: [3, 2], height: 2.8, thickness: 0.2 },
    { id: 'w8', start: [3, 2], end: [6, 2], height: 2.8, thickness: 0.2 },
    { id: 'w9', start: [6, 0], end: [6, 2], height: 2.8, thickness: 0.2 },
  ];
}

// X 十字：水平 h、垂直 v 贯穿外圈，分出四个房间
function xWalls() {
  return [
    { id: 'h', start: [-2, 1], end: [2, 1], height: 2.8, thickness: 0.2 },
    { id: 'v', start: [0, -1], end: [0, 3], height: 2.8, thickness: 0.2 },
    { id: 'n', start: [-2, -1], end: [2, -1], height: 2.8, thickness: 0.2 },
    { id: 's', start: [-2, 3], end: [2, 3], height: 2.8, thickness: 0.2 },
    { id: 'w', start: [-2, -1], end: [-2, 3], height: 2.8, thickness: 0.2 },
    { id: 'e', start: [2, -1], end: [2, 3], height: 2.8, thickness: 0.2 },
  ];
}

const keysOf = walls => detectRooms(walls).rooms.map(r => r.key).sort();

// ---------- 键生成与规范化 ----------

test('canonicalWallKey：循环起点、正反向规范化，相邻重复墙 ID 只留一个', () => {
  assert.equal(canonicalWallKey(['w1', 'w2', 'w3']), 'w1|w2|w3');
  assert.equal(canonicalWallKey(['w3', 'w1', 'w2']), 'w1|w2|w3'); // 旋转等价
  assert.equal(canonicalWallKey(['w3', 'w2', 'w1']), 'w1|w2|w3'); // 反向等价
  assert.equal(canonicalWallKey(['w1', 'w1', 'w2']), 'w1|w2');     // 相邻去重（墙被切分）
  assert.equal(canonicalWallKey(['w1', 'w2', 'w3', 'w1']), 'w1|w2|w3'); // 环状相邻（起点落在墙中部）
});

test('assignRoomKeys：重复键追加 #2/#3 后缀消歧，不静默覆盖', () => {
  assert.deepEqual(assignRoomKeys(['k1', 'k2', 'k1', 'k1', null]), ['k1', 'k2', 'k1#2', 'k1#3', null]);
  assert.deepEqual(assignRoomKeys(['a', 'b']), ['a', 'b']); // 无冲突原样返回
});

test('房间键为围墙 ID 序列：墙数组顺序、墙方向变化时键保持一致', () => {
  const base = keysOf(rectWalls());
  assert.equal(base.length, 1);
  // 墙数组顺序打乱
  const shuffled = [rectWalls()[2], rectWalls()[0], rectWalls()[3], rectWalls()[1]];
  assert.deepEqual(keysOf(shuffled), base);
  // 两堵墙方向翻转（start/end 互换）
  const flipped = rectWalls().map(w => (
    w.id === 'w2' || w.id === 'w3' ? { ...w, start: w.end, end: w.start } : w
  ));
  assert.deepEqual(keysOf(flipped), base);
});

test('移动墙身、调整墙长、拖动端点后房间键不变', () => {
  const base = keysOf(rectWalls());
  // 墙身平移：整圈外扩 1m（拓扑不变）
  const moved = rectWalls().map(w => ({ ...w, start: [w.start[0] + 1, w.start[1] + 1], end: [w.end[0] + 1, w.end[1] + 1] }));
  assert.deepEqual(keysOf(moved), base);
  // 调整墙长：w1 延长到 5m，w2/w3 端点跟随（房间变长，围墙关系不变）
  const longer = rectWalls().map(w => (
    w.id === 'w1' ? { ...w, end: [5, 0] }
      : w.id === 'w2' ? { ...w, start: [5, 0] }
        : w.id === 'w3' ? { ...w, start: [5, 3] } : w
  ));
  assert.deepEqual(keysOf(longer), base);
});

test('T 型两房间键不同；X 型四个房间键互不相同', () => {
  const t = detectRooms(tWalls());
  assert.equal(t.rooms.length, 2);
  assert.notEqual(t.rooms[0].key, t.rooms[1].key);
  const x = detectRooms(xWalls());
  assert.equal(x.rooms.length, 4);
  assert.equal(new Set(x.rooms.map(r => r.key)).size, 4);
});

test('T/X 型墙面左右房间归属正确（segRooms 使用墙 ID 键）', () => {
  const t = detectRooms(tWalls());
  const [ka, kb] = t.rooms.map(r => r.key).sort();
  const w1segs = t.segRooms.get('w1');
  assert.equal(w1segs.length, 2); // 宿主墙在 T 接点切分
  const sides = w1segs.map(s => [s.left, s.right]).flat().filter(Boolean).sort();
  assert.deepEqual(sides, [ka, kb]); // 两侧各归属一个房间
  // stem 墙两面分属两个房间
  const stemSegs = t.segRooms.get('w5');
  assert.ok(stemSegs.every(s => (s.left === ka && s.right === kb) || (s.left === kb && s.right === ka)));

  const x = detectRooms(xWalls());
  for (const wid of ['h', 'v']) {
    const segs = x.segRooms.get(wid);
    assert.equal(segs.length, 2);
    const roomSides = segs.map(s => [s.left, s.right]).flat().filter(Boolean);
    assert.equal(new Set(roomSides).size, 4); // 四个房间都出现在这两面墙的两侧
  }
});

// ---------- v3 → v4 迁移 ----------

// 最小可校验的 v3 数据（矩形房间 + 墙 ID 键迁移用旧字段）
function v3TextWithRooms() {
  const coordKey = detectRooms(rectWalls()).rooms[0].coordKey;
  return JSON.stringify({
    version: 3,
    walls: rectWalls(),
    nodes: [],
    wires: [],
    links: [],
    doors: [],
    roomNames: { [coordKey]: '客厅', '0.000,0.000|9.999,0.000|9.999,9.999': '失效房间' },
    roomLabelPos: { [coordKey]: [0.6, 0.5] },
    roomNameHints: ['卧室'],
  });
}

test('v3 迁移：名称与标签位置合并进 rooms，失效旧记录被清理', () => {
  const data = parseJsonText(v3TextWithRooms());
  assert.equal(data.version, 4);
  assert.ok(!('roomNames' in data) && !('roomLabelPos' in data));
  const key = detectRooms(rectWalls()).rooms[0].key;
  assert.equal(key, 'w1|w2|w3|w4');
  // 名称合并；标签 [0.6,0.5] 相对质心（矩形质心=盒中心）→ offsetx=0.1、offsety 缺省
  assert.deepEqual(data.rooms[key], { name: '客厅', offsetx: 0.1 });
  assert.equal(Object.keys(data.rooms).length, 1); // 失效记录被丢弃
  assert.equal(validateData(data), null);
});

test('v3 迁移后标签位置换算正确：新结构下 roomLabelPoint 与旧坐标一致', () => {
  const data = parseJsonText(v3TextWithRooms());
  const room = detectRooms(rectWalls()).rooms[0];
  const [x, z] = roomLabelPoint(room, data);
  const b = roomBBox(room);
  // 旧坐标 [0.6,0.5] 即包围盒内 (minX+0.6w, minZ+0.5d)
  assert.ok(Math.abs(x - (b.minX + 0.6 * b.w)) < 1e-9);
  assert.ok(Math.abs(z - (b.minZ + 0.5 * b.d)) < 1e-9);
});

test('v4 JSON 导入导出往返一致，不再出现旧字段', () => {
  const once = parseJsonText(v3TextWithRooms());
  const text = JSON.stringify(once);
  assert.ok(!text.includes('roomNames'));
  assert.ok(!text.includes('roomLabelPos'));
  assert.ok(text.includes('"version": 4') || text.includes('"version":4'));
  const twice = parseJsonText(text);
  assert.deepEqual(twice, once); // 重复迁移幂等
});

test('v4 直接导入：rooms 记录校验（name 类型、偏移有限数值）', () => {
  const good = parseJsonText(v3TextWithRooms());
  const text = JSON.stringify(good);
  const badName = JSON.parse(text);
  badName.rooms['w1|w2|w3|w4'].name = 42;
  assert.throws(() => parseJsonText(JSON.stringify(badName)), /name 必须是字符串/);
  const badOff = JSON.parse(text);
  badOff.rooms['w1|w2|w3|w4'].offsetx = '0.1';
  assert.throws(() => parseJsonText(JSON.stringify(badOff)), /offsetx 必须是有限数值/);
  // rooms 缺省/非对象时按 doors 同款宽容策略补空对象，不拒绝
  const noRooms = JSON.parse(text);
  delete noRooms.rooms;
  assert.deepEqual(parseJsonText(JSON.stringify(noRooms)).rooms, {});
  const arrRooms = JSON.parse(text);
  arrRooms.rooms = [];
  assert.deepEqual(parseJsonText(JSON.stringify(arrRooms)).rooms, {});
});

// ---------- 统一访问入口 ----------

test('getRoomRecord/ensureRoomRecord/pruneRoomRecord：名称与偏移互不破坏', () => {
  const data = { rooms: {} };
  const key = 'w1|w2|w3|w4';
  assert.equal(getRoomRecord(data, key), null);
  const rec = ensureRoomRecord(data, key);
  rec.name = '客厅';
  rec.offsetx = 0.1;
  // 模拟面板“清空名称”：只删 name，保留偏移
  const r = getRoomRecord(data, key);
  delete r.name;
  pruneRoomRecord(data, key);
  assert.deepEqual(data.rooms[key], { offsetx: 0.1 });
  assert.deepEqual(roomLabelPoint(detectRooms(rectWalls()).rooms[0], data),
    roomLabelPoint(detectRooms(rectWalls()).rooms[0], { rooms: { [key]: { offsetx: 0.1 } } }));
  // 偏移也删除后记录整体移除
  delete data.rooms[key].offsetx;
  pruneRoomRecord(data, key);
  assert.equal(data.rooms[key], undefined);
});

test('resolveRoomNames：显式命名优先，hint 按面积降序分配并写入 rooms', () => {
  const walls = tWalls();
  const rooms = detectRooms(walls).rooms;
  const data = { rooms: {}, roomNameHints: ['大房间', '小房间'] };
  const names = resolveRoomNames(data, rooms);
  // 面积大的先拿 hint：左 3×2=6、右 3×2=6 同面积时按 detectRooms 顺序（已按面积排序，稳定）
  const got = [...names.values()].sort();
  assert.deepEqual(got, ['大房间', '小房间']);
  // hint 分配落进 rooms 记录，导出即显式命名
  for (const room of rooms) assert.ok(data.rooms[room.key].name);
  // 已有显式命名的房间不参与 hint 分配
  const data2 = { rooms: { [rooms[0].key]: { name: '书房' } }, roomNameHints: ['大房间', '小房间'] };
  const names2 = resolveRoomNames(data2, rooms);
  assert.equal(names2.get(rooms[0].key), '书房');
});

// ---------- 增删墙后的数据继承 ----------

test('移动墙（键不变）不产生重复记录，名称与偏移原样保留', () => {
  const data = { rooms: {} };
  const key = detectRooms(rectWalls()).rooms[0].key;
  data.rooms[key] = { name: '客厅', offsetx: 0.1 };
  const before = detectRooms(rectWalls()).rooms;
  // 整圈平移后键不变：reconcile 为 no-op，rooms 依旧只有一条记录
  const moved = rectWalls().map(w => ({ ...w, start: [w.start[0] + 1, w.start[1]], end: [w.end[0] + 1, w.end[1]] }));
  const after = detectRooms(moved).rooms;
  reconcileRooms(data, before, after);
  assert.deepEqual(Object.keys(data.rooms), [key]);
  assert.deepEqual(data.rooms[key], { name: '客厅', offsetx: 0.1 });
});

test('删除死端短墙：房间键变化但围墙交集唯一明确，名称与偏移继承', () => {
  const data = { rooms: {} };
  const before = detectRooms(rectWithStub()).rooms;
  const oldKey = before[0].key;
  assert.ok(oldKey.includes('stub'));
  data.rooms[oldKey] = { name: '客厅', offsetx: 0.1, offsety: -0.1 };
  const after = detectRooms(rectWalls()).rooms;
  reconcileRooms(data, before, after);
  const newKey = after[0].key;
  assert.equal(newKey, 'w1|w2|w3|w4');
  assert.deepEqual(data.rooms[newKey], { name: '客厅', offsetx: 0.1, offsety: -0.1 });
  assert.equal(data.rooms[oldKey], undefined);
});

test('新增隔墙拆分房间：一对多继承有歧义，不猜测、回默认名', () => {
  const data = { rooms: {} };
  const before = detectRooms(rectWalls()).rooms;
  data.rooms[before[0].key] = { name: '客厅' };
  // 加贯通隔墙 w5 [2,0]→[2,3] 拆成两个房间
  const divided = [...rectWalls(), { id: 'w5', start: [2, 0], end: [2, 3], height: 2.8, thickness: 0.2 }];
  const after = detectRooms(divided).rooms;
  assert.equal(after.length, 2);
  reconcileRooms(data, before, after);
  assert.deepEqual(data.rooms, {}); // 旧记录随房间消失清理，两个新房间都无继承
});

test('删除隔墙合并房间：多对一继承有歧义，不猜测', () => {
  const divided = [...rectWalls(), { id: 'w5', start: [2, 0], end: [2, 3], height: 2.8, thickness: 0.2 }];
  const before = detectRooms(divided).rooms;
  const data = { rooms: {} };
  data.rooms[before[0].key] = { name: '左间' };
  data.rooms[before[1].key] = { name: '右间' };
  const after = detectRooms(rectWalls()).rooms;
  reconcileRooms(data, before, after);
  assert.deepEqual(data.rooms, {});
});

test('相邻房间只隔一面分隔壁：记录缺失时不得互串（互不包含）', () => {
  // 回归场景：贯通隔墙分出左右两间，墙集只差一面（w4 vs w2）——
  // 清空名称使左间记录消失后 reconcile，绝不能把右间的记录继承给左间
  const divided = [...rectWalls(), { id: 'w5', start: [2, 0], end: [2, 3], height: 2.8, thickness: 0.2 }];
  const rooms = detectRooms(divided).rooms;
  const data = { rooms: {} };
  for (const r of rooms) data.rooms[r.key] = { name: r.wallIds.includes('w4') ? '左间' : '右间' };
  const leftKey = rooms.find(r => r.wallIds.includes('w4')).key;
  const rightKey = rooms.find(r => r.wallIds.includes('w2')).key;
  // 模拟"清空名称"：记录被 prune 删除，户型未变
  delete data.rooms[leftKey];
  reconcileRooms(data, rooms, rooms);
  assert.equal(data.rooms[leftKey], undefined); // 左间回默认名（hint 另行分配），不继承右间
  assert.deepEqual(data.rooms[rightKey], { name: '右间' }); // 右间不受影响
});

test('相邻房间只共享 T 接点宿主墙/分隔壁：挂死端短墙不互相串名', () => {
  // 回归场景：左间/右间共享宿主墙 w1 与分隔壁 w5；给 w1 中点挂短墙后
  // 两间键都变但边界几乎照旧，各自继承原名，不能误配到相邻房间
  const base = tWalls();
  const before = detectRooms(base).rooms;
  const data = { rooms: {} };
  for (const r of before) data.rooms[r.key] = { name: `名-${r.wallIds.includes('w6') ? '左' : '右'}` };
  const withStub = [...base, { id: 'stub', start: [1.5, 0], end: [1.5, 0.8], height: 2.8, thickness: 0.2 }];
  const after = detectRooms(withStub).rooms;
  assert.equal(after.length, 2);
  reconcileRooms(data, before, after);
  assert.equal(Object.keys(data.rooms).length, 2);
  for (const r of after) {
    const tag = r.wallIds.includes('w6') ? '左' : '右';
    assert.equal(data.rooms[r.key].name, `名-${tag}`);
  }
});

test('已消失的房间记录被清理；未变化的其他房间记录不受影响', () => {
  const t = tWalls();
  const before = detectRooms(t).rooms;
  const data = { rooms: {} };
  for (const r of before) data.rooms[r.key] = { name: `房间-${r.key}` };
  // 删掉右侧房间的外墙 w9：右间消失，左间不变
  const after = detectRooms(t.filter(w => w.id !== 'w9')).rooms;
  reconcileRooms(data, before, after);
  const leftKey = before.find(r => r.wallIds.includes('w6')).key;
  assert.deepEqual(data.rooms, { [leftKey]: { name: `房间-${leftKey}` } });
});

// ---------- 默认户型端到端 ----------

test('默认户型 v4：每个房间至多一条 rooms 记录，3D/2D/面板共用同一显示名与位置', () => {
  const data = parseJsonText(readFileSync(new URL('../data/default.json', import.meta.url), 'utf8'));
  assert.equal(data.version, 4);
  const rooms = detectRooms(data.walls).rooms;
  for (const room of rooms) {
    assert.ok(Object.keys(data.rooms).filter(k => k === room.key).length <= 1);
    assert.equal(typeof roomLabelUV(room, data)[0], 'number');
  }
  const names = resolveRoomNames(data, rooms);
  for (const room of rooms) assert.ok(names.get(room.key));
});
