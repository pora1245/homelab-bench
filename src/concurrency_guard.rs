//! A conservative live guard for an automatic concurrency change. Pilot results
//! never substitute for a comparable, measured incumbent exam segment.
use crate::types::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const WINDOW: usize = 32;
const MIN_MS: f64 = 30_000.;
#[derive(Clone)]
struct Observation {
    start: f64,
    end: f64,
    input: u64,
    output: u64,
    wall: f64,
    group: String,
}
#[derive(Clone)]
pub(crate) struct Rollback {
    pub incumbent: usize,
    pub selected: usize,
    pub since: String,
    pub evidence: Value,
}
fn timestamp(value: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|v| v.timestamp_millis() as f64)
}
fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(f64::total_cmp);
    (xs[(xs.len() - 1) / 2] + xs[xs.len() / 2]) / 2.
}
fn bucket(n: u64) -> u32 {
    n.max(1).ilog2()
}
fn distribution(rows: &[Observation]) -> BTreeMap<String, f64> {
    let mut d = BTreeMap::new();
    for r in rows {
        *d.entry(format!(
            "{}:{}:{}",
            r.group,
            bucket(r.input),
            bucket(r.output)
        ))
        .or_default() += 1. / rows.len() as f64;
    }
    d
}
fn comparable(a: &[Observation], b: &[Observation]) -> bool {
    for (x, y) in [
        (
            median(a.iter().map(|x| x.input as f64).collect()),
            median(b.iter().map(|x| x.input as f64).collect()),
        ),
        (
            median(a.iter().map(|x| x.output as f64).collect()),
            median(b.iter().map(|x| x.output as f64).collect()),
        ),
    ] {
        if !(0.8..=1.25).contains(&(y / x)) {
            return false;
        }
    }
    let da = distribution(a);
    let db = distribution(b);
    let difference: f64 = da
        .keys()
        .chain(db.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|k| (da.get(k).unwrap_or(&0.) - db.get(k).unwrap_or(&0.)).abs())
        .sum();
    difference / 2. <= 0.20
}
fn throughput(rows: &[Observation]) -> Option<f64> {
    if rows.len() < WINDOW {
        return None;
    }
    let first = rows.first()?.start;
    let last = rows.iter().map(|x| x.end).fold(first, f64::max);
    if last - first < MIN_MS {
        return None;
    }
    // A pause, restart or long idle interval is not evidence against a model.
    let max_gap = 10_000_f64.max(2. * median(rows.iter().map(|x| x.wall).collect()));
    let mut end = rows[0].end;
    for r in rows.iter().skip(1) {
        if r.start - end > max_gap {
            return None;
        }
        end = end.max(r.end);
    }
    Some(rows.iter().map(|x| x.output).sum::<u64>() as f64 * 1000. / (last - first))
}
fn window_evidence(base: &[Observation], current: &[Observation]) -> Option<Value> {
    if !comparable(base, current) {
        return None;
    }
    let before = throughput(base)?;
    let after = throughput(current)?;
    Some(
        json!({"baseline_n":base.len(),"current_n":current.len(),"baseline_tps":before,"current_tps":after,"ratio":after/before,
        "baseline_input_median":median(base.iter().map(|x|x.input as f64).collect()),"current_input_median":median(current.iter().map(|x|x.input as f64).collect()),
        "baseline_output_median":median(base.iter().map(|x|x.output as f64).collect()),"current_output_median":median(current.iter().map(|x|x.output as f64).collect()),
        "current_first_ms":current[0].start,"current_last_ms":current.iter().map(|x|x.end).fold(0.,f64::max)}),
    )
}
/// Only normal measured completions are comparable. Reject a whole window if
/// missing usage, errors or truncation would otherwise make it look faster.
fn observations(r: &Run, since: f64, until: f64, concurrency: usize) -> Vec<Option<Observation>> {
    let mut rows = Vec::new();
    for i in &r.items {
        if i.task.scorer == "experience" || !["done", "error"].contains(&i.status.as_str()) {
            continue;
        }
        let Some(a) = i.attempts.last() else {
            continue;
        };
        let Some(start) = timestamp(&a.started_at) else {
            continue;
        };
        if start < since || start >= until || r.request_concurrency(a) != concurrency {
            continue;
        }
        let observation = (|| {
            let end = timestamp(a.ended_at.as_deref()?)?;
            if end > until
                || end <= start
                || a.error.is_some()
                || !matches!(
                    a.finish_reason.as_deref(),
                    Some("stop" | "eos" | "end_turn")
                )
            {
                return None;
            }
            let input = a.metrics.input_tokens.filter(|v| *v > 0)?;
            let output = a.metrics.output_tokens.filter(|v| *v > 0)?;
            let wall = a.metrics.wall_ms;
            if !wall.is_finite() || wall <= 0. || wall > end - start + 1_000. {
                return None;
            }
            Some(Observation {
                start,
                end,
                input,
                output,
                wall,
                group: format!(
                    "{}:{}",
                    i.task.subject,
                    i.task.id.split(':').next().unwrap_or("")
                ),
            })
        })();
        rows.push((start, observation));
    }
    rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    rows.into_iter().map(|(_, v)| v).collect()
}
/// An explicit manual choice is never overridden. A new exam has no incumbent
/// workload, so it cannot roll back on a pilot-versus-main workload comparison.
pub(crate) fn evaluate(r: &Run) -> Option<Rollback> {
    if !r.config.auto_concurrency || r.status != "running" {
        return None;
    }
    let segment = r.execution_segments.last()?;
    if segment["reason"] != "auto_tuned" {
        return None;
    }
    let previous = r.execution_segments.iter().rev().nth(1)?;
    let incumbent = segment["incumbent_concurrency"]
        .as_u64()
        .or_else(|| previous["concurrency"].as_u64())? as usize;
    let selected = r.config.concurrency;
    if incumbent == selected || !(1..=8).contains(&incumbent) {
        return None;
    }
    let since = segment["started_at"].as_str()?;
    let boundary = timestamp(since)?;
    let incumbent_start = segment["incumbent_started_at"]
        .as_str()
        .or_else(|| previous["started_at"].as_str())
        .and_then(timestamp)?;
    let before = observations(r, incumbent_start, boundary, incumbent);
    let after = observations(r, boundary, f64::INFINITY, selected);
    // Two separate 32-request windows are required for a 20% decline. A 50%
    // decline is acted on after the first 32-request / 30-second window.
    if before.len() < WINDOW || after.len() < WINDOW {
        return None;
    }
    let base: Option<Vec<_>> = before.iter().rev().take(WINDOW * 2).cloned().collect();
    let mut base = base?;
    base.reverse();
    let newest: Option<Vec<_>> = after.iter().rev().take(WINDOW).cloned().collect();
    let mut newest = newest?;
    newest.reverse();
    let evidence = window_evidence(&base, &newest)?;
    let ratio = evidence["ratio"].as_f64()?;
    let (reason, prior) = if ratio <= 0.5 {
        ("throughput_halved", None)
    } else if ratio <= 0.8 && after.len() >= WINDOW * 2 {
        let earlier: Option<Vec<_>> = after
            .iter()
            .rev()
            .skip(WINDOW)
            .take(WINDOW)
            .cloned()
            .collect();
        let mut earlier = earlier?;
        earlier.reverse();
        let earlier_evidence = window_evidence(&base, &earlier)?;
        if earlier_evidence["ratio"].as_f64()? > 0.8 {
            return None;
        }
        ("two_windows_throughput_regression", Some(earlier_evidence))
    } else {
        return None;
    };
    Some(Rollback {
        incumbent,
        selected,
        since: since.into(),
        evidence: json!({"reason":reason,"method":"matched_exam_window_v1","latest":evidence,"previous":prior}),
    })
}
pub(crate) fn apply(r: &mut Run, rollback: &Rollback) -> bool {
    // Recheck after draining so a manual request or pause wins the race.
    if !r.config.auto_concurrency
        || r.config.concurrency != rollback.selected
        || r.status != "running"
        || r.execution_segments
            .last()
            .is_none_or(|s| s["reason"] != "auto_tuned" || s["started_at"] != rollback.since)
    {
        return false;
    }
    r.config.concurrency = rollback.incumbent;
    r.config.auto_concurrency = false;
    r.execution_segments.push(json!({"started_at":now(),"concurrency":rollback.incumbent,"completed_before":r.items.iter().filter(|i|["done","error"].contains(&i.status.as_str())).count(),"reason":"auto_regression_rollback","automatic_selection_locked":true,"rejected_concurrency":rollback.selected,"evidence":rollback.evidence}));
    if let Some(t) = &mut r.concurrency_tuning {
        t.selected_round_index = None;
        t.throughput_gain = None;
        t.completion_gain = None;
        t.selected_concurrency = rollback.incumbent;
        t.reason = format!(
            "본시험의 비슷한 문항 구간에서 처리량 감소가 확인돼 동시 {}개로 복구했습니다. 자동 선택은 해제됐습니다.",
            rollback.incumbent
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(n: usize, spacing: f64, input: u64, output: u64, group: &str) -> Observation {
        Observation {
            start: n as f64 * spacing,
            end: n as f64 * spacing + 1000.,
            input,
            output,
            wall: 1000.,
            group: group.into(),
        }
    }
    fn rows(spacing: f64) -> Vec<Observation> {
        (0..64)
            .map(|n| row(n, spacing, 1000, 200, "knowledge:mmlu"))
            .collect()
    }
    #[test]
    fn throughput_excludes_short_and_paused_windows() {
        assert!(throughput(&rows(100.)).is_none());
        let mut r = rows(1000.);
        r[63].start += 60_000.;
        r[63].end += 60_000.;
        assert!(throughput(&r).is_none());
    }
    #[test]
    fn workload_change_is_not_concurrency_regression() {
        let base = rows(1000.);
        let mut cur = rows(3000.);
        for x in &mut cur {
            x.output = 1200;
        }
        assert!(window_evidence(&base, &cur).is_none());
        for x in &mut cur {
            x.output = 200;
            x.group = "math:gsm".into();
        }
        assert!(window_evidence(&base, &cur).is_none());
    }
    #[test]
    fn halved_throughput_is_visible_despite_unchanged_per_request_speed() {
        let base = rows(1000.);
        let cur = rows(2100.);
        let e = window_evidence(&base, &cur).unwrap();
        assert!(e["ratio"].as_f64().unwrap() < 0.5);
    }
    fn fixture(n: usize, spacing: f64) -> Run {
        let at = |x: f64| {
            chrono::DateTime::from_timestamp_millis(x as i64)
                .unwrap()
                .to_rfc3339()
        };
        let mut items = vec![];
        for (offset, count, step, c) in [(0., 64, 1000., 8), (100_000., n, spacing, 2)] {
            for i in 0..count {
                let start = offset + i as f64 * step;
                items.push(json!({"task":{"id":format!("mmlu:{offset}:{i}"),"subject":"knowledge","prompt":"fixture","answer":"A","max_tokens":4096,"scorer":"choice","meta":{}},"status":"done","attempts":[{"started_at":at(start),"ended_at":at(start+1000.),"output":"A","reasoning":"","finish_reason":"stop","error":null,"metrics":{"request_concurrency":c,"wall_ms":1000.,"input_tokens":1000,"output_tokens":200,"ttft_ms":100.,"decode_tps":200.,"prefill_tps":null,"decode_source":"server","prefill_source":""},"score":null,"raw":[]}]}));
            }
        }
        serde_json::from_value(json!({"id":"fixture","created_at":at(0.),"config":{"name":"fixture","base_url":"http://127.0.0.1:1","model":"fixture","pack_id":"fixture","profile":"full","subjects":[],"temperature":0.,"max_tokens":4096,"concurrency":2,"auto_concurrency":true,"timeout_s":60},"status":"running","suite_hash":"fixture","protocol_version":"fixture","pack_version":"fixture","provenance":"fixture","items":items,"telemetry":[],"active_ms":0.,"error":null,"execution_segments":[{"started_at":at(0.),"concurrency":8,"reason":"initial"},{"started_at":at(100_000.),"concurrency":2,"reason":"auto_tuned","incumbent_concurrency":8,"incumbent_started_at":at(0.)}]})).unwrap()
    }
    #[test]
    fn severe_regression_rolls_back_after_one_window_and_locks_auto() {
        let mut r = fixture(32, 2100.);
        let d = evaluate(&r).unwrap();
        let old = serde_json::to_value(&r.items).unwrap();
        assert!(apply(&mut r, &d));
        assert_eq!(r.config.concurrency, 8);
        assert!(!r.config.auto_concurrency);
        assert_eq!(old, serde_json::to_value(&r.items).unwrap());
        assert!(evaluate(&r).is_none());
    }
    #[test]
    fn moderate_regression_needs_two_independent_windows() {
        assert!(evaluate(&fixture(32, 1400.)).is_none());
        assert!(evaluate(&fixture(64, 1400.)).is_some());
    }
    #[test]
    fn manual_choices_errors_and_missing_usage_do_not_trigger_speed_comparison() {
        let mut r = fixture(64, 3000.);
        r.config.auto_concurrency = false;
        assert!(evaluate(&r).is_none());
        r.config.auto_concurrency = true;
        r.items.last_mut().unwrap().attempts[0]
            .metrics
            .output_tokens = None;
        assert!(evaluate(&r).is_none());
        r.items.last_mut().unwrap().attempts[0]
            .metrics
            .output_tokens = Some(200);
        r.items.last_mut().unwrap().attempts[0].finish_reason = Some("length".into());
        assert!(evaluate(&r).is_none());
    }
    #[test]
    fn fresh_exam_does_not_use_pilot_as_workload_baseline() {
        let mut r = fixture(64, 3000.);
        r.execution_segments.remove(0);
        assert!(evaluate(&r).is_none());
    }
    #[test]
    fn exact_half_decline_rolls_back_without_waiting_for_second_window() {
        let r = fixture(32, 63_000. / 31.);
        let decision = evaluate(&r).unwrap();
        assert!((decision.evidence["latest"]["ratio"].as_f64().unwrap() - 0.5).abs() < 0.0001);
    }
    #[test]
    fn changed_manual_choice_wins_after_drain_and_bonus_is_invalidated_on_rollback() {
        let mut r = fixture(64, 3000.);
        let decision = evaluate(&r).unwrap();
        r.config.auto_concurrency = false;
        assert!(!apply(&mut r, &decision));
        assert_eq!(r.config.concurrency, 2);
        r.config.auto_concurrency = true;
        let mut tuning = crate::auto_concurrency::Tuning::new(&r.config, &[]);
        tuning.selected_round_index = Some(1);
        tuning.throughput_gain = Some(2.);
        tuning.completion_gain = Some(2.);
        r.concurrency_tuning = Some(tuning);
        assert!(apply(&mut r, &decision));
        let tuning = r.concurrency_tuning.unwrap();
        assert!(tuning.selected_round_index.is_none());
        assert!(tuning.throughput_gain.is_none());
        assert!(tuning.completion_gain.is_none());
    }
}
