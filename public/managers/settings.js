/**
 * 设置面板状态与创作活跃度统计：负责读写本地偏好项（自动保存提示间隔、打印折叠开关），
 * 并基于文章元数据的 createdAt / updatedAt / editCount / lastEditAt 纯函数汇总
 * GitHub 风格贡献热力图（按自然周 7×N 网格、月份坐标与四档热度阶梯）及核心统计指标。
 */

const MONTH_SHORT_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

export function toLocalDateKey(timestamp) {
  const num = Number(timestamp);
  if (!Number.isFinite(num) || num <= 0) return '';
  const d = new Date(num);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function computeNotepadActivityStats(notepads = [], { now = Date.now(), weeks = 34, mode = 'all' } = {}) {
  const list = Array.isArray(notepads)
    ? notepads.filter(item => item && typeof item.id === 'string' && item.id.trim() !== '')
    : [];
  const weekCount = Math.max(12, Math.min(53, Number(weeks) || 34));
  const dailyMap = new Map();
  const allActiveDates = new Set();

  const ensureDay = (dateKey) => {
    if (!dateKey) return null;
    let bucket = dailyMap.get(dateKey);
    if (!bucket) {
      bucket = { created: 0, updated: 0, edits: 0 };
      dailyMap.set(dateKey, bucket);
    }
    return bucket;
  };

  let totalEdits = 0;
  let recentNotes30d = 0;
  let latestNotepad = null;
  const recentCutoff = now - 30 * DAY_MS;

  for (const note of list) {
    const createdAt = Number(note.createdAt) || 0;
    const updatedAt = Number(note.updatedAt) || createdAt;
    const lastEditAt = Number(note.lastEditAt) || updatedAt;
    const editCount = Number.isSafeInteger(note.editCount) && note.editCount > 0 ? note.editCount : 0;

    totalEdits += editCount;
    if (Math.max(createdAt, updatedAt) >= recentCutoff) {
      recentNotes30d += 1;
    }
    if (!latestNotepad || updatedAt > latestNotepad.updatedAt) {
      latestNotepad = {
        id: note.id,
        name: String(note.name || 'Untitled'),
        updatedAt,
        editCount
      };
    }

    const createdKey = toLocalDateKey(createdAt);
    if (createdKey) {
      ensureDay(createdKey).created += 1;
      allActiveDates.add(createdKey);
    }

    const updatedKey = toLocalDateKey(updatedAt);
    if (updatedKey && (updatedAt !== createdAt || !createdKey)) {
      ensureDay(updatedKey).updated += 1;
      allActiveDates.add(updatedKey);
    }

    const editKey = toLocalDateKey(lastEditAt) || updatedKey || createdKey;
    if (editKey && editCount > 0) {
      ensureDay(editKey).edits += editCount;
      allActiveDates.add(editKey);
    }
  }

  const endDate = new Date(now);
  endDate.setHours(0, 0, 0, 0);
  const endDayOfWeek = endDate.getDay(); // 0 = Sun .. 6 = Sat
  const currentWeekSunday = new Date(endDate);
  currentWeekSunday.setDate(endDate.getDate() - endDayOfWeek);

  const startSunday = new Date(currentWeekSunday);
  startSunday.setDate(currentWeekSunday.getDate() - (weekCount - 1) * 7);

  const scoreForBucket = (bucket) => {
    if (!bucket) return 0;
    if (mode === 'edits') return bucket.edits + bucket.updated;
    if (mode === 'created') return bucket.created;
    return bucket.created + bucket.updated + bucket.edits;
  };

  const cells = [];
  const monthLabels = [];
  let lastMonth = -1;
  let lastLabelCol = -4;
  let windowContributions = 0;
  let maxScore = 0;

  for (let col = 0; col < weekCount; col += 1) {
    for (let row = 0; row < 7; row += 1) {
      const cellDate = new Date(startSunday);
      cellDate.setDate(startSunday.getDate() + col * 7 + row);
      const isFuture = cellDate.getTime() > endDate.getTime();
      const dateKey = toLocalDateKey(cellDate.getTime());
      const bucket = isFuture ? null : dailyMap.get(dateKey);
      const created = bucket?.created || 0;
      const updated = bucket?.updated || 0;
      const edits = bucket?.edits || 0;
      const score = isFuture ? 0 : scoreForBucket(bucket);

      if (!isFuture) {
        windowContributions += score;
        if (score > maxScore) maxScore = score;
      }

      if (row === 0) {
        const month = cellDate.getMonth();
        if (month !== lastMonth) {
          if (col - lastLabelCol >= 2) {
            monthLabels.push({ colIndex: col, label: MONTH_SHORT_NAMES[month] });
            lastLabelCol = col;
          }
          lastMonth = month;
        }
      }

      cells.push({
        col,
        row,
        dateKey,
        isFuture,
        created,
        updated,
        edits,
        score,
        level: 0
      });
    }
  }

  for (const cell of cells) {
    if (cell.score <= 0 || cell.isFuture) {
      cell.level = 0;
    } else if (maxScore <= 4) {
      cell.level = Math.min(4, cell.score);
    } else {
      const ratio = cell.score / maxScore;
      if (ratio <= 0.25) cell.level = 1;
      else if (ratio <= 0.5) cell.level = 2;
      else if (ratio <= 0.78) cell.level = 3;
      else cell.level = 4;
    }
    const parts = [];
    if (cell.created > 0) parts.push(`新建 ${cell.created} 篇`);
    if (cell.updated > 0) parts.push(`更新 ${cell.updated} 篇`);
    if (cell.edits > 0) parts.push(`修改 ${cell.edits} 次`);
    cell.tooltip = parts.length > 0
      ? `${cell.dateKey}：${parts.join(' · ')}`
      : `${cell.dateKey}：无记录`;
  }

  return {
    totalNotes: list.length,
    totalEdits,
    activeDays: allActiveDates.size,
    recentNotes30d,
    windowContributions,
    weekCount,
    mode,
    latestNotepad,
    monthLabels,
    cells
  };
}

export default class SettingsManager {
  static computeNotepadActivityStats = computeNotepadActivityStats;

  constructor(storageManager, applySettings) {
    this.storageManager = storageManager;
    this.SETTINGS_KEY = 'dumbpad_settings';
    this.applySettings = applySettings
    this.settingsInputAutoSaveStatusInterval = document.getElementById('autosave-status-interval-input');
    this.settingsDisablePrintExpand = document.getElementById('settings-disable-print-expand');
  }
  
  defaultSettings() {
    return { // Add additional default settings in here:
      saveStatusMessageInterval: 500,
      disablePrintExpand: false,
    }
  }

  getSettings() {
    try {
      let currentSettings = this.storageManager.load(this.SETTINGS_KEY);
      if (!currentSettings) currentSettings = this.defaultSettings();
      // console.log("Current Settings:", currentSettings);
      return currentSettings;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  saveSettings(reset) {
    try {
      const settingsToSave = reset ? this.defaultSettings() : this.getInputValues();
      this.storageManager.save(this.SETTINGS_KEY, settingsToSave);
      // console.log("Saved new settings:", newSettings);
      this.applySettings(settingsToSave);
      return settingsToSave;
    }
    catch (err) {
      console.error(err);
    }
  }

  loadSettings(reset) {
    try {
      const appSettings = this.defaultSettings();
      let currentSettings = this.getSettings();
  
      if (reset || !currentSettings) currentSettings = this.saveSettings(true);
  
      appSettings.saveStatusMessageInterval = currentSettings.saveStatusMessageInterval;
      if (this.settingsInputAutoSaveStatusInterval) {
        this.settingsInputAutoSaveStatusInterval.value = currentSettings.saveStatusMessageInterval;
      }

      appSettings.disablePrintExpand = currentSettings.disablePrintExpand;
      if (this.settingsDisablePrintExpand) {
        this.settingsDisablePrintExpand.checked = currentSettings.disablePrintExpand;
      }
      
      return currentSettings;
    }
    catch (err) {
      console.error(err);
      return this.defaultSettings();
    }
  }

  getInputValues() {
    const appSettings = this.defaultSettings();

    if (this.settingsInputAutoSaveStatusInterval) {
      let newInterval = parseInt(this.settingsInputAutoSaveStatusInterval.value.trim());
      if (isNaN(newInterval) || newInterval <= 0) newInterval = null;
      appSettings.saveStatusMessageInterval = newInterval;
    }

    if (this.settingsDisablePrintExpand) {
      appSettings.disablePrintExpand = this.settingsDisablePrintExpand.checked;
    }
    
    return appSettings;
  }
}
