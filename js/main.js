// 入口：装配各模块、查看/电路编辑/户型编辑三模式切换、3D 交互、编辑操作
import * as THREE from 'three';
import { Scene3D } from './scene3d.js';
import { Panel } from './panel.js';
import { WallFaceDialog } from './wallface.js';
import { Plan2D } from './plan2d.js';
import { loadDefaultData, exportJson, importJsonFile } from './persistence.js';
import { createBreakerBox, createNode, wallLen, wallDir, genId, findBreakerBox, segHasCircuit, BREAKER_BOX_SIZE } from './model.js';

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
  panel.update(app.data, scene3d.circuits, app.selection, app.mode);
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
    scene3d.controls.enabled = false;
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
      ? 'WASD 平移视点 · 左键拖动旋转 · 滚轮缩放 · 点击墙上对象选中 · 点击有电路的墙面展开 2D'
      : mode === 'edit'
        ? 'WASD 平移视点 · 左键拖动旋转 · 滚轮缩放 · 点击墙上对象选中 · 点击墙面展开 2D 编辑'
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
document.getElementById('btn-export').addEventListener('click', () => {
  syncTerminals();
  exportJson(app.data);
  toast('已导出 JSON 文件');
});
document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('file-input').click();
});
document.getElementById('file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = await importJsonFile(file);
    app.data = data;
    app.selection = null;
    scene3d.setSelection(null);
    plan2d.setSelection(null);
    scene3d.setData(data);
    if (app.mode === 'plan') plan2d.fitView(); // 导入新数据时自动适应一次
    refreshPanel();
    refreshToolbar();
    toast('导入成功');
  } catch (err) {
    toast('导入失败: ' + err.message, true);
  }
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
// 端子高度按断路器数量在箱体垂直范围内均分（上下各留 0.06m 边距），避免出线重叠
function syncTerminals() {
  const box = findBreakerBox(app.data);
  if (!box) return;
  const n = box.breakers.length;
  const span = BREAKER_BOX_SIZE.h / 2 - 0.06;
  box.breakers.forEach((br, i) => {
    const node = app.data.nodes.find(x => x.id === br.terminal);
    if (!node) return;
    node.wall = box.wall;
    node.face = box.face;
    node.pos = box.pos;
    node.height = n <= 1 ? box.height : box.height - span + 2 * span * (i / (n - 1));
  });
}

// ---------- 3D 画布交互 ----------
let mouseDownPos = null;

// 查看模式下：没有任何电路的墙不可展开 2D、也没有 hover 预览；
// 强电箱是特殊设备，所在墙始终可查看；墙被派生拆分时按逻辑墙段判断
function wallPickableInView(hit) {
  if (app.mode !== 'view' || hit.kind !== 'wall') return true;
  if (hit.seg && segHasCircuit(app.data, scene3d.circuits, hit.seg)) return true;
  if (!hit.seg && scene3d.circuits.wallsWithCircuit.has(hit.id)) return true;
  const box = findBreakerBox(app.data);
  if (!box || box.wall !== hit.id) return false;
  return !hit.seg || (box.pos >= hit.seg.t0 - 1e-9 && box.pos <= hit.seg.t1 + 1e-9);
}

canvas.addEventListener('mousedown', e => {
  mouseDownPos = { x: e.clientX, y: e.clientY };
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
    scene3d.setHover(hit && wallPickableInView(hit) && ['wall', 'node', 'wire'].includes(hit.kind) ? hit : null);
  }
});

canvas.addEventListener('mouseleave', () => scene3d.setHover(null));

window.addEventListener('mouseup', e => {
  if (app.draggingBox) {
    app.draggingBox = false;
    refresh();
    return;
  }
  if (!mouseDownPos) return;
  const moved = Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y);
  mouseDownPos = null;
  if (moved > 5) return; // 视为拖动旋转
  handleCanvasClick(e);
});

function handleCanvasClick(e) {
  if (wallface.isOpen() || app.mode === 'plan') return;
  const rawHit = scene3d.pick(e.clientX, e.clientY);
  const hit = rawHit && wallPickableInView(rawHit) ? rawHit : null;
  // 点击墙面 → 直接展开该面 2D 视图（带逻辑墙段，被拆分的墙按段展开）
  if (hit && hit.kind === 'wall') {
    scene3d.setHover(null);
    wallface.open(app.data, hit.id, hit.face, app.mode, hit.seg);
    return;
  }
  app.selection = hit;
  scene3d.setSelection(hit);
  refreshPanel();
  refreshToolbar();
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
