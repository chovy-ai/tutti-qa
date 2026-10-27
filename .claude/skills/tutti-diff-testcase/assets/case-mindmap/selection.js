// Only leaf usage is stored. Parent checkboxes are derived from all descendants.
class CaseSelection {
  constructor(ids, suiteId, storage, seed = null) {
    this.ids = [...ids];
    this.known = new Set(ids);
    this.suiteId = suiteId;
    this.key = 'tutti-case-usage:v1:' + suiteId;
    this.storage = storage;
    this.selected = Object.fromEntries(ids.map(id => [id, true]));
    this.updatedAt = '';
    this.notice = '默认全部勾选；可导出勾选结果。';
    try {
      if (seed) this.restore(seed);
      const raw = storage?.getItem(this.key);
      if (raw) this.restore(JSON.parse(raw));
    } catch {
      this.notice = '无法读取浏览器勾选记录，请核对当前选择并导出备份。';
    }
  }
  restore(value) {
    if (!value || value.schema !== 'tutti-case-usage' || value.version !== 1 || value.suiteId !== this.suiteId ||
        typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) ||
        !value.selected || Array.isArray(value.selected) || Object.keys(value.selected).length !== this.ids.length ||
        this.ids.some(id => !Object.hasOwn(value.selected, id) || typeof value.selected[id] !== 'boolean'))
      throw new Error('勾选记录与当前用例不匹配。');
    if (this.updatedAt && Date.parse(value.updatedAt) < Date.parse(this.updatedAt)) return;
    this.selected = Object.fromEntries(this.ids.map(id => [id, value.selected[id]]));
    this.updatedAt = value.updatedAt;
    this.notice = '已恢复勾选记录；跨设备请导出或保存勾选版 HTML。';
  }
  inspect(ids) {
    const count = ids.reduce((n, id) => n + (this.selected[id] ? 1 : 0), 0);
    return {count, total: ids.length, checked: ids.length > 0 && count === ids.length,
      indeterminate: count > 0 && count < ids.length};
  }
  set(ids, keep) {
    if (typeof keep !== 'boolean' || ids.some(id => !this.known.has(id))) throw new Error('未知节点或无效勾选值。');
    try {
      const raw = this.storage?.getItem(this.key);
      if (raw) this.restore(JSON.parse(raw));
    } catch { /* In-memory selection remains usable in restricted previews. */ }
    for (const id of ids) this.selected[id] = keep;
    this.updatedAt = new Date(Math.max(Date.now(), (Date.parse(this.updatedAt) || 0) + 1)).toISOString();
    try {
      if (!this.storage) throw new Error('storage unavailable');
      const raw = JSON.stringify(this.snapshot());
      this.storage.setItem(this.key, raw);
      if (this.storage.getItem(this.key) !== raw) throw new Error('save not verified');
      this.notice = '勾选已保存到当前浏览器；可导出或保存 HTML 备份。';
    } catch {
      this.notice = '当前仅本页暂存，请在关闭前导出勾选结果或保存勾选版 HTML。';
    }
  }
  snapshot() {
    return {schema: 'tutti-case-usage', version: 1, suiteId: this.suiteId,
      updatedAt: this.updatedAt || new Date().toISOString(), selected: {...this.selected}};
  }
}

function confirmationText(meta, selected, suiteId) {
  if (!meta) return '用例使用勾选清单（尚未确认合并）' + String.fromCharCode(10) +
    'TUTTI-QA-SELECTION ' + JSON.stringify({suiteId, selected});
  const decisions = new Map();
  for (const c of meta.cases) for (const key of c.keys) decisions.set(key, selected[c.id] === true);
  for (const [key, owners] of Object.entries(meta.extraKeys)) decisions.set(key, owners.some(id => selected[id] === true));
  const kept = meta.cases.filter(c => selected[c.id] === true).length;
  return '用例选择：使用 ' + kept + ' / ' + meta.cases.length + ' 条用例' + String.fromCharCode(10) +
    'TUTTI-QA-CASES ' + JSON.stringify({batch: meta.batch, hash: meta.hash,
      decisions: meta.allKeys.map(key => ({key, keep: decisions.get(key) === true}))});
}
