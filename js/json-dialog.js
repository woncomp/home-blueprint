// “查看 JSON”弹窗控制器：文本展示/编辑、应用、保存文件、关闭。
// 通过 onApply(text)/onSave(text) 回调与主程序解耦：
// onApply 抛错 → 显示错误并保持打开；正常返回 → 视为已提交，关闭弹窗。
export class JsonDialog {
  constructor({ onApply, onSave }) {
    this.onApply = onApply;
    this.onSave = onSave;
    this.dialog = document.getElementById('json-dialog');
    this.backdrop = document.getElementById('json-dialog-backdrop');
    this.errorEl = document.getElementById('json-dialog-error');
    this.editor = document.getElementById('json-editor');
    this.openBtn = document.getElementById('btn-view-json');
    this.bound = false;
    this.bindEvents();
  }

  bindEvents() {
    if (this.bound) return; // 防止重复绑定
    this.bound = true;
    document.getElementById('btn-json-apply').addEventListener('click', () => this.apply());
    document.getElementById('btn-json-save').addEventListener('click', () => this.save());
    document.getElementById('btn-json-close').addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', () => this.close());
    this.editor.addEventListener('input', () => this.clearError()); // 再次编辑即清除旧错误
    // 捕获阶段拦截 Esc：弹窗打开期间独占该键，只关闭弹窗，不触发底层（如户型编辑）的 Esc 行为
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !this.isOpen()) return;
      e.stopPropagation();
      this.close();
    }, true);
  }

  isOpen() {
    return !this.dialog.classList.contains('hidden');
  }

  open(jsonText) {
    this.editor.value = jsonText; // 总是以主程序传入的最新快照覆盖上次草稿
    this.clearError();
    this.dialog.classList.remove('hidden');
    this.editor.focus();
  }

  close() {
    if (!this.isOpen()) return;
    this.dialog.classList.add('hidden');
    this.clearError();
    this.openBtn.focus(); // 焦点还给触发按钮
  }

  apply() {
    this.clearError(); // 每次应用前先清空，避免把历史结果误认为本次结果
    try {
      this.onApply(this.editor.value);
      this.close(); // 回调正常返回（数据已提交）才关闭
    } catch (e) {
      this.showError('应用失败：' + e.message); // 保持打开，文本与实际布局均不变
    }
  }

  save() {
    try {
      this.onSave(this.editor.value); // 下载文本框当前内容，不触发应用
    } catch (e) {
      this.showError('保存失败：' + e.message);
    }
  }

  showError(message) {
    this.errorEl.textContent = message;
    this.errorEl.title = message; // 长错误省略显示，完整内容保留在 title
    this.errorEl.classList.remove('hidden');
  }

  clearError() {
    this.errorEl.textContent = '';
    this.errorEl.title = '';
    this.errorEl.classList.add('hidden');
  }
}
