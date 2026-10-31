// 右侧信息栏：强电箱 2D 布局 + 选中实体信息/属性编辑
import { DEVICE_TYPES, NODE_TYPE_NAMES, wallLen, wiresAt } from './model.js';

export class Panel {
  constructor(dataProvider) {
    // dataProvider: () => data；编辑通过回调
    this.dataProvider = dataProvider;
    this.cbs = {};
    this.highlightedBreaker = null;
    this.breakerListEl = document.getElementById('breaker-list');
    this.entityInfoEl = document.getElementById('entity-info');
  }

  on(event, cb) { this.cbs[event] = cb; }
  emit(event, arg) { if (this.cbs[event]) this.cbs[event](arg); }

  update(data, circuits, selection) {
    this.renderBreakerBox(data, circuits);
    this.renderEntity(data, circuits, selection);
  }

  // ---------- 强电箱 2D 布局 ----------
  renderBreakerBox(data, circuits) {
    const box = data.breakerBox;
    this.breakerListEl.innerHTML = '';
    if (!box) {
      this.breakerListEl.innerHTML = '<p class="placeholder">尚未放置强电箱</p>';
      return;
    }
    // 2D 箱体示意
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 70');
    svg.style.cssText = 'width:100%;background:#3a4048;border-radius:6px;margin-bottom:8px;';
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', 4); rect.setAttribute('y', 4);
    rect.setAttribute('width', 192); rect.setAttribute('height', 62);
    rect.setAttribute('rx', 5);
    rect.setAttribute('fill', '#2c313a');
    rect.setAttribute('stroke', '#5a6472');
    svg.appendChild(rect);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', 14); text.setAttribute('y', 40);
    text.setAttribute('fill', '#9fb4d0');
    text.setAttribute('font-size', '13');
    text.textContent = '⚡ 强电箱';
    svg.appendChild(text);
    this.breakerListEl.appendChild(svg);

    box.breakers.forEach((br, i) => {
      const circuit = circuits.circuits[i];
      const item = document.createElement('div');
      item.className = 'breaker-item' + (this.highlightedBreaker === br.id ? ' highlighted' : '');

      const colorEl = document.createElement('span');
      colorEl.className = 'circuit-color';
      colorEl.style.background = circuit ? circuit.color : '#999';
      item.appendChild(colorEl);

      const labelEl = document.createElement('span');
      labelEl.className = 'breaker-label';
      labelEl.textContent = br.label || `断路器 ${i + 1}`;
      item.appendChild(labelEl);

      const countEl = document.createElement('span');
      countEl.className = 'breaker-count';
      countEl.textContent = circuit ? `${circuit.wireIds.size} 段线` : '未接线';
      item.appendChild(countEl);

      item.addEventListener('click', () => {
        if (this.highlightedBreaker === br.id) {
          this.highlightedBreaker = null;
          this.emit('highlightCircuit', null);
        } else {
          this.highlightedBreaker = br.id;
          this.emit('highlightCircuit', i);
        }
        this.emit('refresh');
      });
      this.breakerListEl.appendChild(item);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'add-breaker-btn';
    addBtn.textContent = '＋ 添加断路器';
    addBtn.addEventListener('click', () => this.emit('addBreaker'));
    this.breakerListEl.appendChild(addBtn);
  }

  // ---------- 选中实体信息 ----------
  renderEntity(data, circuits, selection) {
    this.entityInfoEl.innerHTML = '';
    if (!selection) {
      this.entityInfoEl.innerHTML = '<p class="placeholder">点击 3D 场景中的电线、设备或端点查看详情</p>';
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'entity-detail';
    this.entityInfoEl.appendChild(wrap);

    const addRow = (k, v) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="k">${k}</span>`;
      const vv = document.createElement('span');
      vv.className = 'v';
      if (typeof v === 'string') vv.textContent = v;
      else vv.appendChild(v);
      row.appendChild(vv);
      wrap.appendChild(row);
      return vv;
    };
    const addLabelEditor = (obj, field, name) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = obj[field] || '';
      input.placeholder = `输入${name}`;
      input.addEventListener('change', () => {
        obj[field] = input.value;
        this.emit('edited');
      });
      addRow(name, input);
    };
    const circuitChip = (cIdx) => {
      if (cIdx == null) return document.createTextNode('未接入线路');
      const c = circuits.circuits[cIdx];
      const chip = document.createElement('span');
      chip.className = 'circuit-chip';
      chip.style.background = c.color;
      chip.textContent = c.label || `线路 ${cIdx + 1}`;
      return chip;
    };

    if (selection.kind === 'wire') {
      const wire = data.wires.find(w => w.id === selection.id);
      if (!wire) return;
      const nodes = new Map(data.nodes.map(n => [n.id, n]));
      const title = document.createElement('div');
      title.className = 'entity-title';
      title.textContent = '电线';
      wrap.appendChild(title);
      const cIdx = circuits.wireCircuit.get(wire.id);
      addRow('所属线路', circuitChip(cIdx));
      addRow('起点', nodeDesc(nodes.get(wire.from)));
      addRow('终点', nodeDesc(nodes.get(wire.to)));
      addLabelEditor(wire, 'label', '说明');
      const del = document.createElement('button');
      del.className = 'tool-btn danger';
      del.style.marginTop = '8px';
      del.textContent = '删除电线';
      del.addEventListener('click', () => this.emit('deleteWire', wire.id));
      wrap.appendChild(del);
    } else if (selection.kind === 'node') {
      const node = data.nodes.find(n => n.id === selection.id);
      if (!node) return;
      const title = document.createElement('div');
      title.className = 'entity-title';
      title.textContent = node.type === 'device' ? `设备 · ${(DEVICE_TYPES[node.deviceType] || {}).name || ''}` : (NODE_TYPE_NAMES[node.type] || node.type);
      wrap.appendChild(title);
      const cIdx = circuits.nodeCircuit.get(node.id);
      addRow('所属线路', circuitChip(cIdx));
      const wall = data.walls.find(w => w.id === node.wall);
      addRow('所在墙', wall ? `墙 ${wall.id} · ${node.face === 0 ? 'A 面' : 'B 面'}` : '-');
      const hInput = document.createElement('input');
      hInput.type = 'number';
      hInput.step = '0.05';
      hInput.min = '0';
      hInput.max = String(wall ? wall.height : 3);
      hInput.value = node.height;
      hInput.addEventListener('change', () => {
        node.height = Math.max(0, Math.min(wall ? wall.height : 3, parseFloat(hInput.value) || 0));
        this.emit('edited');
      });
      addRow('离地高度 (m)', hInput);
      if (node.type === 'device') {
        const sel = document.createElement('select');
        for (const [k, v] of Object.entries(DEVICE_TYPES)) {
          const op = document.createElement('option');
          op.value = k; op.textContent = v.name;
          if (node.deviceType === k) op.selected = true;
          sel.appendChild(op);
        }
        sel.addEventListener('change', () => { node.deviceType = sel.value; this.emit('edited'); });
        addRow('设备类型', sel);
      }
      addLabelEditor(node, 'label', '说明');
      const links = (data.links || []).filter(l => l.a === node.id || l.b === node.id);
      if (links.length) addRow('连通', `${links.length} 处连通`);
      const del = document.createElement('button');
      del.className = 'tool-btn danger';
      del.style.marginTop = '8px';
      del.textContent = '删除节点';
      del.addEventListener('click', () => this.emit('deleteNode', node.id));
      wrap.appendChild(del);
    } else if (selection.kind === 'wall') {
      const wall = data.walls.find(w => w.id === selection.id);
      if (!wall) return;
      const title = document.createElement('div');
      title.className = 'entity-title';
      title.textContent = `墙 ${wall.id}`;
      wrap.appendChild(title);
      addRow('长度', `${wallLen(wall).toFixed(2)} m`);
      addRow('高度', `${wall.height || 2.8} m`);
      addRow('选中面', selection.face === 0 ? 'A 面' : 'B 面');
      const nodeCount = data.nodes.filter(n => n.wall === wall.id && n.face === selection.face).length;
      addRow('该面节点', `${nodeCount} 个`);
      const openBtn = document.createElement('button');
      openBtn.className = 'tool-btn';
      openBtn.style.marginTop = '8px';
      openBtn.textContent = '展开该面 2D 视图';
      openBtn.addEventListener('click', () => this.emit('openWallFace', { wallId: wall.id, face: selection.face }));
      wrap.appendChild(openBtn);
    } else if (selection.kind === 'breakerBox') {
      const title = document.createElement('div');
      title.className = 'entity-title';
      title.textContent = '强电箱';
      wrap.appendChild(title);
      addRow('断路器数量', String(data.breakerBox.breakers.length));
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.style.marginTop = '6px';
      p.textContent = '在上方强电箱面板中管理断路器；编辑模式下可沿墙水平拖动箱体。';
      wrap.appendChild(p);
    } else if (selection.kind === 'room') {
      const title = document.createElement('div');
      title.className = 'entity-title';
      title.textContent = '房间';
      wrap.appendChild(title);
      const name = (data.roomNames || {})[selection.id] || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = name;
      input.placeholder = '房间名称';
      input.addEventListener('change', () => {
        if (!data.roomNames) data.roomNames = {};
        data.roomNames[selection.id] = input.value;
        this.emit('edited');
      });
      addRow('名称', input);
    }
  }
}

function nodeDesc(node) {
  if (!node) return '（缺失）';
  if (node.type === 'terminal') return '强电箱端子';
  if (node.type === 'device') return `${(DEVICE_TYPES[node.deviceType] || {}).name || '设备'}${node.label ? ' · ' + node.label : ''}`;
  return (NODE_TYPE_NAMES[node.type] || node.type) + (node.label ? ' · ' + node.label : '');
}
