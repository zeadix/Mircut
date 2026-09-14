/// 轻量 i18n:zh/en 词典 + 语言状态(localStorage 持久化)。
/// 覆盖高频 UI 文案;canvas 自绘与深层面板文案后续批次全量抽取。
export type Lang = "zh" | "en";

const KEY = "veditor-lang";

const DICT: Record<Lang, Record<string, string>> = {
  zh: {
    "app.title": "VEditor",
    "menu.file": "文件",
    "menu.edit": "编辑",
    "menu.view": "视图",
    "menu.tools": "工具",
    "menu.layout": "布局",
    "menu.window": "窗口",
    "menu.newFileTrack": "新建文件轨道",
    "menu.resetLayout": "重置布局",
    "menu.saveLayout": "保存当前布局",
    "menu.panelMedia": "媒体库",
    "menu.panelPreview": "预览",
    "menu.panelTimeline": "时间轴",
    "menu.panelInspector": "属性面板",
    "menu.new": "新建工程",
    "menu.open": "打开…",
    "menu.save": "保存",
    "menu.saveAs": "另存为…",
    "menu.importJianying": "导入剪映草稿…",
    "menu.recent": "最近的工程",
    "menu.undo": "撤销 (Ctrl+Z)",
    "menu.redo": "重做 (Ctrl+Shift+Z)",
    "menu.split": "分割 (S)",
    "menu.delete": "删除 (Del)",
    "menu.ripple": "删除并前移(后续块补位)",
    "menu.fileTrack": "文件轨道",
    "menu.beats": "节拍",
    "menu.removeSilence": "去静音",
    "menu.export": "导出",
    "menu.image": "图像",
    "menu.imageSize": "图像尺寸",
    "image.fill": "全屏平铺",
    "image.fillHint": "拉伸铺满画布(四边对齐)",
    "image.fit": "等比例平铺",
    "image.fitHint": "等比缩放至画布(不超出)",
    "image.native": "视频默认分辨率",
    "menu.theme": "切换亮/暗主题",
    "media.import": "导入",
    "media.musicLib": "音乐库",
    "media.search": "搜索/标签过滤...",
    "media.grid": "切换为网格视图",
    "media.list": "切换为列表视图",
    "play.play": "播放",
    "play.pause": "暂停",
    "play.speed": "播放倍率",
    "play.engine": "渲染引擎",
    "play.proxy": "代理引擎",
    "play.realtime": "实时引擎(管道)",
    "res.custom": "自定义…",
    "res.namePh": "名称(可空,默认 宽×高)",
    "res.ok": "确定",
    "res.cancel": "取消",
    "res.edit": "编辑",
    "res.remove": "删除",
    "res.customHint": "自定义分辨率保存在本机浏览器",
    "panel.inspector": "属性",
    "panel.scopes": "示波器",
    "panel.markers": "标记",
    "panel.subtitles": "字幕",
    "panel.texts": "文字",
    "panel.stickers": "贴纸",
    "panel.packs": "素材包",
    "export.title": "导出视频",
    "export.preset": "预设:",
    "export.encoder": "编码器:",
    "export.software": "软件 libx264",
    "export.hardware": "硬件",
    "export.loudness": "响度标准化 (-14 LUFS, 对标流媒体)",
    "export.path": "路径:",
    "export.browse": "浏览…",
    "export.cmdPreview": "FFmpeg 命令预览",
    "export.queue": "导出队列",
    "export.enqueue": "加入队列",
    "export.enqueueAll": "全部预设入队",
    "export.pause": "⏸ 暂停队列",
    "export.resume": "▶ 继续",
    "export.cleanup": "清理已完成",
    "export.close": "关闭",
    "export.publishDouyin": "一键发布(抖音)",
    "export.publishBili": "一键发布(B站)",
    "export.start": "导出视频",
    "export.exporting": "导出中…",
    "export.cancel": "取消",
    "export.remove": "移除任务",
    "export.queueEmpty": "空:配置预设/路径后点'加入队列'",
    "status.loading": "加载中...",
  },
  en: {
    "app.title": "VEditor",
    "menu.file": "File",
    "menu.edit": "Edit",
    "menu.view": "View",
    "menu.tools": "Tools",
    "menu.layout": "Layout",
    "menu.window": "Window",
    "menu.newFileTrack": "New File Track",
    "menu.resetLayout": "Reset Layout",
    "menu.saveLayout": "Save Current Layout",
    "menu.panelMedia": "Media Library",
    "menu.panelPreview": "Preview",
    "menu.panelTimeline": "Timeline",
    "menu.panelInspector": "Inspector",
    "menu.new": "New Project",
    "menu.open": "Open…",
    "menu.save": "Save",
    "menu.saveAs": "Save As…",
    "menu.importJianying": "Import CapCut Draft…",
    "menu.recent": "Recent Projects",
    "menu.undo": "Undo (Ctrl+Z)",
    "menu.redo": "Redo (Ctrl+Shift+Z)",
    "menu.split": "Split (S)",
    "menu.delete": "Delete (Del)",
    "menu.ripple": "Delete & Shift Left",
    "menu.fileTrack": "File Track",
    "menu.beats": "Beats",
    "menu.removeSilence": "Remove Silence",
    "menu.export": "Export",
    "menu.image": "Image",
    "menu.imageSize": "Image Size",
    "image.fill": "Stretch to Fill",
    "image.fillHint": "Stretch to canvas (edge-aligned)",
    "image.fit": "Fit Proportionally",
    "image.fitHint": "Scale to canvas (no overflow)",
    "image.native": "Video Native Size",
    "menu.theme": "Toggle light/dark theme",
    "media.import": "Import",
    "media.musicLib": "Music Lib",
    "media.search": "Search / tag filter...",
    "media.grid": "Switch to grid view",
    "media.list": "Switch to list view",
    "play.play": "Play",
    "play.pause": "Pause",
    "play.speed": "Playback speed",
    "play.engine": "Render engine",
    "play.proxy": "Proxy engine",
    "play.realtime": "Realtime engine (pipe)",
    "res.custom": "Custom…",
    "res.namePh": "Name (optional, defaults to WxH)",
    "res.ok": "OK",
    "res.cancel": "Cancel",
    "res.edit": "Edit",
    "res.remove": "Delete",
    "res.customHint": "Custom resolutions are saved locally",
    "panel.inspector": "Inspector",
    "panel.scopes": "Scopes",
    "panel.markers": "Markers",
    "panel.subtitles": "Subtitles",
    "panel.texts": "Text",
    "panel.stickers": "Stickers",
    "panel.packs": "Packs",
    "export.title": "Export Video",
    "export.preset": "Preset:",
    "export.encoder": "Encoder:",
    "export.software": "Software libx264",
    "export.hardware": "Hardware",
    "export.loudness": "Loudness normalize (-14 LUFS, streaming target)",
    "export.path": "Path:",
    "export.browse": "Browse…",
    "export.cmdPreview": "FFmpeg command preview",
    "export.queue": "Export queue",
    "export.enqueue": "Add to queue",
    "export.enqueueAll": "Enqueue all presets",
    "export.pause": "⏸ Pause queue",
    "export.resume": "▶ Resume",
    "export.cleanup": "Clear finished",
    "export.close": "Close",
    "export.publishDouyin": "Publish (Douyin)",
    "export.publishBili": "Publish (Bilibili)",
    "export.start": "Export Video",
    "export.exporting": "Exporting…",
    "export.cancel": "Cancel",
    "export.remove": "Remove task",
    "export.queueEmpty": "Empty: set preset/path then 'Add to queue'",
    "status.loading": "Loading...",
  },
};

let current: Lang = "zh";
const listeners = new Set<() => void>();

export function t(key: string): string {
  return DICT[current][key] ?? DICT.zh[key] ?? key;
}

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang) {
  current = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* 忽略 */
  }
  listeners.forEach((fn) => fn());
}

export function initLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "zh" || saved === "en") current = saved;
  } catch {
    /* 忽略 */
  }
}

/// 订阅语言变更(组件用 useSyncExternalStore)。
export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLangSnapshot(): Lang {
  return current;
}
