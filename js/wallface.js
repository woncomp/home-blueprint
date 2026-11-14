// 墙面 2D 展开对话框：三墙展开视图（左邻墙 / 当前墙 / 右邻墙），SVG 正视图查看与编辑电路。
// 显示方向以"面对墙面"为准：B 面沿墙 start→end 从左到右，A 面水平反向（不修改持久化 pos）。
// 相邻墙面只读：可查看、可选作跨墙电线端点；增删、拖动、属性编辑仅限当前墙。
import {
  wallLen, wallDir, nodeWorldPos, createNode, createWire,
  addLink, removeLink, linksOf, computeCircuits,
  detectRooms, buildWallSegments, adjacentWallViews,
  DEVICE_TYPES, NODE_TYPE_NAMES, findBreakerBox, BREAKER_BOX_SIZE, BREAKER_SIDE_INSET, breakerTerminalHeight,
  clipDoorToSeg, DOOR_DEFAULT_HEIGHT,
} from './model.js';

const SVGNS = 'http://www.w3.org/2000/svg';
// 高度方向吸附：HEIGHT_SEGMENTS 段均分墙面 → HEIGHT_SEGMENTS-1 条横向参考线
const HEIGHT_SEGMENTS = 6;
const Y_SNAP_PX = 8; // 吸附半径（屏幕像素，随缩放换算成米）
// 三墙展开布局（像素）
const PAD_X = 16;        // 槽位内墙面两侧最小留白（容纳高度刻度等）
const PANEL_GAP = 40;    // 相邻墙面实际边缘的最小间距（跨墙电线在此竖直转折）
const TOP_PAD = 44;      // 标题栏高度
const BOTTOM_PAD = 40;   // 底部刻度留白

export class WallFaceDialog {
  constructor(cbs) {
    this.cbs = cbs; // { onChange, onSelect, onNotify, onClose }
    this.dialog = document.getElementById('wallface-dialog');
    this.scroll = document.getElementById('wallface-scroll');
    this.svg = document.getElementById('wallface-svg');
    this.titleEl = document.getElementById('wallface-title');
    this.infoEl = document.getElementById('wallface-info');
    this.tool = 'select';
    this.wirePending = null;
    this.linkPending = null;
    this.selectedNodeId = null;
    this.selectedWireId = null;
    this.selectedDoorId = null;
    this.dragging = null;
    this.snapGuideH = null;
    this.views = null;      // 三墙视图记录（render 时计算）
    this.wallSegments = null;
    this.faceNav = null;    // detectRooms 面环导航（与 wallSegments 同步缓存）
    this._centerPending = false;

    document.getElementById('wallface-close').addEventListener('click', () => this.close());
    document.getElementById('wallface-backdrop').addEventListener('click', () => this.close());
    document.querySelectorAll('#wallface-tools .wf-tool').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setTool(btn.dataset.wftool);
      });
    });

    this.svg.addEventListener('mousedown', e => this.onSvgMouseDown(e));
    window.addEventListener('mousemove', e => this.onSvgMouseMove(e));
    window.addEventListener('mouseup', e => this.onSvgMouseUp(e));
    this.svg.addEventListener('mousemove', e => this.onSvgHover(e));
    window.addEventListener('keydown', e => {
      if (!this.isOpen()) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if ((e.code === 'Delete' || e.code === 'Backspace') && this.selectedDoorId) {
        const id = this.selectedDoorId;
        this.selectedDoorId = null;
        if (this.cbs.onDeleteDoor) this.cbs.onDeleteDoor(id);
      }
    });
    window.addEventListener('resize', () => {
      if (this.isOpen()) {
        this._centerPending = true; // 视口变化后槽位重排，重新把当前墙居中
        this.render();
      }
    });
  }

  // seg：逻辑墙段快照 {id, wallId, index, t0, t1}（派生拆分），null 视为整墙
  open(data, wallId, face, mode, seg) {
    this.data = data;
    this.wallId = wallId;
    this.face = face;
    this.mode = mode;
    this.seg = seg && seg.wallId === wallId ? { id: seg.id, wallId, index: seg.index, t0: seg.t0, t1: seg.t1 } : null;
    this.selectedNodeId = null;
    this.selectedWireId = null;
    this.selectedDoorId = null;
    this.dragging = null;
    this.snapGuideH = null;
    this.wallSegments = null;
    this.faceNav = null;
    this.views = null;
    this._centerPending = true;
    this.dialog.classList.remove('hidden');
    this.setTool('select');
    this.render();
  }

  close() {
    this.dialog.classList.add('hidden');
    this.data = null;
    this.views = null;
    if (this.cbs.onClose) this.cbs.onClose();
  }

  isOpen() { return !this.dialog.classList.contains('hidden'); }

  setTool(tool) {
    this.tool = tool;
    this.wirePending = null;
    this.linkPending = null;
    document.querySelectorAll('#wallface-tools .wf-tool').forEach(b => {
      b.classList.toggle('active', b.dataset.wftool === tool);
    });
    const toolsEl = document.getElementById('wallface-tools');
    toolsEl.style.display = this.mode === 'edit' ? 'flex' : 'none';
    this.renderInfo();
  }

  wall() { return (this.data.walls || []).find(w => w.id === this.wallId); }

  // ---------- 三墙视图 ----------
  // 每个视图：{ role, wallId, face, seg, wall, len, h, reversed, slotX, baseX, w }
  // 坐标映射（显示像素）：posX(v, local)、heightY(height)；local 为段内米制
  computeViews() {
    const walls = this.data.walls || [];
    if (!this.wallSegments) {
      const { segRooms, faceNav } = detectRooms(walls);
      this.wallSegments = buildWallSegments(segRooms, walls);
      this.faceNav = faceNav;
    }
    const mk = (role, wallId, face, seg) => {
      const wall = walls.find(w => w.id === wallId);
      if (!wall) return null;
      const t0 = seg ? seg.t0 : 0;
      const t1 = seg ? seg.t1 : 1;
      return {
        role, wallId, face, seg, wall,
        len: Math.max((t1 - t0) * wallLen(wall), 0.01),
        h: wall.height || 2.8,
        reversed: face === 0, // 面对墙面：B 面 start→end 从左到右，A 面反向
      };
    };
    const adj = adjacentWallViews(walls, this.wallSegments, this.wallId, this.face, this.seg, this.faceNav);
    this.views = [
      mk('left', adj.left && adj.left.wallId, adj.left && adj.left.face, adj.left && adj.left.seg),
      mk('active', this.wallId, this.face, this.seg),
      mk('right', adj.right && adj.right.wallId, adj.right && adj.right.face, adj.right && adj.right.seg),
    ].filter(Boolean);

    const svgH = this.scroll.clientHeight || 500;
    const svgW = this.scroll.clientWidth || 800;
    // 统一比例：最高墙恰好占满标题栏与底部刻度之间的可用高度
    const maxH = Math.max(...this.views.map(v => v.h), 0.5);
    const scale = Math.max(svgH - TOP_PAD - BOTTOM_PAD, 1) / maxH;
    this.scale = scale;
    this.floorY = svgH - BOTTOM_PAD;
    // 三个独立槽位：各自保底可视宽度的 1/3，且只因本槽墙面过宽而扩展。
    // 当前墙槽位两侧各留 PANEL_GAP；左右墙分别贴向本槽靠当前墙的一侧。
    const minSlotW = svgW / 3;
    const viewByRole = Object.fromEntries(this.views.map(v => [v.role, v]));
    const slotWs = {};
    for (const role of ['left', 'active', 'right']) {
      const v = viewByRole[role];
      slotWs[role] = !v ? minSlotW : role === 'active'
        ? Math.max(minSlotW, v.len * scale + 2 * PANEL_GAP)
        : Math.max(minSlotW, v.len * scale + PAD_X);
    }
    this.slotWs = slotWs;
    let slotX = 0;
    for (const role of ['left', 'active', 'right']) {
      const v = viewByRole[role];
      if (!v) { slotX += slotWs[role]; continue; }
      v.slotX = slotX;
      v.slotW = slotWs[role];
      v.w = v.len * scale;
      v.baseX = role === 'left'
        ? v.slotX + v.slotW - v.w          // 左墙贴右缘
        : role === 'right'
          ? v.slotX                        // 右墙贴左缘
          : v.slotX + (v.slotW - v.w) / 2; // 当前墙居中
      slotX += v.slotW;
    }
    this.svgW = slotX;
    this.svgH = svgH;
  }

  activeView() { return this.views && this.views.find(v => v.role === 'active'); }

  // 节点所属的可见视图（三面墙中匹配墙/面/段），不可见返回 null
  viewOfNode(node) {
    if (!this.views || !node) return null;
    return this.views.find(v => v.wallId === node.wall && v.face === node.face && this.inSegV(v, node)) || null;
  }

  // 当前墙视图（无 views 时按 open 参数合成，保证测试与内部换算可用）
  currentView() {
    const av = this.activeView();
    if (av) return av;
    return {
      role: 'active', wallId: this.wallId, face: this.face, seg: this.seg,
      wall: this.wall(), len: this.wall() ? wallLen(this.wall()) : 1,
      h: this.wall() ? (this.wall().height || 2.8) : 2.8,
      reversed: this.face === 0, baseX: 0, w: 0,
    };
  }

  posX(v, local) {
    return v.baseX + (v.reversed ? v.len - local : local) * this.scale;
  }
  heightY(height) { return this.floorY - height * this.scale; }
  xPos(v, px) {
    const local = (px - v.baseX) / this.scale;
    return v.reversed ? v.len - local : local;
  }
  yHeight(py) { return (this.floorY - py) / this.scale; }

  // ---------- 坐标映射（段内米制 ↔ 整墙 0~1） ----------
  // 节点 pos（整墙 0~1）→ 段内米制；view 缺省用节点自己的可见视图
  localOf(node, view) {
    const v = view || this.viewOfNode(node) || this.currentView();
    const t0 = v.seg ? v.seg.t0 : 0;
    return (node.pos - t0) * wallLen(v.wall);
  }
  // 段内米制 → 整墙 0~1
  tOf(local, view) {
    const v = view || this.currentView();
    const t0 = v.seg ? v.seg.t0 : 0;
    return t0 + local / wallLen(v.wall);
  }

  // 节点是否属于某视图的逻辑墙段：半开区间 [t0,t1)，末段闭区间
  inSegV(v, node) {
    if (!v.seg) return true;
    const { t0, t1 } = v.seg;
    const last = t1 >= 1 - 1e-9;
    return node.pos >= t0 - 1e-9 && (last ? node.pos <= t1 + 1e-9 : node.pos < t1 - 1e-9);
  }

  inSeg(node) {
    if (!this.seg) return true;
    return this.inSegV({ seg: this.seg }, node);
  }

  nodesOnFace() {
    return this.data.nodes.filter(n => n.wall === this.wallId && n.face === this.face && this.inSeg(n));
  }

  nodesOnView(v) {
    return this.data.nodes.filter(n => n.wall === v.wallId && n.face === v.face && this.inSegV(v, n));
  }

  // 节点是否在当前活动墙段（供 main.js 全局删除守卫使用）
  isActiveNode(node) {
    if (!node) return false;
    if (!this.views) return node.wall === this.wallId && node.face === this.face && this.inSeg(node);
    const v = this.viewOfNode(node);
    return !!v && v.role === 'active';
  }

  // ---------- 渲染 ----------
  render() {
    if (!this.data) return;
    const prevScroll = this.scroll.scrollLeft;
    this.computeViews();
    this.circuits = computeCircuits(this.data);
    const av = this.activeView();
    const segTxt = this.seg && (this.seg.t0 > 1e-9 || this.seg.t1 < 1 - 1e-9) ? ` · 段 ${this.seg.index + 1}` : '';
    const neighbors = this.views.filter(v => v.role !== 'active').map(v => `${v.role === 'left' ? '左' : '右'} 墙 ${v.wallId}`).join('，');
    this.titleEl.textContent = `墙 ${this.wallId} · ${this.face === 0 ? 'A 面' : 'B 面'}${segTxt}` +
      (av ? `（长 ${av.len.toFixed(2)}m × 高 ${av.h}m）` : '') + (neighbors ? `　|　${neighbors}` : '');

    this.svg.innerHTML = '';
    this.svg.setAttribute('width', Math.round(this.svgW));
    this.svg.setAttribute('height', Math.round(this.svgH));

    for (const v of this.views) this.renderPanel(v);
    for (const v of this.views) this.renderDoors(v);
    this.renderWires();
    for (const v of this.views) {
      this.renderBreakerBox(v);
      this.renderNodes(v);
    }
    this.renderInfo();

    // 普通重绘保留滚动位置；打开/切换当前墙后把当前墙居中
    if (this._centerPending && av) {
      this._centerPending = false;
      const target = av.baseX + av.w / 2 - this.scroll.clientWidth / 2;
      this.scroll.scrollLeft = Math.max(0, target);
    } else {
      this.scroll.scrollLeft = Math.min(prevScroll, Math.max(0, this.svgW - this.scroll.clientWidth));
    }
  }

  renderPanel(v) {
    const isActive = v.role === 'active';
    const x0 = v.baseX, x1 = v.baseX + v.w;
    const sx0 = v.slotX, sx1 = v.slotX + v.slotW;
    const bandTop = this.heightY(v.h);
    // 面板标题（按槽位左缘布置，短墙时不与相邻槽位挤在一起）
    const segTxt = v.seg && (v.seg.t0 > 1e-9 || v.seg.t1 < 1 - 1e-9) ? ` · 段 ${v.seg.index + 1}` : '';
    const title = el('text', { x: sx0 + PAD_X, y: 18, class: 'wf-panel-title' });
    title.textContent = `墙 ${v.wallId} · ${v.face === 0 ? 'A 面' : 'B 面'}${segTxt}　长 ${v.len.toFixed(2)}m`;
    this.svg.appendChild(title);
    if (isActive) {
      const badge = el('text', { x: sx0 + PAD_X, y: 34, class: 'wf-panel-badge' });
      badge.textContent = '▶ 当前编辑';
      this.svg.appendChild(badge);
    }
    // 相邻墙：标题右侧提供"设为当前墙"
    if (!isActive) {
      const btnW = 96, btnH = 20, bx = sx1 - PAD_X - btnW, by = 6;
      const g = el('g', { class: 'wf-activate' });
      g.appendChild(el('rect', { x: bx, y: by, width: btnW, height: btnH, rx: 4 }));
      const t = el('text', { x: bx + btnW / 2, y: by + 14, 'text-anchor': 'middle', 'pointer-events': 'none' });
      t.textContent = '设为当前墙';
      g.appendChild(t);
      g.addEventListener('mousedown', e => {
        e.stopPropagation();
        this.activateView(v);
      });
      this.svg.appendChild(g);
    }
    // 墙面带
    this.svg.appendChild(el('rect', {
      x: x0, y: bandTop, width: v.w, height: v.h * this.scale,
      fill: isActive ? '#efeadf' : '#f5f2ea',
      stroke: isActive ? '#4a90d9' : '#c8c8c8',
      'stroke-width': isActive ? 2.5 : 1,
      class: 'wf-panel-band' + (isActive ? ' active' : ''),
    }));
    // 沿墙刻度（按显示方向标注米数）
    for (let m = 0; m <= Math.floor(v.len + 1e-9); m++) {
      const tx = this.posX(v, m);
      const tick = el('line', {
        x1: tx, y1: this.floorY, x2: tx, y2: this.floorY + 5,
        stroke: '#bbb',
      });
      this.svg.appendChild(tick);
      const tt = el('text', {
        x: tx, y: this.floorY + 17,
        'text-anchor': 'middle', 'font-size': 11, fill: '#999',
      });
      tt.textContent = m + 'm';
      this.svg.appendChild(tt);
    }
    // 高度刻度（仅当前墙画数字，避免邻墙重复拥挤）
    if (isActive) {
      for (let m = 0; m <= Math.floor(v.h + 1e-9); m++) {
        const ty = el('text', {
          x: x0 - 6, y: this.heightY(m) + 4,
          'text-anchor': 'end', 'font-size': 11, fill: '#999',
        });
        ty.textContent = m + 'm';
        this.svg.appendChild(ty);
      }
    }
    // 高度参考线（均分墙面），吸附到某条时高亮
    for (const g of this.heightGuides(v)) {
      const hit = this.snapGuideH != null && Math.abs(g - this.snapGuideH) < 1e-9;
      this.svg.appendChild(el('line', {
        x1: x0, y1: this.heightY(g), x2: x1, y2: this.heightY(g),
        stroke: hit ? '#4a90d9' : '#c3cdd9',
        'stroke-width': hit ? 2.5 : 1,
        'stroke-dasharray': hit ? 'none' : '5 4',
        'pointer-events': 'none',
      }));
      if (isActive) {
        const gt = el('text', {
          x: x1 + 6, y: this.heightY(g) + 3,
          'font-size': 10, fill: hit ? '#4a90d9' : '#a8b4c0',
          'pointer-events': 'none',
        });
        gt.textContent = g.toFixed(2);
        this.svg.appendChild(gt);
      }
    }
    // 面板之间的公共边界提示（实际墙面间隙的中点竖直虚线）
    if (!isActive) {
      const seamX = this.seamXBetween(v, this.activeView());
      if (seamX != null) {
        this.svg.appendChild(el('line', {
          x1: seamX, y1: this.heightY(v.h), x2: seamX, y2: this.floorY,
          class: 'wf-seam', 'pointer-events': 'none',
        }));
      }
    }
  }

  // 门洞：白色挖空 + 门框描边 + 门扇开启线（朝本面开实线、背向虚线；铰链在门洞起始侧，与 3D 一致）
  renderDoors(v) {
    const doors = (this.data.doors || []).filter(d => d.wall === v.wallId);
    if (!doors.length) return;
    const L = wallLen(v.wall);
    const segA = (v.seg ? v.seg.t0 : 0) * L; // 段起点整墙米制偏移（clipDoorToSeg 返回值需减去它才是段内米制）
    for (const door of doors) {
      const clipped = clipDoorToSeg(door, v.seg ? v.seg.t0 : null, v.seg ? v.seg.t1 : null, L);
      if (!clipped) continue;
      const [a, b] = clipped;
      const xa = this.posX(v, a - segA), xb = this.posX(v, b - segA);
      const w = Math.abs(xb - xa);
      if (w < 0.5) continue; // 段内残余不足 0.5px 不画
      const x = Math.min(xa, xb);
      const top = this.heightY(Math.min(door.height ?? DOOR_DEFAULT_HEIGHT, v.h));
      const isSel = this.selectedDoorId === door.id;
      const g = el('g', {});
      const opening = el('rect', {
        x, y: top, width: w, height: this.floorY - top,
        fill: '#fdfdf8', stroke: isSel ? '#4a90d9' : '#8a6f4d',
        'stroke-width': isSel ? 2.5 : 1.5, class: 'wf-door',
        'data-doorid': door.id,
      });
      // 选择工具下点击门洞 = 选中门（其他工具保持原有冒泡行为）
      opening.addEventListener('mousedown', e => {
        if (this.tool !== 'select') return;
        e.stopPropagation();
        this.selectedDoorId = door.id;
        this.selectedNodeId = null;
        this.selectedWireId = null;
        this.render();
        if (this.cbs.onSelect) this.cbs.onSelect({ kind: 'door', id: door.id });
      });
      g.appendChild(opening);
      // 门扇开启线：铰链侧门楣角 → 对侧地面
      const hingeX = this.posX(v, clamp(door.pos - door.width / 2, a, b) - segA);
      const farX = this.posX(v, clamp(door.pos + door.width / 2, a, b) - segA);
      const toward = (door.face || 0) === v.face;
      g.appendChild(el('line', {
        x1: hingeX, y1: top, x2: farX, y2: this.floorY,
        stroke: '#8a6f4d', 'stroke-width': 1.2, 'pointer-events': 'none',
        ...(toward ? {} : { 'stroke-dasharray': '5 4' }),
      }));
      this.svg.appendChild(g);
    }
  }

  renderBreakerBox(v) {
    const box = findBreakerBox(this.data);
    if (!box || box.wall !== v.wallId || box.face !== v.face || !this.inSegV(v, box)) return;
    const bw = BREAKER_BOX_SIZE.w * this.scale, bh = BREAKER_BOX_SIZE.h * this.scale;
    const bx = this.posX(v, this.localOf(box, v) - BREAKER_BOX_SIZE.w / 2);
    const by = this.heightY(box.height + BREAKER_BOX_SIZE.h / 2);
    const g = el('g', {});
    g.appendChild(el('rect', {
      x: bx, y: by, width: bw, height: bh,
      rx: 4, fill: '#3a4048', stroke: '#20242a', 'stroke-width': 1.5,
    }));
    const n = box.breakers.length;
    const centerLocal = this.localOf(box, v);
    const dotOff = BREAKER_BOX_SIZE.w / 2 - BREAKER_SIDE_INSET;
    // 每个断路器一行（对齐端子真实高度）+ 左右边缘各一个端子圆点：
    // 活动侧实心（电线出发点），另一侧空心，点击可切换出线方向
    box.breakers.forEach((br, i) => {
      const cIdx = this.circuits.circuits.findIndex(c => c.breakerId === br.id);
      const color = cIdx >= 0 ? this.circuits.circuits[cIdx].color : '#999';
      const cy = this.heightY(breakerTerminalHeight(i, n, box.height));
      const ry = cy - 6.5;
      g.appendChild(el('rect', {
        x: bx + 6, y: ry, width: bw - 12, height: 13,
        rx: 2, fill: '#2c313a', stroke: color, 'stroke-width': 1,
      }));
      const lt = el('text', { x: bx + 10, y: ry + 10, 'font-size': 9, fill: '#ddd' });
      lt.textContent = (br.label || `断路器${i + 1}`).slice(0, 8);
      g.appendChild(lt);
      for (const [side, off] of [['left', -dotOff], ['right', dotOff]]) {
        const active = (br.side || 'left') === side;
        const dot = el('circle', {
          cx: this.posX(v, centerLocal + off), cy, r: 4,
          fill: active ? color : '#2c313a',
          stroke: color, 'stroke-width': active ? 1.5 : 1,
          class: 'node', 'data-nodeid': br.terminal, 'data-side': side,
        });
        dot.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          if (active) {
            this.onNodeMouseDown(e, br.terminal);
          } else {
            br.side = side;
            if (this.cbs.onChange) this.cbs.onChange();
            this.render();
          }
        });
        g.appendChild(dot);
      }
    });
    // 选择工具下点击箱体本体 = 选中强电箱设备节点（其他工具保持原有冒泡行为）
    g.addEventListener('mousedown', e => {
      if (this.tool !== 'select') return;
      e.stopPropagation();
      this.selectedNodeId = box.id;
      this.selectedWireId = null;
      this.selectedDoorId = null;
      this.render();
      if (this.cbs.onSelect) this.cbs.onSelect({ kind: 'node', id: box.id });
    });
    this.svg.appendChild(g);
  }

  // 两端点所在视图的公共边界 x（跨墙电线在此竖直转折）；不相邻返回 null
  seamXBetween(va, vb) {
    const roles = [va.role, vb.role];
    let seam = null;
    if (roles.includes('left') && roles.includes('active')) {
      const left = va.role === 'left' ? va : vb;
      const active = va.role === 'active' ? va : vb;
      seam = (left.baseX + left.w + active.baseX) / 2;
    } else if (roles.includes('right') && roles.includes('active')) {
      const right = va.role === 'right' ? va : vb;
      const active = va.role === 'active' ? va : vb;
      seam = (active.baseX + active.w + right.baseX) / 2;
    }
    return seam;
  }

  renderWires() {
    const nodesById = new Map(this.data.nodes.map(n => [n.id, n]));
    for (const wire of this.data.wires) {
      const a = nodesById.get(wire.from), b = nodesById.get(wire.to);
      if (!a || !b) continue;
      const va = this.viewOfNode(a), vb = this.viewOfNode(b);
      if (!va && !vb) continue;
      const cIdx = this.circuits.wireCircuit.get(wire.id);
      const color = cIdx != null ? this.circuits.circuits[cIdx].color : '#888';
      const width = this.selectedWireId === wire.id ? 4 : 2.5;
      const ya = this.heightY(a.height), yb = this.heightY(b.height);
      let hit, line;
      if (va && vb && va === vb) {
        // 同一可见墙段：横平竖直，沿墙水平走线，在中点垂直折角
        const xa = this.posX(va, this.localOf(a, va));
        const xb = this.posX(vb, this.localOf(b, vb));
        const mx = (xa + xb) / 2;
        const pts = `${xa},${ya} ${mx},${ya} ${mx},${yb} ${xb},${yb}`;
        hit = el('polyline', { points: pts, fill: 'none', class: 'wire-hit', 'data-wireid': wire.id });
        line = el('polyline', { points: pts, fill: 'none', class: 'wire-line', stroke: color, 'stroke-width': width });
      } else if (va && vb) {
        // 两端都在可见墙面：经两面墙的公共边界转折（实线）
        const seam = this.seamXBetween(va, vb);
        const xa = this.posX(va, this.localOf(a, va));
        const xb = this.posX(vb, this.localOf(b, vb));
        let pts;
        if (seam != null) {
          pts = `${xa},${ya} ${seam},${ya} ${seam},${yb} ${xb},${yb}`;
        } else {
          pts = `${xa},${ya} ${xb},${yb}`; // 左邻↔右邻：虚线直连提示
        }
        hit = el('polyline', { points: pts, fill: 'none', class: 'wire-hit', 'data-wireid': wire.id });
        line = el('polyline', {
          points: pts, fill: 'none', class: 'wire-line', stroke: color, 'stroke-width': width,
          ...(seam != null ? {} : { 'stroke-dasharray': '6 4' }),
        });
      } else {
        // 一端不可见：虚线引到本段边界（同墙截断到段端点，跨墙引到面板边缘）
        const self = va ? a : b;
        const other = va ? b : a;
        const vs = va || vb;
        const x1 = this.posX(vs, this.localOf(self, vs));
        const y1 = va ? ya : yb;
        const y2 = va ? yb : ya;
        let x2;
        if (other.wall === vs.wallId) {
          x2 = this.posX(vs, clamp(this.localOf(other, vs), 0, vs.len));
        } else {
          const mid = vs.baseX + vs.w / 2;
          x2 = x1 < mid ? vs.baseX : vs.baseX + vs.w;
        }
        hit = el('line', { x1, y1, x2, y2, class: 'wire-hit', 'data-wireid': wire.id });
        line = el('line', {
          x1, y1, x2, y2, class: 'wire-line',
          stroke: color, 'stroke-width': width, 'stroke-dasharray': '6 4',
        });
      }
      if (this.mode === 'edit') {
        hit.addEventListener('mousedown', e => {
          e.stopPropagation();
          this.selectedWireId = wire.id;
          this.selectedNodeId = null;
          this.selectedDoorId = null;
          if (this.cbs.onSelect) this.cbs.onSelect({ kind: 'wire', id: wire.id });
          this.renderInfo();
        });
      }
      this.svg.appendChild(hit);
      this.svg.appendChild(line);
    }
    // links 画成紫色虚线弧
    for (const link of (this.data.links || [])) {
      const a = nodesById.get(link.a), b = nodesById.get(link.b);
      if (!a || !b) continue;
      const va = this.viewOfNode(a), vb = this.viewOfNode(b);
      if (!va && !vb) continue;
      const self = va ? a : b;
      const other = va ? b : a;
      const vs = va || vb;
      const x1 = this.posX(vs, this.localOf(self, vs));
      const y1 = this.heightY(self.height);
      let x2;
      if (vb && va) {
        x2 = this.posX(vb, this.localOf(other, vb));
      } else if (other.wall === vs.wallId) {
        x2 = this.posX(vs, clamp(this.localOf(other, vs), 0, vs.len));
      } else {
        const mid = vs.baseX + vs.w / 2;
        x2 = x1 < mid ? vs.baseX : vs.baseX + vs.w;
      }
      const y2 = this.heightY(other.height);
      const path = el('path', {
        d: `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${Math.max(y1, y2) + 24} ${x2} ${y2}`,
        fill: 'none', stroke: '#a06cd5', 'stroke-width': 2, 'stroke-dasharray': '5 4',
      });
      const hit = el('path', {
        d: path.getAttribute('d'), fill: 'none', stroke: 'transparent', 'stroke-width': 12,
        style: 'cursor:pointer',
      });
      hit.addEventListener('mousedown', e => {
        e.stopPropagation();
        // 连通线本身不可点选/删除：点击选中本视图内可见的端点，删除走右侧信息面板
        if (this.mode !== 'edit') return;
        this.selectedNodeId = self.id;
        this.selectedWireId = null;
        this.selectedDoorId = null;
        if (this.cbs.onSelect) this.cbs.onSelect({ kind: 'node', id: self.id });
        this.renderInfo();
      });
      this.svg.appendChild(hit);
      this.svg.appendChild(path);
      const lt = el('text', { x: (x1 + x2) / 2, y: Math.max(y1, y2) + 38, 'text-anchor': 'middle', 'font-size': 10, fill: '#a06cd5' });
      lt.textContent = '连通';
      this.svg.appendChild(lt);
    }
  }

  renderNodes(v) {
    for (const node of this.nodesOnView(v)) {
      if (node.type === 'terminal') continue;
      if (node.deviceType === 'breakerBox') continue; // 强电箱由 renderBreakerBox 单独绘制
      const x = this.posX(v, this.localOf(node, v)), y = this.heightY(node.height);
      const isSel = this.selectedNodeId === node.id;
      const cIdx = this.circuits.nodeCircuit.get(node.id);
      const cColor = cIdx != null ? this.circuits.circuits[cIdx].color : '#666';
      let shape;
      if (node.type === 'device') {
        const dt = DEVICE_TYPES[node.deviceType] || DEVICE_TYPES.socket;
        const g = el('g', { class: 'node', 'data-nodeid': node.id });
        if (node.deviceType === 'light') {
          g.appendChild(el('circle', { cx: x, cy: y, r: 9, fill: dt.color, stroke: isSel ? '#ffee55' : '#333', 'stroke-width': isSel ? 3 : 1.5 }));
          for (let i = 0; i < 8; i++) {
            const ang = i * Math.PI / 4;
            g.appendChild(el('line', {
              x1: x + Math.cos(ang) * 11, y1: y + Math.sin(ang) * 11,
              x2: x + Math.cos(ang) * 15, y2: y + Math.sin(ang) * 15,
              stroke: dt.color, 'stroke-width': 1.5,
            }));
          }
        } else {
          g.appendChild(el('rect', {
            x: x - 8, y: y - 11, width: 16, height: 22, rx: 3,
            fill: dt.color, stroke: isSel ? '#ffee55' : '#333', 'stroke-width': isSel ? 3 : 1.5,
          }));
          if (node.deviceType === 'socket') {
            g.appendChild(el('circle', { cx: x - 3, cy: y - 3, r: 1.5, fill: '#fff' }));
            g.appendChild(el('circle', { cx: x + 3, cy: y - 3, r: 1.5, fill: '#fff' }));
            g.appendChild(el('circle', { cx: x, cy: y + 4, r: 1.5, fill: '#fff' }));
          } else {
            g.appendChild(el('circle', { cx: x, cy: y, r: 4, fill: 'none', stroke: '#fff', 'stroke-width': 1.5 }));
          }
        }
        shape = g;
      } else if (node.type === 'turn') {
        shape = el('rect', {
          x: x - 6, y: y - 6, width: 12, height: 12,
          fill: '#fff', stroke: isSel ? '#ffee55' : cColor, 'stroke-width': isSel ? 3 : 2,
          class: 'node', 'data-nodeid': node.id,
        });
      } else { // split
        const g = el('g', { class: 'node', 'data-nodeid': node.id });
        g.appendChild(el('circle', { cx: x, cy: y, r: 7, fill: '#fff', stroke: isSel ? '#ffee55' : cColor, 'stroke-width': isSel ? 3 : 2 }));
        g.appendChild(el('path', { d: `M ${x - 3.5} ${y} H ${x + 3.5} M ${x} ${y - 3.5} V ${y + 3.5}`, stroke: cColor, 'stroke-width': 1.6, fill: 'none' }));
        shape = g;
      }
      shape.addEventListener('mousedown', e => this.onNodeMouseDown(e, node.id));
      this.svg.appendChild(shape);
      if (node.label) {
        const t = el('text', { x, y: y - 18, 'text-anchor': 'middle', 'font-size': 11, fill: '#444' });
        t.textContent = node.label;
        this.svg.appendChild(t);
      }
    }
  }

  // ---------- 切换当前墙 ----------
  // 把某个视图（通常是相邻墙）设为当前编辑墙：保留工具与模式，
  // 清除选择/未完成连线/拖动，重新计算左右邻墙并把新当前墙居中
  activateView(v) {
    if (!v || (v.wallId === this.wallId && v.face === this.face && sameSeg(v.seg, this.seg))) return;
    this.wallId = v.wallId;
    this.face = v.face;
    this.seg = v.seg ? { id: v.seg.id, wallId: v.seg.wallId, index: v.seg.index, t0: v.seg.t0, t1: v.seg.t1 } : null;
    this.selectedNodeId = null;
    this.selectedWireId = null;
    this.selectedDoorId = null;
    this.wirePending = null;
    this.linkPending = null;
    this.dragging = null;
    this.snapGuideH = null;
    this._centerPending = true;
    if (this.cbs.onSelect) this.cbs.onSelect(null); // 清掉旧墙上的全局选中
    this.render();
  }

  // ---------- 交互 ----------
  onNodeMouseDown(e, nodeId) {
    e.stopPropagation();
    const node = this.data.nodes.find(n => n.id === nodeId);
    if (!node) return;
    const view = this.views ? this.viewOfNode(node) : null;
    if (this.mode !== 'edit') {
      this.selectedNodeId = nodeId;
      this.selectedDoorId = null;
      if (this.cbs.onSelect) this.cbs.onSelect({ kind: 'node', id: nodeId });
      this.render();
      return;
    }
    if (this.tool === 'wire') {
      if (!this.wirePending) {
        this.wirePending = nodeId;
        this.renderInfo();
      } else if (this.wirePending !== nodeId) {
        const a = this.data.nodes.find(n => n.id === this.wirePending);
        const err = this.wirePairError(a, node);
        if (err) {
          this.cbs.onNotify && this.cbs.onNotify(err);
        } else {
          this.data.wires.push(createWire(a.id, node.id));
        }
        this.wirePending = null;
        this.changed();
      }
      return;
    }
    if (this.tool === 'link') {
      if (view && view.role !== 'active') {
        this.cbs.onNotify && this.cbs.onNotify('穿墙连通请在当前墙面操作（先点标题「设为当前墙」）');
        return;
      }
      this.linkPending = nodeId;
      this.renderInfo();
      return;
    }
    // select：选中并开始拖动（仅当前墙可拖动）
    this.selectedNodeId = nodeId;
    this.selectedWireId = null;
    this.selectedDoorId = null;
    if (this.cbs.onSelect) this.cbs.onSelect({ kind: 'node', id: nodeId });
    if (view && view.role !== 'active') {
      this.dragging = null;
      this.cbs.onNotify && this.cbs.onNotify('相邻墙面为只读，点击标题「设为当前墙」后可编辑');
    } else {
      this.dragging = { nodeId, moved: false };
    }
    this.renderInfo();
  }

  // 校验一对节点能否创建电线；返回错误消息或 null
  wirePairError(a, b) {
    if (!a || !b) return '端点不存在';
    const va = this.viewOfNode(a), vb = this.viewOfNode(b);
    if (!va || !vb) return '电线两端必须都在当前展开的墙面内';
    if (va === vb) {
      if (va.role !== 'active') return '相邻墙内部连线请先把该墙设为当前墙';
      return null; // 当前墙同面内
    }
    // 跨面板：必须一端是当前墙，另一端是其左右邻墙
    const hasActive = va.role === 'active' || vb.role === 'active';
    if (!hasActive) return '只能连接当前墙与相邻墙面（不能绕过当前墙连左右邻墙）';
    return null;
  }

  onSvgMouseDown(e) {
    if (this.mode !== 'edit') return;
    const pt = this.svgPoint(e);
    if (this.tool === 'turn' || this.tool === 'split' ||
        this.tool === 'socket' || this.tool === 'switch' || this.tool === 'light') {
      // 只能在当前墙面板内放置设备
      const av = this.activeView();
      if (!av) return;
      if (pt.x < av.baseX || pt.x > av.baseX + av.w ||
          pt.y < this.heightY(av.h) || pt.y > this.floorY) return;
      const local = clamp(this.xPos(av, pt.x), 0, av.len);
      const rawH = clamp(this.yHeight(pt.y), 0, av.h);
      const snapped = this.snapHeight(rawH, e.altKey, av);
      this.snapGuideH = snapped !== rawH ? snapped : null;
      const height = snapped;
      const type = ['socket', 'switch', 'light'].includes(this.tool) ? 'device' : this.tool;
      const node = createNode(type, this.wallId, this.face, round4(this.tOf(local, av)), round2(height), this.tool);
      this.data.nodes.push(node);
      this.selectedNodeId = node.id;
      this.changed();
    } else if (this.tool === 'select') {
      this.selectedNodeId = null;
      this.selectedWireId = null;
      this.selectedDoorId = null;
      this.renderInfo();
    }
  }

  onSvgMouseMove(e) {
    if (!this.dragging) return;
    const node = this.data.nodes.find(n => n.id === this.dragging.nodeId);
    if (!node || node.type === 'terminal') return;
    const av = this.activeView();
    if (!av) return;
    const pt = this.svgPoint(e);
    node.pos = round4(this.tOf(clamp(this.xPos(av, pt.x), 0, av.len), av));
    const rawH = clamp(this.yHeight(pt.y), 0, av.h);
    const snapped = this.snapHeight(rawH, e.altKey, av);
    this.snapGuideH = snapped !== rawH ? snapped : null;
    node.height = round2(snapped);
    this.dragging.moved = true;
    this.render();
    this.renderInfo();
  }

  onSvgMouseUp() {
    this.snapGuideH = null;
    if (this.dragging && this.dragging.moved) this.changed();
    else if (this.dragging) this.render();
    this.dragging = null;
  }

  onSvgHover(e) {
    if (this.mode !== 'edit') return;
    if (['turn', 'split', 'socket', 'switch', 'light'].includes(this.tool)) {
      this.showPreview(this.svgPoint(e), e.altKey);
    }
  }

  showPreview(pt, altKey) {
    const old = this.svg.querySelector('.preview');
    if (old) old.remove();
    const av = this.activeView();
    if (!av) return;
    // 仅在当前墙面板范围内显示放置预览
    if (pt.x < av.baseX || pt.x > av.baseX + av.w ||
        pt.y < this.heightY(av.h) || pt.y > this.floorY) return;
    const x = this.posX(av, clamp(this.xPos(av, pt.x), 0, av.len));
    const y = this.heightY(this.snapHeight(clamp(this.yHeight(pt.y), 0, av.h), altKey, av));
    this.svg.appendChild(el('circle', { cx: x, cy: y, r: 8, fill: 'none', stroke: '#4a90d9', 'stroke-dasharray': '3 3', class: 'preview', 'pointer-events': 'none' }));
  }

  svgPoint(e) {
    const pt = this.svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(this.svg.getScreenCTM().inverse());
  }

  // ---------- 删除 ----------
  deleteWire(wireId) {
    this.data.wires = this.data.wires.filter(w => w.id !== wireId);
    this.selectedWireId = null;
    this.changed();
  }

  deleteNode(nodeId) {
    const node = this.data.nodes.find(n => n.id === nodeId);
    if (!node || node.type === 'terminal') return;
    if (!this.isActiveNode(node)) {
      this.cbs.onNotify && this.cbs.onNotify('只能删除当前墙面的设备（先点标题「设为当前墙」）');
      return;
    }
    if (node.deviceType === 'breakerBox') {
      if (this.cbs.onNotify) this.cbs.onNotify('强电箱不能删除');
      return;
    }
    this.data.nodes = this.data.nodes.filter(n => n.id !== nodeId);
    this.data.wires = this.data.wires.filter(w => w.from !== nodeId && w.to !== nodeId);
    if (this.data.links) {
      this.data.links = this.data.links.filter(l => l.a !== nodeId && l.b !== nodeId);
    }
    this.selectedNodeId = null;
    this.changed();
  }

  changed() {
    if (this.cbs.onChange) this.cbs.onChange();
    this.render();
  }

  // ---------- 右侧信息 ----------
  heightGuides(v) {
    const g = [];
    for (let k = 1; k < HEIGHT_SEGMENTS; k++) g.push(v.h * k / HEIGHT_SEGMENTS);
    return g;
  }
  // 靠近参考线（Y_SNAP_PX 屏幕像素内）则吸附到线上；altKey 禁用
  snapHeight(height, altKey, v) {
    if (altKey) return height;
    const r = Y_SNAP_PX / this.scale;
    let best = null, bd = r;
    for (const g of this.heightGuides(v || this.currentView())) {
      const d = Math.abs(height - g);
      if (d <= bd) { bd = d; best = g; }
    }
    return best == null ? height : best;
  }

  renderInfo() {
    this.infoEl.innerHTML = '';
    if (!this.data) return;
    const toolHints = {
      select: '拖动节点可调整其沿墙位置与高度；靠近横向参考线时高度自动吸附（按住 Alt 禁用吸附）。相邻墙为只读。',
      wire: this.wirePending ? '已选第一个端点，点击第二个端点完成连线。' : '依次点击两个端点/设备连接电线：支持当前墙内，以及当前墙与左右相邻墙之间的跨墙电线。',
      turn: '点击当前墙面放置转弯端点。',
      split: '点击当前墙面放置分线端点。',
      socket: '点击当前墙面放置插座。',
      switch: '点击当前墙面放置开关。',
      light: '点击当前墙面放置灯具。',
      link: this.linkPending ? '点击下方列表中的候选节点完成连通。' : '点击一个端点，选择要连通的另一端点（0.4m 内就近连通，含跨墙两面）；跨墙走远线请用「➰ 连线」。',
    };
    const p = document.createElement('p');
    p.className = 'placeholder';
    p.style.marginBottom = '10px';
    p.textContent = toolHints[this.tool] || '';
    this.infoEl.appendChild(p);

    if (this.tool === 'link' && this.linkPending) {
      this.renderLinkCandidates();
      return;
    }

    // 选中节点详情
    const node = this.data.nodes.find(n => n.id === this.selectedNodeId);
    if (node && node.type !== 'terminal') {
      const name = node.type === 'device'
        ? `设备 · ${(DEVICE_TYPES[node.deviceType] || {}).name}`
        : NODE_TYPE_NAMES[node.type];
      const h = document.createElement('h4');
      h.style.margin = '6px 0';
      h.textContent = name;
      this.infoEl.appendChild(h);

      const view = this.views ? this.viewOfNode(node) : null;
      const readOnly = !!(view && view.role !== 'active');
      const v = view || this.currentView();

      if (readOnly) {
        const p2 = document.createElement('p');
        p2.className = 'placeholder';
        p2.textContent = `位于相邻墙（墙 ${node.wall} · ${node.face === 0 ? 'A' : 'B'}面），为只读。点击该面板上「设为当前墙」后可编辑。`;
        this.infoEl.appendChild(p2);
      }

      const mkInput = (label, value, onch) => {
        const row = document.createElement('div');
        row.style.marginBottom = '6px';
        const lab = document.createElement('div');
        lab.style.cssText = 'font-size:12px;color:#888;margin-bottom:2px;';
        lab.textContent = label;
        const input = document.createElement('input');
        input.type = 'number'; input.step = '0.05'; input.value = value;
        input.disabled = readOnly;
        input.style.cssText = 'width:100%;padding:3px 6px;border:1px solid #bbb;border-radius:4px;';
        input.addEventListener('change', () => { onch(parseFloat(input.value) || 0); this.changed(); });
        row.appendChild(lab); row.appendChild(input);
        this.infoEl.appendChild(row);
      };
      mkInput('沿墙位置 (m)', round2(this.localOf(node, v)), v2 => {
        node.pos = round4(this.tOf(clamp(v2, 0, v.len), v));
      });
      mkInput('离地高度 (m)', node.height, v2 => { node.height = clamp(v2, 0, v.h); });

      const labRow = document.createElement('div');
      labRow.style.marginBottom = '6px';
      const lab = document.createElement('div');
      lab.style.cssText = 'font-size:12px;color:#888;margin-bottom:2px;';
      lab.textContent = '说明';
      const input = document.createElement('input');
      input.type = 'text'; input.value = node.label || '';
      input.placeholder = '标注文字';
      input.disabled = readOnly;
      input.style.cssText = 'width:100%;padding:3px 6px;border:1px solid #bbb;border-radius:4px;';
      input.addEventListener('change', () => { node.label = input.value; this.changed(); });
      labRow.appendChild(lab); labRow.appendChild(input);
      this.infoEl.appendChild(labRow);

      const wires = this.data.wires.filter(w => w.from === node.id || w.to === node.id);
      const meta = document.createElement('p');
      meta.style.cssText = 'font-size:12px;color:#888;';
      meta.textContent = `连接电线：${wires.length} 段`;
      this.infoEl.appendChild(meta);

      // 穿墙连通列表：逐条展示并可删除（连通线的唯一删除入口）
      const links = (this.data.links || []).filter(l => l.a === node.id || l.b === node.id);
      if (links.length) {
        const lh = document.createElement('h4');
        lh.style.margin = '8px 0 4px';
        lh.textContent = `穿墙连通：${links.length} 处`;
        this.infoEl.appendChild(lh);
        for (const l of links) {
          const other = this.data.nodes.find(n => n.id === (l.a === node.id ? l.b : l.a));
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:5px;';
          const span = document.createElement('span');
          span.style.cssText = 'flex:1;font-size:12px;color:#666;';
          span.textContent = other ? linkDesc(this.data, other) : '（对端已不存在）';
          row.appendChild(span);
          if (!readOnly) {
            const btn = document.createElement('button');
            btn.className = 'tool-btn danger';
            btn.textContent = '删除';
            btn.addEventListener('click', () => { removeLink(this.data, l.id); this.changed(); });
            row.appendChild(btn);
          }
          this.infoEl.appendChild(row);
        }
      }

      if (this.mode === 'edit' && !readOnly) {
        const del = document.createElement('button');
        del.className = 'tool-btn danger';
        del.style.cssText = 'display:block;width:100%;margin-top:10px;';
        del.textContent = '删除节点';
        del.addEventListener('click', () => this.deleteNode(node.id));
        this.infoEl.appendChild(del);
      }
    } else if (this.selectedWireId) {
      const wire = this.data.wires.find(w => w.id === this.selectedWireId);
      if (wire) {
        const h = document.createElement('h4');
        h.style.margin = '6px 0';
        h.textContent = '电线';
        this.infoEl.appendChild(h);
        const lab = document.createElement('div');
        lab.style.cssText = 'font-size:12px;color:#888;margin-bottom:2px;';
        lab.textContent = '说明';
        const input = document.createElement('input');
        input.type = 'text'; input.value = wire.label || '';
        input.style.cssText = 'width:100%;padding:3px 6px;border:1px solid #bbb;border-radius:4px;';
        input.addEventListener('change', () => { wire.label = input.value; this.changed(); });
        this.infoEl.appendChild(lab); this.infoEl.appendChild(input);
        if (this.mode === 'edit') {
          const del = document.createElement('button');
          del.className = 'tool-btn danger';
          del.style.cssText = 'display:block;width:100%;margin-top:10px;';
          del.textContent = '删除电线';
          del.addEventListener('click', () => this.deleteWire(wire.id));
          this.infoEl.appendChild(del);
        }
      }
    } else if (this.mode === 'view') {
      const p2 = document.createElement('p');
      p2.className = 'placeholder';
      p2.textContent = '查看模式：点击节点或电线查看详情。切换到编辑模式可修改。';
      this.infoEl.appendChild(p2);
    }
  }

  renderLinkCandidates() {
    const self = this.data.nodes.find(n => n.id === this.linkPending);
    if (!self) return;
    const walls = new Map(this.data.walls.map(w => [w.id, w]));
    const p0 = nodeWorldPos(self, walls);
    const existing = new Set(linksOf(this.data, self.id).map(l => (l.a === self.id ? l.b : l.a)));
    const cands = [];
    for (const n of this.data.nodes) {
      if (n.id === self.id || n.type === 'terminal' || existing.has(n.id)) continue;
      if (n.wall === self.wall && n.face === self.face) continue;
      const p1 = nodeWorldPos(n, walls);
      const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      if (d < 0.4) {
        cands.push({ node: n, d, desc: linkDesc(this.data, n) });
      }
    }
    // 跨墙另一面：自动镜像（pos 为 0~1，按米比较需换算）。镜像节点属于"新增节点"，
    // 只允许在当前活动墙段创建，不允许借邻墙端点把节点加到非活动墙
    const selfView = this.views ? this.viewOfNode(self) : null;
    const selfActive = !selfView || selfView.role === 'active';
    const selfWall = walls.get(self.wall);
    const posEps = selfWall ? 0.01 / wallLen(selfWall) : 0.01;
    const mirror = this.data.nodes.find(n =>
      n.wall === self.wall && n.face !== self.face &&
      Math.abs(n.pos - self.pos) < posEps && Math.abs(n.height - self.height) < 0.01);
    if (!mirror && selfActive) {
      cands.unshift({ node: null, mirror: true, desc: `在 ${self.wall} 墙 ${self.face === 0 ? 'B' : 'A'} 面创建对应节点` });
    }
    const h = document.createElement('h4');
    h.style.margin = '6px 0';
    h.textContent = '可连通的端点';
    this.infoEl.appendChild(h);
    if (!cands.length) {
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.textContent = '附近（0.4m 内）没有其它墙面的端点。可把端点拖到墙角或另一面。';
      this.infoEl.appendChild(p);
      return;
    }
    for (const c of cands) {
      const btn = document.createElement('button');
      btn.className = 'tool-btn';
      btn.style.cssText = 'display:block;width:100%;margin-bottom:5px;text-align:left;';
      btn.textContent = c.mirror ? '⇄ ' + c.desc : `⇄ ${c.desc}（相距 ${c.d.toFixed(2)}m）`;
      btn.addEventListener('click', () => {
        if (c.mirror) {
          if (!this.isActiveNode(self)) {
            this.cbs.onNotify && this.cbs.onNotify('只能在当前墙面创建镜像节点');
            return;
          }
          const nn = createNode('turn', self.wall, self.face === 0 ? 1 : 0, self.pos, self.height);
          this.data.nodes.push(nn);
          addLink(this.data, self.id, nn.id);
        } else {
          addLink(this.data, self.id, c.node.id);
        }
        this.linkPending = null;
        this.changed();
      });
      this.infoEl.appendChild(btn);
    }
  }
}

function sameSeg(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.wallId === b.wallId && a.index === b.index &&
    Math.abs(a.t0 - b.t0) < 1e-9 && Math.abs(a.t1 - b.t1) < 1e-9;
}

function linkDesc(data, node) {
  const name = node.type === 'device'
    ? `设备(${(DEVICE_TYPES[node.deviceType] || {}).name})`
    : NODE_TYPE_NAMES[node.type] || node.type;
  const wall = (data.walls || []).find(w => w.id === node.wall);
  const m = wall ? node.pos * wallLen(wall) : 0;
  return `墙${node.wall} ${node.face === 0 ? 'A' : 'B'}面 · ${name} @${m.toFixed(2)}m`;
}

function el(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }
