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
  interp: "Linear" | "Hold" | "Smooth";
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
}

export interface LutApply {
  path: string;
  strength: number;
}

export interface ClipFx {
  opacity: Animatable;
  scale: Animatable;
  rotate: Animatable;
  x_offset: Animatable;
  y_offset: Animatable;
  grade: ColorGrade;
  volume: Animatable;
  chroma_key?: ChromaKey;
  audio_fx?: AudioFx;
  lut?: LutApply;
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
}

export interface Waveform {
  peaks: number[];
  samples_per_sec: number;
  duration_secs: number;
}
