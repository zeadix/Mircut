//! 性能基准:滤镜图编译吞吐(导出时长核心分量;规格 3.5 性能验收)。

use criterion::{criterion_group, criterion_main, Criterion};
use veditor_core::{Asset, AssetRef, Clip, Document, Timebase, Track, TrackKind};
use veditor_export::{compile_ffmpeg_cmd, ExportParams};

fn bench_doc(n_tracks: usize, clips_per_track: usize) -> Document {
    let mut doc = Document {
        timebase: Timebase { num: 30, den: 1 },
        ..Default::default()
    };
    doc.assets.push(Asset {
        id: "a1".into(),
        path: "/tmp/x.mp4".into(),
        duration_secs: 600.0,
        has_video: true,
        has_audio: true,
        width: Some(1920),
        height: Some(1080),
        name: None,
        fps: None,
        tags: vec![],
    });
    for t in 0..n_tracks {
        doc.tracks.push(Track {
            id: format!("v{t}"),
            kind: TrackKind::Video,
            name: format!("V{t}"),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
        });
        for i in 0..clips_per_track {
            doc.clips.push(Clip {
                id: format!("c{t}_{i}"),
                track_id: format!("v{t}"),
                start: (i * 30) as i64,
                duration: 30,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 1.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
        }
    }
    doc
}

fn bench_compile(c: &mut Criterion) {
    let params = ExportParams::default();
    // 规格 3.5:8 轨工程规模
    let doc8 = bench_doc(8, 10);
    c.bench_function("compile/8tracks_80clips", |b| {
        b.iter(|| compile_ffmpeg_cmd(&doc8, &params))
    });
    // 大工程压力:100 片段单轨
    let doc100 = bench_doc(1, 100);
    c.bench_function("compile/100clips", |b| {
        b.iter(|| compile_ffmpeg_cmd(&doc100, &params))
    });
}

criterion_group!(benches, bench_compile);
criterion_main!(benches);
