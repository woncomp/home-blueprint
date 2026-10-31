// 墙面 2D 展开对话框：SVG 正视图，查看与编辑该面电路
import {
  wallLen, wallDir, wallNormal, nodeWorldPos, createNode, createWire,
  addLink, removeLink, linksOf, computeCircuits,
  DEVICE_TYPES, NODE_TYPE_NAMES, CIRCUIT_COLORS,
} from './model.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export class WallFaceDialog {
  constructor(cbs) {
    this.cbs = cbs; // { onChange, onSelect }
    this.dialog = document.getElementById('wallface-dialog');
    this.svg = document.getElementById('wallface-svg');
    this.titleEl = document.getElementById('wallface-title');
    this.infoEl = document.getElementById('wallface-info');
    this.btnA = document.getElementById('btn-face-a');
    this.btnB = document.getElementById('btn-face-b');
    this.tool = 'select';
    this.wirePending = null;
    this.linkPending = null;
    this.selectedNodeId = null;
    this.dragging = null;

    document.getElementById('wallface-close').addEventListener('click', () => this.close());
    document.getElementById('wallface-backdrop').addEventListener('click', () => this.close());
    this.btnA.addEventListener('click', () => this.setFace(0));
    this.btnB.addEventListener('click', () => this.setFace(1));
    document.querySelectorAll('#wallface-tools .wf-tool').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setTool(btn.dataset.wftool);
      });
    });

    this.svg.addEventListener('mousedown', e => this.onSvgMouseDown(e));
    window.addEventListener('mousemove', e => this.onSvgMouseMove(e));
    window.addEventListener('mouseup', e => this.onSvgMouseUp(e));
    this.svg.addEventListener('mousemove', e => this.onSvgHover(e));
  }

  open(data, wallId, face, mode) {
    this.data = data;
    this.wallId = wallId;
    this.face = face;
    this.mode = mode;
    this.dialog.classList.remove('hidden');
    this.setTool('select');
    this.render();
  }

  close() {
    this.dialog.classList.add('hidden');
    this.data = null;
    if (this.cbs.onClose) this.cbs.onClose();
  }

  isOpen() { return !this.dialog.classList.contains('hidden'); }

  setFace(face) {
    this.face = face;
    this.wirePending = null;
    this.linkPending = null;
    this.selectedNodeId = null;
    this.render();
  }

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

  wall() { return this.data.walls.find(w => w.id === this.wallId); }

  // ---------- 坐标映射 ----------
  computeView() {
    const wall = this.wall();
    const len = wallLen(wall);
    const h = wall.height || 2.8;
    const svgW = this.svg.clientWidth || 800;
    const svgH = this.svg.clientHeight || 500;
    const scale = Math.min((svgW - 80) / len, (svgH - 120) / h, 120);
    this.view = {
      scale,
      ox: (svgW - len * scale) / 2,
      oy: (svgH - h * scale) / 2 + 10,
      len, h,
    };
  }
  posX(pos) { return this.view.ox + pos * this.view.scale; }
  heightY(height) { return this.view.oy + (this.view.h - height) * this.view.scale; }
  xPos(x) { return (x - this.view.ox) / this.view.scale; }
  yHeight(y) { return this.view.h - (y - this.view.oy) / this.view.scale; }

  nodesOnFace() {
    return this.data.nodes.filter(n => n.wall === this.wallId && n.face === this.face);
  }

  // ---------- 渲染 ----------
  render() {
    if (!this.data) return;
    this.computeView();
    this.circuits = computeCircuits(this.data);
    const wall = this.wall();
    this.titleEl.textContent = `墙 ${wall.id} · ${this.face === 0 ? 'A 面' : 'B 面'}（长 ${this.view.len.toFixed(2)}m × 高 ${this.view.h}m）`;
    this.btnA.classList.toggle('active', this.face === 0);
    this.btnB.classList.toggle('active', this.face === 1);
    this.svg.innerHTML = '';
    this.svg.setAttribute('viewBox', `0 0 ${this.svg.clientWidth || 800} ${this.svg.clientHeight || 500}`);

    // 墙面带
    const band = el('rect', {
      x: this.posX(0), y: this.heightY(this.view.h),
      width: this.view.len * this.view.scale, height: this.view.h * this.view.scale,
      fill: '#efeadf', stroke: '#bbb', 'stroke-width': 1,
    });
    this.svg.appendChild(band);
    // 刻度
    for (let m = 0; m <= Math.floor(this.view.len); m++) {
      const tx = el('text', {
        x: this.posX(m), y: this.heightY(this.view.h) + 16,
        'text-anchor': 'middle', 'font-size': 11, fill: '#999',
      });
      tx.textContent = m + 'm';
      this.svg.appendChild(tx);
      const tick = el('line', {
        x1: this.posX(m), y1: this.heightY(this.view.h),
        x2: this.posX(m), y2: this.heightY(this.view.h) + 5,
        stroke: '#bbb',
      });
      this.svg.appendChild(tick);
    }
    for (let m = 0; m <= Math.floor(this.view.h); m++) {
      const ty = el('text', {
        x: this.posX(0) - 8, y: this.heightY(m) + 4,
        'text-anchor': 'end', 'font-size': 11, fill: '#999',
      });
      ty.textContent = m + 'm';
      this.svg.appendChild(ty);
    }

    this.renderBreakerBox();
    this.renderWires();
    this.renderNodes();
    this.renderInfo();
  }

  renderBreakerBox() {
    const box = this.data.breakerBox;
    if (!box || box.wall !== this.wallId || box.face !== this.face) return;
    const bw = 0.55 * this.view.scale, bh = 0.75 * this.view.scale;
    const bx = this.posX(box.pos - 0.275), by = this.heightY(box.height + 0.375);
    const g = el('g', {});
    g.appendChild(el('rect', {
      x: bx, y: by, width: bw, height: bh,
      rx: 4, fill: '#3a4048', stroke: '#20242a', 'stroke-width': 1.5,
    }));
    const t = el('text', { x: bx + bw / 2, y: by + 14, 'text-anchor': 'middle', 'font-size': 11, fill: '#cfe0f5' });
    t.textContent = '⚡ 强电箱';
    g.appendChild(t);
    // 每个断路器一行 + 端子
    box.breakers.forEach((br, i) => {
      const cIdx = this.circuits.circuits.findIndex(c => c.breakerId === br.id);
      const color = cIdx >= 0 ? this.circuits.circuits[cIdx].color : '#999';
      const ry = by + 20 + i * 16;
      g.appendChild(el('rect', {
        x: bx + 6, y: ry, width: bw - 12, height: 13,
        rx: 2, fill: '#2c313a', stroke: color, 'stroke-width': 1,
      }));
      const lt = el('text', { x: bx + 10, y: ry + 10, 'font-size': 9, fill: '#ddd' });
      lt.textContent = (br.label || `断路器${i + 1}`).slice(0, 8);
      g.appendChild(lt);
      // 端子接头
      const term = el('circle', {
        cx: bx + bw - 8, cy: ry + 6.5, r: 4,
        fill: color, stroke: '#fff', 'stroke-width': 1,
        class: 'node', 'data-nodeid': br.terminal,
      });
      term.addEventListener('mousedown', e => this.onNodeMouseDown(e, br.terminal));
      g.appendChild(term);
    });
    this.svg.appendChild(g);
  }

  renderWires() {
    const nodes = new Map(this.data.nodes.map(n => [n.id, n]));
    for (const wire of this.data.wires) {
      const a = nodes.get(wire.from), b = nodes.get(wire.to);
      if (!a || !b) continue;
      const onFace = n => n.wall === this.wallId && n.face === this.face;
      if (!onFace(a) && !onFace(b)) continue;
      // 端点映射到本面坐标：跨面连线（link 是虚线；wire 一般同面）
      const px = n => onFace(n) ? this.posX(n.pos) : (n.wall === this.wallId ? this.posX(n.pos) : this.posX(n.pos));
      const py = n => this.heightY(n.height);
      const cIdx = this.circuits.wireCircuit.get(wire.id);
      const color = cIdx != null ? this.circuits.circuits[cIdx].color : '#888';
      const sameFace = onFace(a) && onFace(b);
      const hit = el('line', {
        x1: px(a), y1: py(a), x2: px(b), y2: py(b),
        class: 'wire-hit', 'data-wireid': wire.id,
      });
      const line = el('line', {
        x1: px(a), y1: py(a), x2: px(b), y2: py(b),
        stroke: color, 'stroke-width': this.selectedWireId === wire.id ? 4 : 2.5,
        'stroke-dasharray': sameFace ? '' : '6 4',
      });
      if (this.mode === 'edit') {
        hit.addEventListener('mousedown', e => {
          e.stopPropagation();
          if (this.tool === 'remove') {
            this.deleteWire(wire.id);
          } else {
            this.selectedWireId = wire.id;
            this.selectedNodeId = null;
            if (this.cbs.onSelect) this.cbs.onSelect({ kind: 'wire', id: wire.id });
            this.renderInfo();
          }
        });
      }
      this.svg.appendChild(hit);
      this.svg.appendChild(line);
    }
    // links 画成跨面虚线弧
    for (const link of (this.data.links || [])) {
      const a = this.data.nodes.find(n => n.id === link.a);
      const b = this.data.nodes.find(n => n.id === link.b);
      if (!a || !b) continue;
      const onFace = n => n.wall === this.wallId && n.face === this.face;
      if (!onFace(a) && !onFace(b)) continue;
      const other = onFace(a) ? b : a;
      const self = onFace(a) ? a : b;
      const x1 = this.posX(self.pos), y1 = this.heightY(self.height);
      const x2 = this.posX(other.wall === this.wallId ? other.pos : this.view.len - other.pos);
      const y2 = y1 + (other.face === self.face ? 0 : 26);
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
        if (this.mode === 'edit' && this.tool === 'remove') {
          removeLink(this.data, link.id);
          this.changed();
        }
      });
      this.svg.appendChild(hit);
      this.svg.appendChild(path);
      const lt = el('text', { x: (x1 + x2) / 2, y: Math.max(y1, y2) + 38, 'text-anchor': 'middle', 'font-size': 10, fill: '#a06cd5' });
      lt.textContent = '连通';
      this.svg.appendChild(lt);
    }
  }

  renderNodes() {
    for (const node of this.nodesOnFace()) {
      if (node.type === 'terminal') continue;
      const x = this.posX(node.pos), y = this.heightY(node.height);
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

  // ---------- 交互 ----------
  onNodeMouseDown(e, nodeId) {
    e.stopPropagation();
    if (this.mode !== 'edit') {
      this.selectedNodeId = nodeId;
      if (this.cbs.onSelect) this.cbs.onSelect({ kind: 'node', id: nodeId });
      this.render();
      return;
    }
    const node = this.data.nodes.find(n => n.id === nodeId);
    if (this.tool === 'remove') {
      if (node.type === 'terminal') return;
      this.deleteNode(nodeId);
      return;
    }
    if (this.tool === 'wire') {
      if (!this.wirePending) {
        this.wirePending = nodeId;
        this.renderInfo();
      } else if (this.wirePending !== nodeId) {
        // 创建电线
        const a = this.data.nodes.find(n => n.id === this.wirePending);
        const b = node;
        if (a.wall === b.wall && a.face === b.face) {
          this.data.wires.push(createWire(a.id, b.id));
        } else {
          // 跨面：自动建立 link + 两段线？简化为：不同面时提示需同面
          this.cbs.onNotify && this.cbs.onNotify('电线两端必须在同一墙面的同一面，跨面请用「穿墙连通」端点');
        }
        this.wirePending = null;
        this.changed();
      }
      return;
    }
    if (this.tool === 'link') {
      this.linkPending = nodeId;
      this.renderInfo();
      return;
    }
    // select：开始拖动
    this.selectedNodeId = nodeId;
    this.selectedWireId = null;
    if (this.cbs.onSelect) this.cbs.onSelect({ kind: 'node', id: nodeId });
    this.dragging = { nodeId, moved: false };
    this.renderInfo();
  }

  onSvgMouseDown(e) {
    if (this.mode !== 'edit') return;
    const pt = this.svgPoint(e);
    if (this.tool === 'turn' || this.tool === 'split' ||
        this.tool === 'socket' || this.tool === 'switch' || this.tool === 'light') {
      const pos = clamp(this.xPos(pt.x), 0, this.view.len);
      const height = clamp(this.yHeight(pt.y), 0, this.view.h);
      const type = ['socket', 'switch', 'light'].includes(this.tool) ? 'device' : this.tool;
      const node = createNode(type, this.wallId, this.face, round2(pos), round2(height), this.tool);
      this.data.nodes.push(node);
      this.selectedNodeId = node.id;
      this.changed();
    } else if (this.tool === 'select') {
      this.selectedNodeId = null;
      this.selectedWireId = null;
      this.renderInfo();
    }
  }

  onSvgMouseMove(e) {
    if (!this.dragging) return;
    const node = this.data.nodes.find(n => n.id === this.dragging.nodeId);
    if (!node || node.type === 'terminal') return;
    const pt = this.svgPoint(e);
    node.pos = round2(clamp(this.xPos(pt.x), 0, this.view.len));
    node.height = round2(clamp(this.yHeight(pt.y), 0, this.view.h));
    this.dragging.moved = true;
    this.render();
    this.renderInfo();
  }

  onSvgMouseUp() {
    if (this.dragging && this.dragging.moved) this.changed();
    else if (this.dragging) this.render();
    this.dragging = null;
  }

  onSvgHover(e) {
    if (this.mode !== 'edit') return;
    const pt = this.svgPoint(e);
    if (['turn', 'split', 'socket', 'switch', 'light'].includes(this.tool)) {
      this.showPreview(pt);
    }
  }

  showPreview(pt) {
    const old = this.svg.querySelector('.preview');
    if (old) old.remove();
    const x = this.posX(clamp(this.xPos(pt.x), 0, this.view.len));
    const y = this.heightY(clamp(this.yHeight(pt.y), 0, this.view.h));
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
  renderInfo() {
    this.infoEl.innerHTML = '';
    if (!this.data) return;
    const toolHints = {
      select: '拖动节点可调整其沿墙位置与高度。',
      wire: this.wirePending ? '已选第一个端点，点击第二个端点完成连线。' : '依次点击两个端点/设备来连接电线。',
      turn: '点击墙面放置转弯端点。',
      split: '点击墙面放置分线端点。',
      socket: '点击墙面放置插座。',
      switch: '点击墙面放置开关。',
      light: '点击墙面放置灯具。',
      remove: '点击节点/电线/连通线进行删除。',
      link: this.linkPending ? '点击下方列表中的候选节点完成连通。' : '点击一个端点，选择要连通的另一端点（跨墙两面或转角相邻墙）。',
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

      const mkInput = (label, value, onch) => {
        const row = document.createElement('div');
        row.style.marginBottom = '6px';
        const lab = document.createElement('div');
        lab.style.cssText = 'font-size:12px;color:#888;margin-bottom:2px;';
        lab.textContent = label;
        const input = document.createElement('input');
        input.type = 'number'; input.step = '0.05'; input.value = value;
        input.style.cssText = 'width:100%;padding:3px 6px;border:1px solid #bbb;border-radius:4px;';
        input.addEventListener('change', () => { onch(parseFloat(input.value) || 0); this.changed(); });
        row.appendChild(lab); row.appendChild(input);
        this.infoEl.appendChild(row);
      };
      mkInput('沿墙位置 (m)', node.pos, v => { node.pos = clamp(v, 0, this.view.len); });
      mkInput('离地高度 (m)', node.height, v => { node.height = clamp(v, 0, this.view.h); });

      const labRow = document.createElement('div');
      labRow.style.marginBottom = '6px';
      const lab = document.createElement('div');
      lab.style.cssText = 'font-size:12px;color:#888;margin-bottom:2px;';
      lab.textContent = '说明';
      const input = document.createElement('input');
      input.type = 'text'; input.value = node.label || '';
      input.placeholder = '标注文字';
      input.style.cssText = 'width:100%;padding:3px 6px;border:1px solid #bbb;border-radius:4px;';
      input.addEventListener('change', () => { node.label = input.value; this.changed(); });
      labRow.appendChild(lab); labRow.appendChild(input);
      this.infoEl.appendChild(labRow);

      const wires = this.data.wires.filter(w => w.from === node.id || w.to === node.id);
      const meta = document.createElement('p');
      meta.style.cssText = 'font-size:12px;color:#888;';
      meta.textContent = `连接电线：${wires.length} 段`;
      this.infoEl.appendChild(meta);
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
    // 跨墙另一面：自动镜像
    const mirror = this.data.nodes.find(n =>
      n.wall === self.wall && n.face !== self.face &&
      Math.abs(n.pos - self.pos) < 0.01 && Math.abs(n.height - self.height) < 0.01);
    if (!mirror) {
      cands.unshift({ node: null, mirror: true, desc: `在 ${this.wall().id} 墙 ${self.face === 0 ? 'B' : 'A'} 面创建对应节点` });
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

function linkDesc(data, node) {
  const name = node.type === 'device'
    ? `设备(${(DEVICE_TYPES[node.deviceType] || {}).name})`
    : NODE_TYPE_NAMES[node.type] || node.type;
  return `墙${node.wall} ${node.face === 0 ? 'A' : 'B'}面 · ${name} @${node.pos.toFixed(2)}m`;
}

function el(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function round2(v) { return Math.round(v * 100) / 100; }
