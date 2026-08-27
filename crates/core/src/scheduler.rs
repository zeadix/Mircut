//! 轨道调度器:磁吸推挤(magnetic push)消重叠。
//!
//! 剪映式语义:片段落到已有片段上时,保持落点优先,把挡路的片段
//! 沿推挤方向串行推移;推到轨道边界(0)仍不够时反向让位。
//! 纯函数无副作用,返回变更集供调用方生成可撤销命令。

use serde::{Deserialize, Serialize};

/// 一次摆放调整。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub clip_id: u32,
    pub new_start: i64,
}

/// 调度输入的最小片段视图。
#[derive(Debug, Clone, Copy)]
pub struct SchedClip {
    /// 稳定索引(调用方映射回 clip id)。
    pub idx: usize,
    pub start: i64,
    pub duration: i64,
}

/// 对单轨片段集合消重叠。
/// `moved_idx`:被拖动/新落入的片段索引(保位优先);None = 全量整理(历史脏数据)。
/// 返回发生位移的 (idx, new_start) 列表(不含未移动的)。
pub fn resolve_overlaps(clips: &[SchedClip], moved_idx: Option<usize>) -> Vec<(usize, i64)> {
    if clips.is_empty() {
        return Vec::new();
    }
    // 工作副本
    let mut cs: Vec<SchedClip> = clips.to_vec();
    // 按 (start, 原始顺序) 稳定排序
    cs.sort_by_key(|c| c.start);
    let moved = moved_idx.map(|i| clips[i].start);

    // 第一遍:顺序扫描,向后推挤(右侧片段让位)
    for i in 1..cs.len() {
        let prev_end = cs[i - 1].start + cs[i - 1].duration;
        if cs[i].start < prev_end {
            cs[i].start = prev_end;
        }
    }

    // 第二遍:moved 片段保位(最高优先级):无论空间是否够,
    // 以 mstart 为锚重排 —— 左侧片段被"挤"到其后方,右侧照旧后推。
    if let (Some(midx), Some(mstart)) = (moved_idx, moved) {
        if let Some(pos) = cs.iter().position(|c| c.idx == midx) {
            if cs[pos].start != mstart {
                // 拆出 moved,其余片段先在 [0, ∞) 上自洽(后推消重叠),
                // 再把 moved 插回 mstart:重叠者(mstart 之后开始的)整体右移让位。
                let mut rest: Vec<SchedClip> = cs.clone();
                rest.remove(pos);
                for i in 1..rest.len() {
                    let prev_end = rest[i - 1].start + rest[i - 1].duration;
                    if rest[i].start < prev_end {
                        rest[i].start = prev_end;
                    }
                }
                // 插入 moved:与 moved 区间 [mstart, moved_end) 重叠或在其后的片段整体右移让位
                let moved_end = mstart + clips[midx].duration;
                let mut result: Vec<SchedClip> = Vec::with_capacity(rest.len() + 1);
                let mut cursor = moved_end;
                // 从右往左放置:先处理全部 rest,再插入 moved
                // 简化实现:左侧(完全在 moved 之前结束的)保留;其余依次排在 moved 后
                for c in &rest {
                    let c_end = c.start + c.duration;
                    if c_end <= mstart {
                        // 完全在 moved 之前:保留原位
                        result.push(*c);
                    }
                }
                result.push(SchedClip {
                    idx: midx,
                    start: mstart,
                    duration: clips[midx].duration,
                });
                for c in &rest {
                    let c_end = c.start + c.duration;
                    if c_end > mstart {
                        // 与 moved 重叠或在其后:贴着排
                        let s = c.start.max(cursor);
                        result.push(SchedClip {
                            idx: c.idx,
                            start: s,
                            duration: c.duration,
                        });
                        cursor = s + c.duration;
                    }
                }
                cs = result;
                // 最终校验式后推(防御)
                for i in 1..cs.len() {
                    let prev_end = cs[i - 1].start + cs[i - 1].duration;
                    if cs[i].start < prev_end {
                        cs[i].start = prev_end;
                    }
                }
            }
        }
    }

    // 输出变更(相对输入的原始 start)
    cs.iter()
        .filter(|c| c.start != clips[c.idx].start)
        .map(|c| (c.idx, c.start))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sc(idx: usize, start: i64, duration: i64) -> SchedClip {
        SchedClip {
            idx,
            start,
            duration,
        }
    }

    #[test]
    fn no_overlap_untouched() {
        let cs = [sc(0, 0, 100), sc(1, 100, 100), sc(2, 250, 50)];
        assert!(resolve_overlaps(&cs, None).is_empty());
    }

    #[test]
    fn simple_push_right_on_fresh_drop() {
        // 新片段(0)落到 [0,100),原片段(1)被推向后
        let cs = [sc(0, 0, 100), sc(1, 0, 100)];
        let out = resolve_overlaps(&cs, Some(0));
        assert_eq!(out, vec![(1, 100)]);
    }

    #[test]
    fn chain_push() {
        // 中间插入,推动一串
        let cs = [
            sc(0, 0, 100),
            sc(1, 100, 100),
            sc(2, 200, 100),
            sc(3, 50, 100),
        ];
        // moved=3 落在 50:与 0(0-100) 重叠
        let mut sorted_view = cs.to_vec();
        let out = resolve_overlaps(&cs, Some(3));
        // 应用结果
        for (i, s) in &out {
            sorted_view[*i].start = *s;
        }
        // 验证无重叠且 moved 保持在 50
        let mut v: Vec<_> = sorted_view
            .iter()
            .map(|c| (c.start, c.start + c.duration, c.idx))
            .collect();
        v.sort();
        for w in v.windows(2) {
            assert!(w[0].1 <= w[1].0, "重叠: {v:?}");
        }
        assert_eq!(sorted_view[3].start, 50, "moved 保位: {v:?}");
    }

    #[test]
    fn legacy_cleanup_no_moved() {
        // 历史脏数据:c1 叠在 c0 上
        let cs = [sc(0, 0, 100), sc(1, 90, 100)];
        let out = resolve_overlaps(&cs, None);
        assert_eq!(out, vec![(1, 100)]);
    }

    #[test]
    fn push_left_when_zero_boundary() {
        // moved 落 0,原片段在 0 —— moved 保位,原片段向右让
        let cs = [sc(0, 30, 100), sc(1, 0, 100)]; // 输入顺序无关
        let out = resolve_overlaps(&cs, Some(1));
        // 排序后 1 在前(0),0 的片段(30)重叠 -> 被推到 100
        assert_eq!(out, vec![(0, 100)]);
    }

    #[test]
    fn duplicate_full_overlap_resolved() {
        // 完全重叠的两个片段(双击两次到同点):moved 保位 0,另一个被挤到 60
        let cs = [sc(0, 0, 60), sc(1, 0, 60)];
        let out = resolve_overlaps(&cs, Some(1));
        assert_eq!(out, vec![(0, 60)]);
    }
}
