// 数据加载 / JSON 文本解析校验 / 文本下载
import { validateData, createEmptyData, normalizeData } from './model.js';

export async function loadDefaultData() {
  try {
    const res = await fetch('data/default.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseJsonText(await res.text());
  } catch (e) {
    console.warn('默认数据加载失败，使用空数据:', e.message);
    return createEmptyData();
  }
}

// JSON 文本 → 数据对象，顺序固定为：解析 → 迁移/兼容处理 → 校验。
// 成功返回全新解析出的对象；失败抛出带中文原因的 Error。
// 只操作解析出的新对象，不触碰调用方的现有数据，因此失败路径零副作用。
export function parseJsonText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 解析失败: ' + e.message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('JSON 根节点必须是对象');
  }
  try {
    data = normalizeData(data);
  } catch (e) {
    throw new Error('数据迁移失败: ' + e.message);
  }
  const err = validateData(data);
  if (err) throw new Error(err);
  return data;
}

// 把 JSON 文本按原样下载为本地 .json 文件（沿用原“导出 JSON”的文件名与方式）
export function exportJsonText(text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'electrical-design.json';
  a.click();
  URL.revokeObjectURL(url);
}
