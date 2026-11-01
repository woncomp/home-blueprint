// 入口：装配各模块、模式切换、3D 交互、编辑操作
import * as THREE from 'three';
import { Scene3D } from './scene3d.js';
import { Panel } from './panel.js';
import { WallFaceDialog } from './wallface.js';
import { loadDefaultData, exportJson, importJsonFile } from './persistence.js';
import {
  createWall, createBreakerBox, createNode, wallLen, wallDir, genId,
} from './model.js';

const canvas = document.getElementById('scene-canvas');
const scene3d = new Scene3D(canvas);
const dataProvider = () => app.data;

const app = {
  data: null,
  mode: 'view',
  selection: null,
  addWallPending: false,
  wallP1: null,
  draggingBox: false,
};

const panel = new Panel(dataProvider);
const wallface = new WallFaceDialog({
  onChange: refresh,
  onSelect: sel => { app.selection = sel; scene3d.setSelection(sel); refreshPanel(); },
  onNotify: toast,
  onClose: () => {},
});

// ---------- 刷新 ----------
function refresh() {
  syncTerminals();
  scene3d.updateData(app.data);
  refreshPanel();
  refreshToolbar();
}

function refreshPanel() {
  panel.update(app.data, scene3d.circuits, app.selection);
}

function refreshToolbar() {
  document.getElementById('btn-add-wall').classList.toggle('active-tool', app.addWallPending);
  const isWall = app.selection && app.selection.kind === 'wall';
  const isDeletable = app.selection && ['node', 'wire'].includes(app.selection.kind);
  document.getElementById('btn-delete-wall').disabled = !(app.mode === 'edit' && isWall);
  document.getElementById('btn-delete-entity').disabled = !(app.mode === 'edit' && isDeletable);
  const hint = document.getElementById('edit-hint');
  if (app.mode !== 'edit') hint.textContent = '';
  else if (app.addWallPending) hint.textContent = app.wallP1 ? '点击第二个端点完成画墙（Esc 取消）' : '点击地面放置墙的第一个端点';
  else hint.textContent = '';
}

// ---------- 模式切换 ----------
function setMode(mode) {
  app.mode = mode;
  app.addWallPending = false;
  app.wallP1 = null;
  scene3d.setMode(mode);
  document.getElementById('btn-view-mode').classList.toggle('active', mode === 'view');
  document.getElementById('btn-edit-mode').classList.toggle('active', mode === 'edit');
  document.getElementById('edit-tools').classList.toggle('hidden', mode !== 'edit');
  document.getElementById('overlay-hint').firstElementChild.textContent =
    mode === 'view'
      ? 'WASD 平移视点 · 左键拖动旋转 · 滚轮缩放 · 点击选中 · 双击墙面展开'
      : 'WASD 平移视点 · 左键拖动旋转 · 滚轮缩放 · 点击选中 · 双击墙面展开编辑';
  if (wallface.isOpen()) wallface.close();
  refreshToolbar();
  refreshPanel();
}

document.getElementById('btn-view-mode').addEventListener('click', () => setMode('view'));
document.getElementById('btn-edit-mode').addEventListener('click', () => setMode('edit'));

// ---------- 工具栏 ----------
document.getElementById('btn-add-wall').addEventListener('click', () => {
  app.addWallPending = !app.addWallPending;
  app.wallP1 = null;
  refreshToolbar();
});
document.getElementById('btn-delete-wall').addEventListener('click', deleteSelectedWall);
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
    scene3d.setData(data);
    refreshPanel();
    toast('导入成功');
  } catch (err) {
    toast('导入失败: ' + err.message, true);
  }
});
window.addEventListener('keydown', e => {
  if (e.code === 'Escape') {
    app.addWallPending = false;
    app.wallP1 = null;
    clearTempPreview();
    refreshToolbar();
  }
});

// ---------- 面板事件 ----------
panel.on('edited', () => refresh());
panel.on('highlightCircuit', idx => scene3d.setHighlight(idx));
panel.on('addBreaker', () => {
  const box = app.data.breakerBox;
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
panel.on('openWallFace', ({ wallId, face }) => {
  wallface.open(app.data, wallId, face, app.mode);
});

// ---------- 删除操作 ----------
function deleteNodeById(id) {
  const node = app.data.nodes.find(n => n.id === id);
  if (!node) return;
  if (node.type === 'terminal') { toast('强电箱端子不能单独删除，请删除所属断路器', true); return; }
  app.data.nodes = app.data.nodes.filter(n => n.id !== id);
  app.data.wires = app.data.wires.filter(w => w.from !== id && w.to !== id);
  app.data.links = (app.data.links || []).filter(l => l.a !== id && l.b !== id);
  if (app.selection && app.selection.kind === 'node' && app.selection.id === id) app.selection = null;
  refresh();
}

function deleteSelectedWall() {
  const sel = app.selection;
  if (!sel || sel.kind !== 'wall') return;
  const box = app.data.breakerBox;
  if (box && box.wall === sel.id) {
    toast('该墙承载强电箱，不能删除', true);
    return;
  }
  app.data.walls = app.data.walls.filter(w => w.id !== sel.id);
  app.data.nodes = app.data.nodes.filter(n => n.wall !== sel.id);
  // 清理引用被删节点的电线与连通
  const nodeIds = new Set(app.data.nodes.map(n => n.id));
  app.data.wires = app.data.wires.filter(w => nodeIds.has(w.from) && nodeIds.has(w.to));
  app.data.links = (app.data.links || []).filter(l => nodeIds.has(l.a) && nodeIds.has(l.b));
  app.selection = null;
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

// ---------- 强电箱端子同步 ----------
function syncTerminals() {
  const box = app.data.breakerBox;
  if (!box) return;
  for (const br of box.breakers) {
    const node = app.data.nodes.find(n => n.id === br.terminal);
    if (node) {
      node.wall = box.wall;
      node.face = box.face;
      node.pos = box.pos;
      node.height = box.height;
    }
  }
}

// ---------- 3D 画布交互 ----------
let mouseDownPos = null;
let lastClick = { time: 0, key: null };

canvas.addEventListener('mousedown', e => {
  mouseDownPos = { x: e.clientX, y: e.clientY };
  // 强电箱拖动
  if (app.mode === 'edit' && app.selection && app.selection.kind === 'breakerBox') {
    const hit = scene3d.pick(e.clientX, e.clientY);
    if (hit && hit.kind === 'breakerBox') app.draggingBox = true;
  }
});

window.addEventListener('mousemove', e => {
  if (app.draggingBox) {
    const box = app.data.breakerBox;
    const wall = app.data.walls.find(w => w.id === box.wall);
    if (!wall) return;
    const p = new THREE.Vector3();
    if (!scene3d.groundPoint(e.clientX, e.clientY, p)) return;
    // 投影到墙线
    const [dx, dz] = wallDir(wall);
    const rx = p.x - wall.start[0], rz = p.z - wall.start[1];
    let t = rx * dx + rz * dz;
    t = Math.min(wallLen(wall) - 0.3, Math.max(0.3, t));
    box.pos = Math.round(t * 100) / 100;
    syncTerminals();
    scene3d.updateData(app.data);
  } else if (app.addWallPending && app.wallP1 && app.mode === 'edit') {
    drawWallPreview(app.wallP1, e.clientX, e.clientY);
  } else if (app.mode === 'view' && !wallface.isOpen() && e.buttons === 0) {
    const hit = scene3d.pick(e.clientX, e.clientY);
    scene3d.setFaceHover(hit && hit.kind === 'wall' ? hit : null);
  }
});

canvas.addEventListener('mouseleave', () => scene3d.setFaceHover(null));

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
  if (wallface.isOpen()) return;
  if (app.mode === 'edit' && app.addWallPending) {
    const p = new THREE.Vector3();
    if (!scene3d.groundPoint(e.clientX, e.clientY, p)) return;
    if (!app.wallP1) {
      app.wallP1 = [Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100];
      refreshToolbar();
    } else {
      const p2 = [Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100];
      const len = Math.hypot(p2[0] - app.wallP1[0], p2[1] - app.wallP1[1]);
      if (len < 0.2) { toast('墙太短', true); return; }
      const wall = createWall(app.wallP1[0], app.wallP1[1], p2[0], p2[1]);
      app.data.walls.push(wall);
      // 保证强电箱存在：放到第一面墙的中点
      if (!app.data.breakerBox) {
        const box = createBreakerBox(wall.id, 1, Math.round((len / 2) * 100) / 100);
        app.data.breakerBox = box;
      }
      app.wallP1 = null;
      app.addWallPending = false;
      clearTempPreview();
      refresh();
      toast('墙已添加');
    }
    return;
  }

  const hit = scene3d.pick(e.clientX, e.clientY);
  app.selection = hit;
  scene3d.setSelection(hit);
  refreshPanel();
  refreshToolbar();

  // 双击墙 → 展开 2D 对话框
  if (hit && hit.kind === 'wall') {
    const key = hit.id + ':' + hit.face;
    const now = Date.now();
    if (lastClick.key === key && now - lastClick.time < 450) {
      wallface.open(app.data, hit.id, hit.face, app.mode);
      lastClick.time = 0;
      return;
    }
    lastClick = { time: now, key };
  } else {
    lastClick = { time: 0, key: null };
  }
}

// ---------- 画墙预览 ----------
function drawWallPreview(p1, clientX, clientY) {
  clearTempPreview();
  const p = new THREE.Vector3();
  if (!scene3d.groundPoint(clientX, clientY, p)) return;
  const len = Math.hypot(p.x - p1[0], p.z - p1[1]);
  if (len < 0.01) return;
  const geo = new THREE.BoxGeometry(len, 2.8, 0.2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.5 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set((p1[0] + p.x) / 2, 1.4, (p1[1] + p.z) / 2);
  mesh.rotation.y = -Math.atan2(p.z - p1[1], p.x - p1[0]);
  scene3d.tempGroup.add(mesh);
}

function clearTempPreview() {
  const g = scene3d.tempGroup;
  while (g.children.length) {
    const c = g.children.pop();
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
    g.remove(c);
  }
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

(async function start() {
  app.data = await loadDefaultData();
  scene3d.setData(app.data);
  setMode('view');

  let last = performance.now();
  function loop(now) {
    scene3d.render((now - last) / 1000);
    last = now;
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
