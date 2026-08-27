//! 性能基准:命令延迟(<5ms)与快照序列化(<50ms,规格 3.5)。

use criterion::{criterion_group, criterion_main, Criterion};
use veditor_core::{
    AddClip, Asset, AssetRef, Clip, CommandStack, Document, Timebase, Track, TrackKind,
};

fn bench_doc(n_clips: usize) -> Document {
    let mut doc = Document {
        timebase: Timebase { num: 30, den: 1 },
        ..Default::default()
    };
    doc.tracks.push(Track {
        id: "v1".into(),
        kind: TrackKind::Video,
        name: "V1".into(),
        locked: false,
        hidden: false,
        muted: false,
    });
    doc.assets.push(Asset {
        id: "a1".into(),
        path: "/tmp/x.mp4".into(),
        duration_secs: 600.0,
        has_video: true,
        has_audio: true,
        width: Some(1920),
        height: Some(1080),
    });
    for i in 0..n_clips {
        doc.clips.push(Clip {
            id: format!("c{i}"),
            track_id: "v1".into(),
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
            fx: Default::default(),
        });
    }
    doc
}

fn bench_command(c: &mut Criterion) {
    c.bench_function("add_clip_command/1000clips", |b| {
        b.iter_batched(
            || (bench_doc(1000), CommandStack::new()),
            |(mut doc, mut stack)| {
                stack.execute(
                    &mut doc,
                    Box::new(AddClip {
                        clip: Clip {
                            id: "new".into(),
                            track_id: "v1".into(),
                            start: 0,
                            duration: 30,
                            asset: AssetRef {
                                asset_id: "a1".into(),
                                source_in: 0.0,
                                source_out: 1.0,
                            },
                            speed: 1.0,
                            volume: 1.0,
                            muted: false,
                            fx: Default::default(),
                        },
                    }),
                );
            },
            criterion::BatchSize::SmallInput,
        )
    });
}

fn bench_snapshot(c: &mut Criterion) {
    let doc = bench_doc(1000);
    c.bench_function("snapshot_serialize/1000clips", |b| {
        b.iter(|| serde_json::to_string(&doc))
    });
}

fn bench_undo(c: &mut Criterion) {
    c.bench_function("undo/1000clips", |b| {
        b.iter_batched(
            || {
                let mut doc = bench_doc(1000);
                let mut stack = CommandStack::new();
                stack.execute(
                    &mut doc,
                    Box::new(AddClip {
                        clip: Clip {
                            id: "new".into(),
                            track_id: "v1".into(),
                            start: 0,
                            duration: 30,
                            asset: AssetRef {
                                asset_id: "a1".into(),
                                source_in: 0.0,
                                source_out: 1.0,
                            },
                            speed: 1.0,
                            volume: 1.0,
                            muted: false,
                            fx: Default::default(),
                        },
                    }),
                );
                (doc, stack)
            },
            |(mut doc, mut stack)| {
                stack.undo(&mut doc);
            },
            criterion::BatchSize::SmallInput,
        )
    });
}

criterion_group!(benches, bench_command, bench_snapshot, bench_undo);
criterion_main!(benches);
