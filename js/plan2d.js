// 户型编辑：2D 顶视图墙体编辑器（SVG）
// 职责：视图缩放/平移、画墙（正交/任意）、墙身/端点/交点拖动、
// 端点重合与 T 型连接联动、吸附、校验与提交（通过回调与主程序协作）
import { createWall, wallLen, wallDir, findBreakerBox } from './model.js';

const SNAP_PX = 10;      // 吸附半径（屏幕像素）
const GRID = 0.1;        // 网格吸附步长（米）
const MIN_WALL = 0.2;    // 最短墙长（米）
const GROUP_EPS = 0.02;  // 端点重合 / 端点落在墙上的判定阈值（米）
const HANDLE_PX = 9;     // 控制柄拾取半径（屏幕像素）
const WALL_PICK_PX = 7;  // 墙身拾取半宽（屏幕像素）

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// 点到线段的投影：返回 { d（垂距）, t01（参数）, dist（沿线距离）, p（垂足，已截断到线段内） }
function projOnSeg(p, a, b) {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const l2 = abx * abx + abz * abz;
  if (l2 < 1e-12) return null;
  const t01 = ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / l2;
  const tc = Math.max(0, Math.min(1, t01));
  const px = a[0] + abx * tc, pz = a[1] + abz * tc;
  return { d: Math.hypot(p[0] - px, p[1] - pz), t01, dist: t01 * Math.sqrt(l2), p: [px, pz] };
}

function round1(v) { return Math.round(v * 10) / 10; }

export class Plan2D {
  // opts: { svg, tools: {select, ortho, free, del, fit}, hintEl,
  //         dataProvider, onChange, onSelect, onNotify, onDeleteWall, onWallAdded }
  constructor(opts) {
    Object.assign(this, opts);
    this.active = false;
    this.tool = 'select';
    this.view = { scale: 80, ox: 0, oy: 0 };
    this.selectedId = null;
    this.hover = null;        // { type: 'wall'|'handle', key }
    this.drawP1 = null;       // 画墙起点
    this.previewP2 = null;    // 画墙预览终点
    this.drag = null;         // 进行中的拖动
    this.w = 800; this.h = 600;

    this._bind();
  }

  data() { return this.dataProvider(); }

  // ---------- 生命周期 ----------
  activate() {
    this.active = true;
    this.cancelDrag();
    this.drawP1 = null; this.previewP2 = null;
    this.resize();
    this.fitView();
    this.setTool('select');
  }

  deactivate() {
    this.cancelDrag();
    this.drawP1 = null; this.previewP2 = null;
    this.active = false;
  }

  refresh() { if (this.active) this.render(); }

  resize() {
    const r = this.svg.getBoundingClientRect();
    if (r.width > 0) { this.w = r.width; this.h = r.height; }
    if (this.active) this.render();
  }

  // ---------- 坐标换算与视图 ----------
  toScreen(p) { return [p[0] * this.view.scale + this.view.ox, p[1] * this.view.scale + this.view.oy]; }
  toWorld(sx, sy) { return [(sx - this.view.ox) / this.view.scale, (sy - this.view.oy) / this.view.scale]; }
  eventScreen(e) {
    const r = this.svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  zoomAt(sx, sy, factor) {
    const v = this.view;
    const ns = Math.min(600, Math.max(4, v.scale * factor));
    v.ox = sx - (sx - v.ox) * (ns / v.scale);
    v.oy = sy - (sy - v.oy) * (ns / v.scale);
    v.scale = ns;
  }

  fitView() {
    const walls = this.data().walls;
    const v = this.view;
    if (!walls.length) {
      v.scale = 80;
      v.ox = this.w / 2; v.oy = this.h / 2;
      if (this.active) this.render();
      return;
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const w of walls) {
      for (const [x, z] of [w.start, w.end]) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
    }
    const bw = Math.max(maxX - minX, 1), bh = Math.max(maxZ - minZ, 1);
    const margin = 80;
    v.scale = Math.max(4, Math.min(600, Math.min((this.w - margin) / bw, (this.h - margin) / bh)));
    v.ox = (this.w - bw * v.scale) / 2 - minX * v.scale;
    v.oy = (this.h - bh * v.scale) / 2 - minZ * v.scale;
    if (this.active) this.render();
  }

  // ---------- 连接图（端点重合 + 端点落在墙内部），由当前墙几何实时构建 ----------
  buildGroups(walls) {
    const groups = [];
    for (const w of walls) {
      for (let ei = 0; ei < 2; ei++) {
        const p = ei === 0 ? w.start : w.end;
        let g = groups.find(g => Math.hypot(g.p[0] - p[0], g.p[1] - p[1]) < GROUP_EPS);
        if (!g) {
          g = { p: [p[0], p[1]], ends: [], hostId: null };
          groups.push(g);
        }
        g.ends.push({ wallId: w.id, ei });
      }
    }
    for (const g of groups) {
      const own = new Set(g.ends.map(e => e.wallId));
      for (const w of walls) {
        if (own.has(w.id)) continue;
        const pr = projOnSeg(g.p, w.start, w.end);
        if (pr && pr.d < GROUP_EPS) { g.hostId = w.id; break; }
      }
      g.key = g.ends.map(e => `${e.wallId}:${e.ei}`).sort().join('|');
    }
    return groups;
  }

  // ---------- 渲染 ----------
  render() {
    const svg = this.svg;
    svg.textContent = '';
    const walls = this.data().walls;
    this.groups = this.buildGroups(walls);
    const v = this.view;

    // 网格（1m 细线，5m 粗线）
    const [minX, minZ] = this.toWorld(0, 0);
    const [maxX, maxZ] = this.toWorld(this.w, this.h);
    const gGrid = el('g', {}, svg);
    for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
      const [sx] = this.toScreen([x, 0]);
      el('line', { x1: sx, y1: 0, x2: sx, y2: this.h, class: x % 5 === 0 ? 'grid-line-major' : 'grid-line' }, gGrid);
    }
    for (let z = Math.floor(minZ); z <= Math.ceil(maxZ); z++) {
      const [, sy] = this.toScreen([0, z]);
      el('line', { x1: 0, y1: sy, x2: this.w, y2: sy, class: z % 5 === 0 ? 'grid-line-major' : 'grid-line' }, gGrid);
    }

    // 节点与强电箱位置标记（仅作上下文，不参与交互）
    const byId = new Map(walls.map(w => [w.id, w]));
    const gMark = el('g', {}, svg);
    for (const node of this.data().nodes) {
      if (node.type === 'terminal') continue;
      if (node.deviceType === 'breakerBox') continue; // 强电箱有专用方块标记
      const wall = byId.get(node.wall);
      if (!wall) continue;
      const [dx, dz] = wallDir(wall);
      const [sx, sy] = this.toScreen([wall.start[0] + dx * node.pos, wall.start[1] + dz * node.pos]);
      el('circle', { cx: sx, cy: sy, r: 2.5, class: 'plan-node' }, gMark);
    }
    const box = findBreakerBox(this.data());
    if (box && byId.get(box.wall)) {
      const wall = byId.get(box.wall);
      const [dx, dz] = wallDir(wall);
      const [sx, sy] = this.toScreen([wall.start[0] + dx * box.pos, wall.start[1] + dz * box.pos]);
      el('rect', { x: sx - 4, y: sy - 4, width: 8, height: 8, class: 'plan-box' }, gMark);
    }

    // 墙体
    const invalidSet = (this.drag && this.drag.invalid) ? this.drag.affected : null;
    const gWalls = el('g', {}, svg);
    for (const w of walls) {
      const [x1, y1] = this.toScreen(w.start);
      const [x2, y2] = this.toScreen(w.end);
      let cls = 'plan-wall';
      if (invalidSet && invalidSet.has(w.id)) cls += ' invalid';
      else if (w.id === this.selectedId) cls += ' selected';
      else if (this.hover && this.hover.type === 'wall' && this.hover.id === w.id) cls += ' hover';
      el('line', {
        x1, y1, x2, y2, class: cls,
        'stroke-width': Math.max((w.thickness || 0.2) * v.scale, 3),
        'stroke-linecap': 'butt',
      }, gWalls);
    }

    // 选中墙的长度标注
    if (this.selectedId && byId.has(this.selectedId) && !this.drag) {
      const w = byId.get(this.selectedId);
      const [x1, y1] = this.toScreen(w.start);
      const [x2, y2] = this.toScreen(w.end);
      this.drawDim((x1 + x2) / 2, (y1 + y2) / 2 - 10, `${wallLen(w).toFixed(2)} m`, false, 'middle');
    }

    // 控制柄（仅选择工具）
    if (this.tool === 'select') {
      const gH = el('g', {}, svg);
      for (const g of this.groups) {
        const [sx, sy] = this.toScreen(this.groupPoint(g));
        const hov = this.hover && this.hover.type === 'handle' && this.hover.key === g.key;
        let cls = 'plan-handle' + (hov ? ' hover' : '');
        if (g.hostId) cls += ' t-joint';
        else if (g.ends.length > 1) cls += ' joint';
        if (g.hostId) {
          // T 型交点：方块
          const s = hov ? 5.5 : 4.5;
          el('rect', { x: sx - s, y: sy - s, width: s * 2, height: s * 2, class: cls }, gH);
        } else {
          el('circle', { cx: sx, cy: sy, r: hov ? 6 : 4.5, class: cls }, gH);
        }
      }
    }

    // 画墙预览
    if (this.drawP1 && this.previewP2) {
      const [x1, y1] = this.toScreen(this.drawP1);
      const [x2, y2] = this.toScreen(this.previewP2);
      const len = Math.hypot(this.previewP2[0] - this.drawP1[0], this.previewP2[1] - this.drawP1[1]);
      const tooShort = len < MIN_WALL;
      el('line', { x1, y1, x2, y2, class: 'plan-preview' + (tooShort ? ' invalid' : '') }, svg);
      const ang = Math.atan2(this.previewP2[1] - this.drawP1[1], this.previewP2[0] - this.drawP1[0]) * 180 / Math.PI;
      const deg = ((ang % 180) + 180) % 180;
      this.drawDim((x1 + x2) / 2, (y1 + y2) / 2 - 10,
        `${len.toFixed(2)} m · ${deg.toFixed(1)}°`, tooShort, 'middle');
      el('circle', { cx: x1, cy: y1, r: 3.5, class: 'plan-handle joint' }, svg);
    }

    // 拖动尺寸提示
    if (this.drag && this.drag.dimText != null && this.drag.cursor) {
      this.drawDim(this.drag.cursor[0] + 16, this.drag.cursor[1] - 14,
        this.drag.dimText, !!this.drag.invalid, 'start');
    }
  }

  drawDim(sx, sy, text, invalid, anchor) {
    const t = el('text', {
      x: sx, y: sy, class: 'plan-dim' + (invalid ? ' invalid' : ''),
      'text-anchor': anchor,
    }, this.svg);
    t.textContent = text;
  }

  // 组的当前位置（拖动中几何被实时修改，须从墙端点取）
  groupPoint(g) {
    const e0 = g.ends[0];
    const wall = this.data().walls.find(w => w.id === e0.wallId);
    return e0.ei === 0 ? wall.start : wall.end;
  }

  // ---------- 工具与提示 ----------
  setTool(tool) {
    this.cancelDrag();
    this.tool = tool;
    this.drawP1 = null; this.previewP2 = null;
    for (const [name, btn] of Object.entries({
      select: this.tools.select, ortho: this.tools.ortho, free: this.tools.free, delete: this.tools.del,
    })) {
      btn.classList.toggle('active-tool', name === tool);
    }
    this.updateHint();
    this.updateCursor();
    this.render();
  }

  updateHint() {
    const hints = {
      select: '单击墙或控制点选中；拖动墙身沿法线平移，拖动端点/交点调整形状；Delete 删除选中墙',
      ortho: this.drawP1 ? '点击第二个端点完成画墙（Esc 取消）' : '正交画墙：点击起点（自动锁定水平/竖直，Alt 关闭吸附）',
      free: this.drawP1 ? '点击第二个端点完成画墙（Esc 取消）' : '任意画墙：点击起点（可任意角度，Alt 关闭吸附）',
      delete: '单击要删除的墙（强电箱所在墙不可删除）',
    };
    this.hintEl.textContent = hints[this.tool] || '';
  }

  updateCursor() {
    let c = 'default';
    if (this.tool === 'ortho' || this.tool === 'free') c = 'crosshair';
    else if (this.tool === 'delete') c = 'not-allowed';
    else if (this.drag && this.drag.type === 'pan') c = 'grabbing';
    else if (this.hover) c = this.hover.type === 'handle' ? 'pointer' : 'move';
    this.svg.style.cursor = c;
  }

  setSelection(sel) {
    this.selectedId = sel && sel.kind === 'wall' ? sel.id : null;
    if (this.active) this.render();
  }

  selectWall(id) {
    this.selectedId = id;
    this.onSelect(id ? { kind: 'wall', id } : null);
    this.render();
  }

  // ---------- 吸附 ----------
  // ortho：正交画墙时相对 drawP1 锁定轴向
  snapPoint(w, altKey, ortho) {
    let p = [w[0], w[1]];
    let axis = null;
    if (ortho && this.drawP1) {
      axis = Math.abs(w[0] - this.drawP1[0]) >= Math.abs(w[1] - this.drawP1[1]) ? 'x' : 'z';
      p = axis === 'x' ? [w[0], this.drawP1[1]] : [this.drawP1[0], w[1]];
    }
    if (altKey) return p; // Alt：仅保留正交约束，关闭吸附
    const R = SNAP_PX / this.view.scale;
    const walls = this.data().walls;

    // 1. 端点吸附（精确重合，形成转角/共端点连接）
    let best = null, bestD = R;
    for (const wall of walls) {
      for (const pt of [wall.start, wall.end]) {
        const d = Math.hypot(pt[0] - p[0], pt[1] - p[1]);
        if (d < bestD) { bestD = d; best = pt; }
      }
    }
    if (best) {
      if (!axis) return [best[0], best[1]];
      // 正交：端点在轴线上才精确吸附，否则保持正交性
      const offAxis = axis === 'x' ? Math.abs(best[1] - p[1]) : Math.abs(best[0] - p[0]);
      if (offAxis < GROUP_EPS) return axis === 'x' ? [best[0], p[1]] : [p[0], best[1]];
    }

    // 2. 墙面投影吸附（形成 T 型连接）
    let bestProj = null;
    for (const wall of walls) {
      const pr = projOnSeg(p, wall.start, wall.end);
      if (pr && pr.d < R && pr.t01 >= 0 && pr.t01 <= 1) {
        if (!bestProj || pr.d < bestProj.d) bestProj = pr;
      }
    }
    if (bestProj) {
      if (!axis) return bestProj.p;
      return axis === 'x' ? [bestProj.p[0], p[1]] : [p[0], bestProj.p[1]];
    }

    // 3. 0.1m 网格
    if (axis === 'x') return [round1(p[0]), p[1]];
    if (axis === 'z') return [p[0], round1(p[1])];
    return [round1(p[0]), round1(p[1])];
  }

  // ---------- 拾取 ----------
  pickHandle(sx, sy) {
    let best = null, bestD = HANDLE_PX;
    for (const g of this.groups || []) {
      const [hx, hy] = this.toScreen(this.groupPoint(g));
      const d = Math.hypot(hx - sx, hy - sy);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  pickWall(w) {
    let best = null, bestD = Infinity;
    for (const wall of this.data().walls) {
      const pr = projOnSeg(w, wall.start, wall.end);
      if (!pr) continue;
      const tol = Math.max((wall.thickness || 0.2) / 2, WALL_PICK_PX / this.view.scale);
      if (pr.d <= tol && pr.d < bestD) { bestD = pr.d; best = wall; }
    }
    return best;
  }

  // ---------- 快照 / 校验 ----------
  takeSnapshot() {
    const snap = new Map();
    for (const w of this.data().walls) snap.set(w.id, { start: [...w.start], end: [...w.end] });
    return snap;
  }

  restoreSnap(snap) {
    for (const w of this.data().walls) {
      const s = snap.get(w.id);
      if (s) { w.start = [...s.start]; w.end = [...s.end]; }
    }
  }

  snapChanged(snap) {
    for (const w of this.data().walls) {
      const s = snap.get(w.id);
      if (!s) continue;
      if (Math.hypot(w.start[0] - s.start[0], w.start[1] - s.start[1]) > 1e-9) return true;
      if (Math.hypot(w.end[0] - s.end[0], w.end[1] - s.end[1]) > 1e-9) return true;
    }
    return false;
  }

  // 校验受影响墙：最小长度、节点/设备边界、T 型连接保持；返回错误消息或 null
  validateGeometry(groupsSnap, affected) {
    const data = this.data();
    const byId = new Map(data.walls.map(w => [w.id, w]));
    for (const id of affected) {
      const wall = byId.get(id);
      if (!wall) continue;
      if (wallLen(wall) < MIN_WALL - 1e-9) return `墙长不能小于 ${MIN_WALL}m`;
    }
    for (const node of data.nodes) {
      if (!affected.has(node.wall)) continue;
      const wall = byId.get(node.wall);
      if (wall && (node.pos < -1e-9 || node.pos > wallLen(wall) + 1e-9)) {
        return '修改会使节点或设备落在墙外';
      }
    }
    // T 型连接：拖动前落在某墙内部的端点组，拖动后仍须落在同一墙上
    for (const g of groupsSnap) {
      if (!g.hostId) continue;
      const touched = g.ends.some(e => affected.has(e.wallId)) || affected.has(g.hostId);
      if (!touched) continue;
      const host = byId.get(g.hostId);
      if (!host) return 'T 型连接的宿主墙已不存在';
      const e0 = g.ends[0];
      const gw = byId.get(e0.wallId);
      const p = e0.ei === 0 ? gw.start : gw.end;
      const pr = projOnSeg(p, host.start, host.end);
      if (!pr || pr.d > GROUP_EPS) return '拖动会使 T 型连接断开';
    }
    return null;
  }

  // ---------- 事件 ----------
  _bind() {
    this.svg.addEventListener('mousedown', e => this.onMouseDown(e));
    this.svg.addEventListener('wheel', e => {
      if (!this.active) return;
      e.preventDefault();
      const [sx, sy] = this.eventScreen(e);
      this.zoomAt(sx, sy, Math.pow(1.0015, -e.deltaY));
      this.render();
    }, { passive: false });
    window.addEventListener('mousemove', e => this.onMouseMove(e));
    window.addEventListener('mouseup', e => this.onMouseUp(e));
    window.addEventListener('keydown', e => {
      if (!this.active) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.code === 'Escape') this.handleEscape();
      else if ((e.code === 'Delete' || e.code === 'Backspace') && this.selectedId) {
        this.onDeleteWall(this.selectedId);
      }
    });
    window.addEventListener('resize', () => { if (this.active) this.resize(); });
  }

  onMouseDown(e) {
    if (!this.active || e.button !== 0) return;
    const [sx, sy] = this.eventScreen(e);
    const w = this.toWorld(sx, sy);

    if (this.tool === 'select') {
      const g = this.pickHandle(sx, sy);
      if (g) {
        this.selectWall(g.ends[0].wallId);
        this.drag = {
          type: 'handle', group: g, snapshot: this.takeSnapshot(),
          groupsSnap: this.buildGroups(this.data().walls),
          affected: new Set(), invalid: null, cursor: [sx, sy], dimText: null,
        };
        return;
      }
      const wall = this.pickWall(w);
      if (wall) {
        this.selectWall(wall.id);
        const [dx, dz] = wallDir(wall);
        this.drag = {
          type: 'wall', wallId: wall.id, snapshot: this.takeSnapshot(),
          groupsSnap: this.buildGroups(this.data().walls),
          startW: w, n: [dz, -dx],
          affected: new Set(), invalid: null, cursor: [sx, sy], dimText: null,
        };
        return;
      }
      this.drag = { type: 'pan', lastSx: sx, lastSy: sy, moved: false };
      this.updateCursor();
      return;
    }

    if (this.tool === 'ortho' || this.tool === 'free') {
      const p = this.snapPoint(w, e.altKey, this.tool === 'ortho');
      if (!this.drawP1) {
        this.drawP1 = p;
        this.updateHint();
      } else {
        this.commitWall(this.drawP1, p);
      }
      this.render();
      return;
    }

    if (this.tool === 'delete') {
      const wall = this.pickWall(w);
      if (wall) this.onDeleteWall(wall.id);
    }
  }

  onMouseMove(e) {
    if (!this.active) return;
    const [sx, sy] = this.eventScreen(e);
    const w = this.toWorld(sx, sy);

    if (this.drag) { this.dragMove(e, w, sx, sy); return; }

    if (this.drawP1 && (this.tool === 'ortho' || this.tool === 'free')) {
      this.previewP2 = this.snapPoint(w, e.altKey, this.tool === 'ortho');
      this.render();
      return;
    }

    if (this.tool === 'select') {
      const g = this.pickHandle(sx, sy);
      let hover = null;
      if (g) hover = { type: 'handle', key: g.key };
      else {
        const wall = this.pickWall(w);
        if (wall) hover = { type: 'wall', id: wall.id };
      }
      const key = hover ? `${hover.type}:${hover.key || hover.id}` : null;
      const oldKey = this.hover ? `${this.hover.type}:${this.hover.key || this.hover.id}` : null;
      if (key !== oldKey) {
        this.hover = hover;
        this.updateCursor();
        this.render();
      }
    }
  }

  dragMove(e, w, sx, sy) {
    const d = this.drag;
    d.cursor = [sx, sy];

    if (d.type === 'pan') {
      const dx = sx - d.lastSx, dy = sy - d.lastSy;
      if (Math.abs(dx) + Math.abs(dy) > 0) {
        d.moved = d.moved || Math.hypot(dx, dy) > 2;
        this.view.ox += dx; this.view.oy += dy;
        d.lastSx = sx; d.lastSy = sy;
        this.updateCursor();
        this.render();
      }
      return;
    }

    this.restoreSnap(d.snapshot);
    d.affected = new Set();

    if (d.type === 'wall') {
      // 沿墙法线平移，位移吸附 0.1m 网格
      let t = (w[0] - d.startW[0]) * d.n[0] + (w[1] - d.startW[1]) * d.n[1];
      if (!e.altKey) t = round1(t);
      const delta = [d.n[0] * t, d.n[1] * t];
      for (const g of d.groupsSnap) {
        const onWall = g.ends.some(en => en.wallId === d.wallId);
        const hosted = g.hostId === d.wallId;
        if (!onWall && !hosted) continue;
        for (const en of g.ends) this.moveEnd(en, delta, d.affected);
      }
      d.dimText = `位移 ${t >= 0 ? '+' : ''}${t.toFixed(2)} m`;
    } else if (d.type === 'handle') {
      let p;
      if (d.group.hostId) {
        // T 型交点：沿宿主墙滑动
        const host = this.data().walls.find(x => x.id === d.group.hostId);
        const L = wallLen(host);
        const [dx, dz] = wallDir(host);
        let t = (w[0] - host.start[0]) * dx + (w[1] - host.start[1]) * dz;
        if (!e.altKey) {
          const R = SNAP_PX / this.view.scale;
          if (Math.abs(t) < R) t = 0;
          else if (Math.abs(L - t) < R) t = L;
          else t = round1(t);
        }
        t = Math.max(0, Math.min(L, t));
        p = [host.start[0] + dx * t, host.start[1] + dz * t];
      } else {
        p = this.snapPoint(w, e.altKey, false);
      }
      for (const en of d.group.ends) this.setEnd(en, p, d.affected);
      const first = this.data().walls.find(x => x.id === d.group.ends[0].wallId);
      d.dimText = `长度 ${wallLen(first).toFixed(2)} m`;
    }

    d.invalid = this.validateGeometry(d.groupsSnap, d.affected);
    this.updateCursor();
    this.render();
  }

  moveEnd(en, delta, affected) {
    const key = `${en.wallId}:${en.ei}`;
    if (affected.has(key)) return;
    affected.add(key);
    // affected 同时按墙 id 记录（校验用）
    affected.add(en.wallId);
    const wall = this.data().walls.find(x => x.id === en.wallId);
    const arr = en.ei === 0 ? wall.start : wall.end;
    arr[0] += delta[0]; arr[1] += delta[1];
  }

  setEnd(en, p, affected) {
    affected.add(en.wallId);
    const wall = this.data().walls.find(x => x.id === en.wallId);
    if (en.ei === 0) wall.start = [p[0], p[1]];
    else wall.end = [p[0], p[1]];
  }

  onMouseUp(e) {
    if (!this.active) return;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.type === 'pan') {
      if (!d.moved) this.selectWall(null); // 单击空白清除选择
      this.updateCursor();
      this.render();
      return;
    }
    if (d.invalid) {
      this.restoreSnap(d.snapshot);
      this.onNotify(`${d.invalid}，已还原`, true);
      this.updateCursor();
      this.render();
      return;
    }
    const changed = this.snapChanged(d.snapshot);
    this.updateCursor();
    this.render();
    if (changed) this.onChange();
  }

  cancelDrag() {
    if (this.drag && this.drag.snapshot) this.restoreSnap(this.drag.snapshot);
    this.drag = null;
  }

  handleEscape() {
    if (this.drag) {
      this.cancelDrag();
      this.updateCursor();
      this.render();
      return;
    }
    if (this.drawP1) {
      this.drawP1 = null; this.previewP2 = null;
      this.updateHint();
      this.render();
      return;
    }
    if (this.tool !== 'select') this.setTool('select');
  }

  // ---------- 画墙提交 ----------
  commitWall(p1, p2) {
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (len < MIN_WALL) {
      this.onNotify(`墙太短（< ${MIN_WALL}m），未创建`, true);
      this.drawP1 = null; this.previewP2 = null;
      this.updateHint();
      return;
    }
    const wall = createWall(p1[0], p1[1], p2[0], p2[1]);
    this.data().walls.push(wall);
    this.drawP1 = null; this.previewP2 = null;
    this.onWallAdded(wall);   // 首堵墙自动在中点放置强电箱
    this.updateHint();
    this.onChange();
    this.onNotify('墙已添加');
  }

  // ---------- 面板精确长度编辑：保持方向与起点，仅移动终点（含连接联动与校验） ----------
  setWallLength(id, len) {
    const wall = this.data().walls.find(w => w.id === id);
    if (!wall) return false;
    if (!(len >= MIN_WALL)) {
      this.onNotify(`长度无效（需 ≥ ${MIN_WALL}m）`, true);
      return false;
    }
    const snapshot = this.takeSnapshot();
    const groupsSnap = this.buildGroups(this.data().walls);
    const [dx, dz] = wallDir(wall);
    const newEnd = [wall.start[0] + dx * len, wall.start[1] + dz * len];
    const affected = new Set();
    const g = groupsSnap.find(g => g.ends.some(e => e.wallId === id && e.ei === 1));
    if (g) for (const en of g.ends) this.setEnd(en, newEnd, affected);
    const err = this.validateGeometry(groupsSnap, affected);
    if (err) {
      this.restoreSnap(snapshot);
      this.onNotify(`${err}，已还原`, true);
      return false;
    }
    this.onChange();
    this.render();
    return true;
  }
}
