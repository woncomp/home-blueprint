// 数据加载 / 导出 / 导入
import { validateData, createEmptyData } from './model.js';

export async function loadDefaultData() {
  try {
    const res = await fetch('data/default.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const err = validateData(data);
    if (err) throw new Error(err);
    return data;
  } catch (e) {
    console.warn('默认数据加载失败，使用空数据:', e.message);
    return createEmptyData();
  }
}

export function exportJson(data) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'electrical-design.json';
  a.click();
  URL.revokeObjectURL(url);
}

export function importJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const err = validateData(data);
        if (err) reject(new Error(err));
        else resolve(data);
      } catch (e) {
        reject(new Error('JSON 解析失败: ' + e.message));
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}
