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

export interface Clip {
  id: string;
  track_id: string;
  start: number;
  duration: number;
  asset: AssetRef;
  speed: number;
  volume: number;
  muted: boolean;
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
}

export interface Waveform {
  peaks: number[];
  samples_per_sec: number;
  duration_secs: number;
}
