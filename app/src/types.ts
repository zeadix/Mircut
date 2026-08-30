export interface Track {
  id: string;
  kind: "Video" | "Audio" | "File";
  name: string;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
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
export interface FxRect {
  x: number;
  y: number;
  w: number;
  h: number;
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
}

export interface Transition {
  id: string;
  left_clip_id: string;
  right_clip_id: string;
  kind: "Fade" | "Dissolve" | "SlideLeft" | "SlideRight" | "Zoom";
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
  animation?: "None" | "FadeIn" | "SlideUp" | "Zoom";
  x: number;
  y: number;
}

export interface Document {
  timebase: { num: number; den: number };
  tracks: Track[];
  clips: Clip[];
  assets: Asset[];
  transitions?: Transition[];
  subtitles?: SubtitleTrack;
  text_overlays?: TextOverlay[];
  markers?: Marker[];
}

export interface Waveform {
  peaks: number[];
  samples_per_sec: number;
  duration_secs: number;
}
