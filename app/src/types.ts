export interface Track {
  id: string;
  kind: "Video" | "Audio" | "File";
  name: string;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  /// File 轨:视频/音频块是否参与合成(预览+导出;默认 true)。
  video_on?: boolean;
  audio_on?: boolean;
  /// 图片(定格)块是否参与合成。
  image_on?: boolean;
  /// 文字块是否参与合成。
  text_on?: boolean;
}

/// 文件轨道分块区:Video=上半(绿) Audio=下半(蓝)。
export type Lane = "Video" | "Audio";

export interface AssetRef {
  asset_id: string;
  source_in: number;
  source_out: number;
}

export interface Keyframe {
  t: number;
  value: number;
  interp: "Linear" | "Hold" | "Smooth" | "Bezier";
  /// Bezier 控制点(interp=Bezier 时有效)。
  c1x?: number;
  c1y?: number;
  c2x?: number;
  c2y?: number;
}

export interface Animatable {
  keyframes: Keyframe[];
}

export interface ColorGrade {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
}

export interface ChromaKey {
  similarity: number;
  color: string;
  blend: number;
}

export interface AudioFx {
  fade_in: number;
  fade_out: number;
  denoise: number;
  pitch_semitones: number;
  eq_low: number;
  eq_mid: number;
  eq_high: number;
  stem?: "None" | "Vocals" | "Instrumental";
}

export interface LutApply {
  path: string;
  strength: number;
}

/// 画面矩形(归一化):x/y 中心点,w/h 宽高(可越界,导出裁剪)。
/// stretch=true 时强行拉伸到 rect 宽高不保比例("全屏平铺");
/// 缺省 = rect 框内等比 contain。
export interface FxRect {
  x: number;
  y: number;
  w: number;
  h: number;
  stretch?: boolean;
}

export interface Mask {
  kind: "Rect" | "Linear";
  x: number;
  y: number;
  w: number;
  h: number;
  feather: number;
  invert: boolean;
}

/// 片段入场/出场动画种类。
/// 入场方向语义:SlideLeft=从右滑入、SlideRight=从左滑入、SlideUp=从下滑入、
/// SlideDown=从上滑入;ZoomIn=放大进入(0.3→1)、ZoomOut=缩小进入(2→1)。
/// 出场对称(向左滑出/放大消失 1→2/缩小消失 1→0.3)。
export type ClipAnimKind =
  | "Fade"
  | "SlideLeft"
  | "SlideRight"
  | "SlideUp"
  | "SlideDown"
  | "ZoomIn"
  | "ZoomOut";

/// 入场/出场动画预设(种类 + 时长秒)。
export interface ClipAnim {
  kind: ClipAnimKind;
  dur_secs: number;
}

export interface ClipFx {
  opacity: Animatable;
  scale: Animatable;
  rotate: Animatable;
  x_offset: Animatable;
  y_offset: Animatable;
  /// 速度关键帧(>=2 帧生效,时长自动反解)。
  speed: Animatable;
  grade: ColorGrade;
  volume: Animatable;
  chroma_key?: ChromaKey;
  audio_fx?: AudioFx;
  lut?: LutApply;
  mask?: Mask;
  blend_mode?: "Normal" | "Multiply" | "Screen" | "Overlay" | "Darken" | "Lighten" | "Difference" | "Addition";
  rect?: FxRect;
  /// AI 人像抠像(RVM alpha 序列)。
  alpha_matting?: AlphaMatting;
  /// 入场动画(片段开头 dur_secs 内)。
  enter?: ClipAnim;
  /// 出场动画(片段结尾 dur_secs 内)。
  exit?: ClipAnim;
  /** 音频时差(秒;正=延后,负=提前;视频块上,配对音频按此平移)。 */
  audio_offset_secs?: number;
}

/// 文字片段内容与样式(字号为 1080p 画布基准像素)。
export interface TextClipData {
  content: string;
  font_size: number;
  color: string;
  outline?: string;
  outline2?: string;
  bold: boolean;
  shadow: boolean;
  bg_color?: string;
  /// 框内水平对齐(left/center/right;默认 center)。
  align_h?: "left" | "center" | "right";
  /// 框内垂直对齐(top/middle/bottom;默认 middle)。
  align_v?: "top" | "middle" | "bottom";
  /** 字体族名(空 = 默认字体)。 */
  font?: string;
  /** 斜体。 */
  italic?: boolean;
}

export interface AlphaMatting {
  dir: string;
  smooth_frames: number;
  /// 边缘精修强度(0=关)。
  refine?: number;
}

export interface Clip {
  id: string;
  track_id: string;
  start: number;
  duration: number;
  asset: AssetRef;
  speed: number;
  volume: number;
  muted: boolean;
  lane?: Lane | null;
  fx?: ClipFx;
  /// 文字片段(Some = 文字;asset 为合成资产 text://…)。
  text?: TextClipData;
}

export interface Transition {
  id: string;
  left_clip_id: string;
  right_clip_id: string;
  kind:
    | "Fade"
    | "Dissolve"
    | "SlideLeft"
    | "SlideRight"
    | "Zoom"
    | "WipeLeft"
    | "WipeRight"
    | "WipeUp"
    | "WipeDown"
    | "CircleOpen"
    | "CircleClose"
    | "FadeBlack"
    | "FadeWhite"
    | "Radial"
    | "Pixelize";
  duration_secs: number;
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface SubtitleStyle {
  font_size: number;
  color: string;
  outline: string | null;
  bold: boolean;
}

export interface SubtitleTrack {
  cues: SubtitleCue[];
  style: SubtitleStyle;
}

/// 贴纸(图片叠层)。
export interface ImageOverlay {
  id: string;
  start: number;
  end: number;
  path: string;
  x: number;
  y: number;
  scale: number;
  rotate: number;
  opacity: number;
}

/// 时间轴标记(M 键打点)。
export interface Marker {
  t: number;
  label: string;
}

export interface Asset {
  id: string;
  path: string;
  duration_secs: number;
  has_video: boolean;
  has_audio: boolean;
  width: number | null;
  height: number | null;
  fps?: number | null;
  /// 显示名(None = 文件名)。
  name?: string | null;
  tags?: string[];
}

export interface TextOverlay {
  id: string;
  start: number;
  end: number;
  text: string;
  font_size: number;
  color: string;
  outline: string | null;
  bold: boolean;
  shadow?: boolean;
  bg_color?: string | null;
  outline2?: string | null;
  animation?: "None" | "FadeIn" | "SlideUp" | "Zoom";
  x: number;
  y: number;
}

export interface Document {
  timebase: { num: number; den: number };
  tracks: Track[];
  clips: Clip[];
  assets: Asset[];
  /// 合成画布分辨率(预览舞台与导出画面的共同真源;旧工程缺省 1920x1080)。
  width?: number;
  height?: number;
  transitions?: Transition[];
  subtitles?: SubtitleTrack;
  text_overlays?: TextOverlay[];
  markers?: Marker[];
  image_overlays?: ImageOverlay[];
}

export interface Waveform {
  peaks: number[];
  samples_per_sec: number;
  duration_secs: number;
}
