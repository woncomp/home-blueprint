// 入口：装配各模块、查看/电路编辑/户型编辑三模式切换、3D 交互、编辑操作
import * as THREE from 'three';
import { Scene3D } from './scene3d.js';
import { Panel } from './panel.js';
import { WallFaceDialog } from './wallface.js';
import { Plan2D } from './plan2d.js';
import { loadDefaultData, parseJsonText, exportJsonText } from './persistence.js';
import { JsonDialog } from './json-dialog.js';
import { DEVICE_TYPES, createBreakerBox, createNode, wallLen, wallDir, genId, findBreakerBox, breakerTerminalHeight, breakerTerminalPosDelta } from './model.js';

const canvas = document.getElementById('scene-canvas');
const planSvg = document.getElementById('plan-svg');
const scene3d = new Scene3D(canvas);
const dataProvider = () => app.data;

const app = {
  data: null,
  mode: null,          // 'view' | 'edit' | 'plan'
  selection: null,
  draggingBox: false,
};

const panel = new Panel(dataProvider);
const wallface = new WallFaceDialog({
  onChange: refresh,
  onSelect: sel => { app.selection = sel; scene3d.setSelection(sel); refreshPanel(); },
  onNotify: toast,
  onClose: () => {},
});
const plan2d = new Plan2D({
  svg: planSvg,
  tools: {
    select: document.getElementById('plan-tool-select'),
    ortho: document.getElementById('plan-tool-ortho'),
    free: document.getElementById('plan-tool-free'),
    door: document.getElementById('plan-tool-door'),
    del: document.getElementById('plan-tool-delete'),
    fit: document.getElementById('plan-fit'),
  },
  hintEl: document.getElementById('plan-hint'),
  dataProvider,
  onChange: refresh,
  onSelect: sel => { app.selection = sel; scene3d.setSelection(sel); refreshPanel(); refreshToolbar(); },
  onNotify: toast,
  onDeleteWall: deleteWallById,
  onDeleteDoor: deleteDoorById,
  onWallAdded: wall => {
    // 首堵墙创建后自动在墙中点建立强电箱（特殊设备节点）；pos 为 0~1 归一化坐标
    if (!findBreakerBox(app.data)) {
      app.data.nodes.push(createBreakerBox(wall.id, 1, 0.5));
    }
  },
});

// ---------- 刷新 ----------
function refresh() {
  syncTerminals();
  scene3d.updateData(app.data);
  refreshPanel();
  refreshToolbar();
  plan2d.refresh();
}

function refreshPanel() {
  panel.update(app.data, scene3d.circuits, app.selection, app.mode, scene3d.rooms);
}

function refreshToolbar() {
  const isDeletable = app.selection && ['node', 'wire'].includes(app.selection.kind);
  document.getElementById('btn-delete-entity').disabled = !(app.mode === 'edit' && isDeletable);
  document.getElementById('edit-hint').textContent =
    app.mode === 'edit' ? '点击墙面展开 2D 视图编辑电路；选中强电箱后可沿墙拖动' : '';
}

// ---------- 模式切换 ----------
function setMode(mode) {
  if (app.mode === mode) { refreshToolbar(); refreshPanel(); return; }
  const prev = app.mode;
  app.mode = mode;

  if (mode === 'plan') {
    // 进入户型编辑：禁用 3D 控制器，切换到 2D 顶视图并自动适应
    scene3d.controls.cancelPan();
    scene3d.controls.enabled = false;
    hideNodeTooltip();
    app.selection = null;
    scene3d.setSelection(null);
    canvas.classList.add('hidden');
    planSvg.classList.remove('hidden');
    plan2d.activate();
  } else {
    if (prev === 'plan') {
      // 返回 3D：重建场景并正确 resize；清理户型编辑的选中状态
      plan2d.deactivate();
      planSvg.classList.add('hidden');
      canvas.classList.remove('hidden');
      scene3d.controls.enabled = true;
      if (app.selection && ['wall', 'door'].includes(app.selection.kind)) app.selection = null;
      scene3d.setSelection(app.selection);
      scene3d.updateData(app.data);
      scene3d.resize();
    }
    scene3d.setMode(mode);
  }

  document.getElementById('btn-view-mode').classList.toggle('active', mode === 'view');
  document.getElementById('btn-edit-mode').classList.toggle('active', mode === 'edit');
  document.getElementById('btn-plan-mode').classList.toggle('active', mode === 'plan');
  document.getElementById('edit-tools').classList.toggle('hidden', mode !== 'edit');
  document.getElementById('plan-tools').classList.toggle('hidden', mode !== 'plan');
  document.getElementById('overlay-hint').firstElementChild.textContent =
    mode === 'view'
      ? 'WASD 平移视点 · 左键拖动旋转 · 中键拖动平移（松手惯性滑动）· 滚轮缩放 · 点击墙上对象选中 · 点击墙面展开 2D'
      : mode === 'edit'
        ? 'WASD 平移视点 · 左键拖动旋转 · 中键拖动平移（松手惯性滑动）· 滚轮缩放 · 点击墙上对象选中 · 点击墙面展开 2D 编辑'
        : '滚轮缩放 · 空白处拖动平移 · 单击选中，拖动墙身/端点编辑 · 按住 Alt 关闭吸附 · Esc 取消';
  if (wallface.isOpen()) wallface.close();
  refreshToolbar();
  refreshPanel();
}

document.getElementById('btn-view-mode').addEventListener('click', () => setMode('view'));
document.getElementById('btn-edit-mode').addEventListener('click', () => setMode('edit'));
document.getElementById('btn-plan-mode').addEventListener('click', () => setMode('plan'));

// ---------- 工具栏 ----------
document.getElementById('plan-tool-select').addEventListener('click', () => plan2d.setTool('select'));
document.getElementById('plan-tool-ortho').addEventListener('click', () => plan2d.setTool('ortho'));
document.getElementById('plan-tool-free').addEventListener('click', () => plan2d.setTool('free'));
document.getElementById('plan-tool-door').addEventListener('click', () => plan2d.setTool('door'));
document.getElementById('plan-tool-delete').addEventListener('click', () => plan2d.setTool('delete'));
document.getElementById('plan-fit').addEventListener('click', () => plan2d.fitView());
document.getElementById('btn-delete-entity').addEventListener('click', deleteSelectedEntity);
document.getElementById('chk-room-label-floor').addEventListener('change', e => {
  scene3d.setRoomLabelMode(e.target.checked);
});
// ---------- 查看 JSON ----------
// 唯一的数据提交点：整体替换布局并按原导入成功流程刷新。
// 调用方必须先通过 parseJsonText 完成“解析 → 迁移 → 校验”，失败时不得进入本函数，
// 因此不会出现先清空选择、部分刷新或替换一半数据的情况
function applyData(data) {
  app.data = data;
  syncTerminals();
  app.selection = null;
  scene3d.setSelection(null);
  plan2d.setSelection(null);
  scene3d.setData(data);
  if (app.mode === 'plan') plan2d.fitView(); // 换入新数据时自动适应一次
  refreshPanel();
  refreshToolbar();
}

const jsonDialog = new JsonDialog({
  onApply: text => {
    const data = parseJsonText(text); // 解析/校验失败抛错，不会走到 applyData
    applyData(data);
    toast('JSON 应用成功');
  },
  onSave: text => {
    exportJsonText(text);
    toast('已保存 JSON 文件');
  },
});

document.getElementById('btn-view-json').addEventListener('click', () => {
  syncTerminals(); // 与原“导出 JSON”一致：先同步端子，保证展示内容与导出行为相同
  jsonDialog.open(JSON.stringify(app.data, null, 2));
});

// ---------- 面板事件 ----------
panel.on('edited', () => refresh());
panel.on('highlightCircuit', idx => scene3d.setHighlight(idx));
panel.on('wallLength', ({ id, len }) => plan2d.setWallLength(id, len));
panel.on('doorWidth', ({ id, width }) => plan2d.setDoorWidth(id, width));
panel.on('doorFlip', id => { plan2d.flipDoor(id); refreshPanel(); });
panel.on('addBreaker', () => {
  const box = findBreakerBox(app.data);
  if (!box) return;
  const node = createNode('terminal', box.wall, box.face, box.pos, box.height);
  node.label = '强电箱端子';
  app.data.nodes.push(node);
  box.breakers.push({ id: genId('b'), label: `断路器 ${box.breakers.length + 1}`, terminal: node.id });
  refresh();
});
panel.on('deleteWire', id => {
  app.data.wires = app.data.wires.filter(w => w.id !== id);
  if (app.selection && app.selection.kind === 'wire' && app.selection.id === id) app.selection = null;
  refresh();
});
panel.on('deleteNode', id => deleteNodeById(id));

// ---------- 删除操作 ----------
function deleteNodeById(id) {
  const node = app.data.nodes.find(n => n.id === id);
  if (!node) return;
  // 墙面 2D 展开期间：右侧面板/全局删除同样只允许当前活动墙段
  if (wallface.isOpen() && !wallface.isActiveNode(node)) {
    toast('墙面展开中：只能删除当前墙面的设备（先在 2D 视图「设为当前墙」）', true);
    return;
  }
  if (node.type === 'terminal') { toast('强电箱端子不能单独删除，请删除所属断路器', true); return; }
  if (node.deviceType === 'breakerBox') { toast('强电箱不能删除', true); return; }
  app.data.nodes = app.data.nodes.filter(n => n.id !== id);
  app.data.wires = app.data.wires.filter(w => w.from !== id && w.to !== id);
  app.data.links = (app.data.links || []).filter(l => l.a !== id && l.b !== id);
  if (app.selection && app.selection.kind === 'node' && app.selection.id === id) app.selection = null;
  refresh();
}

function deleteSelectedEntity() {
  const sel = app.selection;
  if (!sel) return;
  if (sel.kind === 'node') deleteNodeById(sel.id);
  else if (sel.kind === 'wire') {
    app.data.wires = app.data.wires.filter(w => w.id !== sel.id);
    app.selection = null;
    refresh();
  }
}

// 删除墙：级联清理墙上的节点、门、相关电线与连通；强电箱所在墙禁止删除
function deleteWallById(id) {
  const box = findBreakerBox(app.data);
  if (box && box.wall === id) { toast('强电箱所在的墙不能删除', true); return; }
  const nodeIds = new Set(app.data.nodes.filter(n => n.wall === id).map(n => n.id));
  app.data.nodes = app.data.nodes.filter(n => !nodeIds.has(n.id));
  app.data.wires = app.data.wires.filter(w => !nodeIds.has(w.from) && !nodeIds.has(w.to));
  app.data.links = (app.data.links || []).filter(l => !nodeIds.has(l.a) && !nodeIds.has(l.b));
  app.data.doors = (app.data.doors || []).filter(d => d.wall !== id);
  app.data.walls = app.data.walls.filter(w => w.id !== id);
  if (app.selection && app.selection.kind === 'wall' && app.selection.id === id) {
    app.selection = null;
    scene3d.setSelection(null);
    plan2d.setSelection(null);
  }
  refresh();
  toast('墙已删除');
}

function deleteDoorById(id) {
  app.data.doors = (app.data.doors || []).filter(d => d.id !== id);
  if (app.selection && app.selection.kind === 'door' && app.selection.id === id) {
    app.selection = null;
    plan2d.setSelection(null);
  }
  refresh();
  toast('门已删除');
}

// ---------- 强电箱端子同步 ----------
// 端子高度按断路器数量在箱体垂直范围内均分：每条线路占 1 权重，两端各预留 0.5 权重，避免出线重叠
function syncTerminals() {
  const box = findBreakerBox(app.data);
  if (!box) return;
  const n = box.breakers.length;
  const wall = app.data.walls.find(w => w.id === box.wall);
  const L = wall ? wallLen(wall) : 0;
  box.breakers.forEach((br, i) => {
    const node = app.data.nodes.find(x => x.id === br.terminal);
    if (!node) return;
    node.wall = box.wall;
    node.face = box.face;
    // 端子横向位置跟随线路出线方向（箱体左/右边缘）
    const delta = breakerTerminalPosDelta(br.side);
    node.pos = L > 0 ? Math.min(1, Math.max(0, box.pos + delta / L)) : box.pos;
    node.height = breakerTerminalHeight(i, n, box.height);
  });
}

// ---------- 3D 画布交互 ----------
let mouseDownPos = null;

canvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return; // 中键用于平移视点、右键无点击行为，均不进入点击/拖拽判定
  mouseDownPos = { x: e.clientX, y: e.clientY };
  hideNodeTooltip(); // 拖拽旋转/拖动强电箱期间不残留 tooltip
  // 强电箱拖动（特殊设备节点）
  if (app.mode === 'edit' && app.selection && app.selection.kind === 'node') {
    const selNode = app.data.nodes.find(n => n.id === app.selection.id);
    if (selNode && selNode.deviceType === 'breakerBox') {
      const hit = scene3d.pick(e.clientX, e.clientY);
      if (hit && hit.kind === 'node' && hit.id === selNode.id) app.draggingBox = true;
    }
  }
});

window.addEventListener('mousemove', e => {
  if (app.draggingBox) {
    const box = findBreakerBox(app.data);
    if (!box) return;
    const wall = app.data.walls.find(w => w.id === box.wall);
    if (!wall) return;
    const p = new THREE.Vector3();
    if (!scene3d.groundPoint(e.clientX, e.clientY, p)) return;
    // 投影到墙线，写回 0~1 归一化坐标（距墙端至少 0.3m）
    const L = wallLen(wall);
    const [dx, dz] = wallDir(wall);
    const rx = p.x - wall.start[0], rz = p.z - wall.start[1];
    const t = Math.min(L - 0.3, Math.max(0.3, rx * dx + rz * dz));
    box.pos = Math.round((t / L) * 10000) / 10000;
    syncTerminals();
    scene3d.updateData(app.data);
  } else if (!wallface.isOpen() && app.mode !== 'plan' && e.buttons === 0) {
    const hit = scene3d.pick(e.clientX, e.clientY);
    scene3d.setHover(hit && ['wall', 'node', 'wire'].includes(hit.kind) ? hit : null);
    // 悬停到电气设备时在指针旁显示名称；端子/端点等非设备节点不显示
    const node = hit && hit.kind === 'node' ? app.data.nodes.find(n => n.id === hit.id) : null;
    if (node && node.type === 'device') showNodeTooltip(node, e.clientX, e.clientY);
    else hideNodeTooltip();
  }
});

canvas.addEventListener('mouseleave', () => { scene3d.setHover(null); hideNodeTooltip(); });

window.addEventListener('mouseup', e => {
  if (app.draggingBox) {
    app.draggingBox = false;
    refresh();
    return;
  }
  if (e.button !== 0) return;
  if (!mouseDownPos) return;
  const moved = Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y);
  mouseDownPos = null;
  if (moved > 5) return; // 视为拖动旋转
  handleCanvasClick(e);
});

function handleCanvasClick(e) {
  if (wallface.isOpen() || app.mode === 'plan') return;
  const hit = scene3d.pick(e.clientX, e.clientY);
  // 点击墙面 → 直接展开该面 2D 视图（面范围段：T/X 拆分只作用于被接触的一面，
  // 未被接触的一面整面一个范围，可整墙展开）
  if (hit && hit.kind === 'wall') {
    scene3d.setHover(null);
    hideNodeTooltip();
    wallface.open(app.data, hit.id, hit.face, app.mode, hit.seg);
    return;
  }
  app.selection = hit;
  scene3d.setSelection(hit);
  refreshPanel();
  refreshToolbar();
}

// ---------- 设备悬停 tooltip ----------
// 单例元素，随 mousemove 更新位置；pointer-events:none 不干扰 3D 拾取
const nodeTooltip = document.createElement('div');
nodeTooltip.className = 'node-tooltip';
document.body.appendChild(nodeTooltip);

function showNodeTooltip(node, x, y) {
  const type = DEVICE_TYPES[node.deviceType] || {};
  // 强电箱 label 固定为“强电箱”，避免与类型名重复
  const text = node.deviceType === 'breakerBox'
    ? type.name
    : type.name + (node.label ? ' · ' + node.label : '');
  nodeTooltip.textContent = text;
  nodeTooltip.style.display = 'block';
  // 默认显示在指针右下方，靠近屏幕右/下边缘时翻转到左/上方
  const w = nodeTooltip.offsetWidth, h = nodeTooltip.offsetHeight;
  const flipX = x + 14 + w > window.innerWidth;
  const flipY = y + 14 + h > window.innerHeight;
  nodeTooltip.style.left = (flipX ? x - w - 14 : x + 14) + 'px';
  nodeTooltip.style.top = (flipY ? y - h - 14 : y + 14) + 'px';
}

function hideNodeTooltip() {
  nodeTooltip.style.display = 'none';
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, isError = false) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.background = isError ? 'rgba(160,40,40,0.95)' : 'rgba(40,40,45,0.92)';
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

// ---------- 启动 ----------
window.__app = app;       // 调试句柄
window.__scene = scene3d;
window.__plan = plan2d;
window.__wallface = wallface;

(async function start() {
  app.data = await loadDefaultData();
  syncTerminals();
  scene3d.setData(app.data);
  setMode('view');

  let last = performance.now();
  function loop(now) {
    if (app.mode !== 'plan') scene3d.render((now - last) / 1000);
    last = now;
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
