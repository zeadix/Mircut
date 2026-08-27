export interface Track {
  id: string;
  kind: "Video" | "Audio";
  name: string;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
}

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

export interface ClipFx {
  opacity: Animatable;
  scale: Animatable;
  rotate: Animatable;
  x_offset: Animatable;
  y_offset: Animatable;
  grade: ColorGrade;
  volume: Animatable;
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
}

export interface Document {
  timebase: { num: number; den: number };
  tracks: Track[];
  clips: Clip[];
  assets: Asset[];
  transitions?: Transition[];
}

export interface Waveform {
  peaks: number[];
  samples_per_sec: number;
  duration_secs: number;
}
