//! Deterministic integrity checks. Raw measurements are never changed; neither
//! slow real responses nor statistically unusual but valid results are discarded.
use crate::types::Metrics;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const VERSION: &str = "metric-integrity-v1";
pub const KEYS: [&str; 5] = [
    "ttft_ms",
    "decode_tps",
    "client_visible_decode_tps",
    "prefill_tps",
    "throughput",
];
// Sub-100 ms client windows cannot distinguish GPU generation from buffered
// transport delivery. This is a measurement-resolution rule, not a tok/s cap.
pub const MIN_VISIBLE_INTERVAL_MS: f64 = 100.0;

fn token_mismatch(m: &Metrics) -> bool {
    m.reasoning_tokens
        .zip(m.output_tokens)
        .is_some_and(|(r, n)| r > n)
        || m.visible_output_tokens
            .zip(m.output_tokens)
            .is_some_and(|(v, n)| v > n)
        || m.visible_output_tokens
            .zip(m.reasoning_tokens)
            .zip(m.output_tokens)
            .is_some_and(|((v, r), n)| v.checked_add(r) != Some(n))
}
fn visible_reason(m: &Metrics, speed: f64) -> Option<&'static str> {
    if token_mismatch(m) {
        return Some("inconsistent_token_counts");
    }
    if m.visible_output_tokens.is_none() {
        return Some("visible_token_count_unavailable");
    }
    if m.visible_output_tokens.unwrap_or(0) < 2 {
        return Some("insufficient_visible_tokens");
    }
    if m.visible_stream_chunks.is_some_and(|n| n < 2) {
        return Some("insufficient_stream_chunks");
    }
    let span = m
        .visible_decode_span_ms
        .or_else(|| m.visible_output_tokens.map(|n| n as f64 * 1000.0 / speed));
    if span.is_none_or(|v| !v.is_finite() || v < MIN_VISIBLE_INTERVAL_MS) {
        return Some("short_visible_interval");
    }
    if span.is_some_and(|v| v > m.wall_ms + 10.0) {
        return Some("interval_exceeds_request");
    }
    None
}
fn native_reason(
    speed: f64,
    ms: Option<f64>,
    tokens: Option<u64>,
    wall_ms: f64,
) -> Option<&'static str> {
    if ms.is_some_and(|v| !v.is_finite() || v <= 0.0) {
        return Some("invalid_server_interval");
    }
    if ms.is_some_and(|v| v > wall_ms + 10.0) {
        return Some("interval_exceeds_request");
    }
    if let (Some(ms), Some(n)) = (ms, tokens) {
        // Rounding tolerance for engines reporting duration to low precision.
        let expected = n as f64 * 1000.0 / ms;
        if n == 0 || (expected - speed).abs() > (expected.abs() * 0.05).max(1.0) {
            return Some("inconsistent_server_timing");
        }
    }
    None
}
pub fn evaluate(m: &Metrics) -> Value {
    let mut valid = BTreeMap::new();
    let mut excluded = BTreeMap::new();
    let mut missing = Vec::new();
    let wall_bad = !m.wall_ms.is_finite() || m.wall_ms <= 0.0;
    for (key, value) in [
        ("ttft_ms", m.ttft_ms),
        ("decode_tps", m.decode_tps),
        ("client_visible_decode_tps", m.client_visible_decode_tps),
        ("prefill_tps", m.prefill_tps),
    ] {
        let reason = value.and_then(|v| {
            if wall_bad {
                return Some("invalid_request_duration");
            }
            if !v.is_finite() || v < 0.0 || (key != "ttft_ms" && v == 0.0) {
                return Some("invalid_value");
            }
            match key {
                "ttft_ms" if v > m.wall_ms + 10.0 => Some("ttft_exceeds_request"),
                "decode_tps" if m.decode_source == "server" => {
                    native_reason(v, m.server_decode_ms, m.server_decode_tokens, m.wall_ms)
                }
                "decode_tps"
                    if ["client_estimate", "client_visible_estimate"]
                        .contains(&m.decode_source.as_str()) =>
                {
                    visible_reason(m, v)
                }
                "decode_tps" => Some("source_unavailable"),
                "client_visible_decode_tps" => visible_reason(m, v),
                "prefill_tps" if m.prefill_source == "server" => {
                    native_reason(v, m.server_prefill_ms, m.server_prefill_tokens, m.wall_ms)
                }
                "prefill_tps" => Some("prefill_not_server_measured"),
                _ => None,
            }
        });
        valid.insert(key, value.is_some() && reason.is_none());
        if value.is_none() {
            missing.push(key);
        }
        if let Some(reason) = reason {
            excluded.insert(key, reason);
        }
    }
    let tokens = if m.measurement_version.is_empty() {
        m.output_tokens
    } else {
        m.visible_output_tokens
    };
    let throughput_reason = if wall_bad {
        Some("invalid_request_duration")
    } else if token_mismatch(m) {
        Some("inconsistent_token_counts")
    } else {
        None
    };
    valid.insert(
        "throughput",
        tokens.is_some() && throughput_reason.is_none(),
    );
    if tokens.is_none() {
        missing.push("throughput");
    }
    if tokens.is_some() {
        if let Some(reason) = throughput_reason {
            excluded.insert("throughput", reason);
        }
    }
    json!({"version":VERSION,"valid":valid,"excluded":excluded,"missing":missing})
}

#[derive(Default)]
pub struct Coverage {
    eligible: usize,
    rows: BTreeMap<String, Value>,
    recent: Vec<Value>,
}
impl Coverage {
    pub fn observe(&mut self, m: &Metrics) -> Value {
        self.eligible += 1;
        let q = evaluate(m);
        for key in KEYS {
            let row = self
                .rows
                .entry(key.into())
                .or_insert_with(|| json!({"valid":0,"excluded":0,"missing":0,"reasons":{}}));
            let category = if q["valid"][key] == true {
                "valid"
            } else if q["excluded"][key].is_string() {
                "excluded"
            } else {
                "missing"
            };
            row[category] = (row[category].as_u64().unwrap_or(0) + 1).into();
            if let Some(reason) = q["excluded"][key].as_str() {
                row["reasons"][reason] = (row["reasons"][reason].as_u64().unwrap_or(0) + 1).into();
            }
        }
        self.recent.push(q.clone());
        if self.recent.len() > 20 {
            self.recent.remove(0);
        }
        q
    }
    pub fn finish(self) -> Value {
        let mut recent_missing = BTreeMap::new();
        for key in KEYS {
            recent_missing.insert(
                key,
                self.recent
                    .iter()
                    .filter(|q| q["valid"][key] != true)
                    .count(),
            );
        }
        json!({"version":VERSION,"eligible":self.eligible,"metrics":self.rows,
            "recent_sample_count":self.recent.len(),"recent_missing":recent_missing})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> Metrics {
        Metrics {
            wall_ms: 2000.,
            ttft_ms: Some(1000.),
            visible_output_tokens: Some(100),
            output_tokens: Some(100),
            reasoning_tokens: Some(0),
            measurement_version: "client-visible-v1".into(),
            decode_tps: Some(100.),
            decode_source: "client_estimate".into(),
            client_visible_decode_tps: Some(100.),
            ..Metrics::default()
        }
    }
    #[test]
    fn buffered_spike_is_rejected_without_mutating_raw() {
        let mut m = base();
        m.decode_tps = Some(84706.96);
        m.client_visible_decode_tps = m.decode_tps;
        let q = evaluate(&m);
        assert_eq!(q["excluded"]["decode_tps"], "short_visible_interval");
        assert_eq!(q["valid"]["throughput"], true);
        assert_eq!(m.decode_tps, Some(84706.96));
    }
    #[test]
    fn genuinely_slow_or_fast_server_measurement_is_kept() {
        let mut m = base();
        m.wall_ms = 120000.;
        m.ttft_ms = Some(110000.);
        m.decode_tps = Some(0.1);
        m.decode_source = "server".into();
        assert_eq!(evaluate(&m)["valid"]["decode_tps"], true);
        assert_eq!(evaluate(&m)["valid"]["ttft_ms"], true);
        m.decode_tps = Some(90000.);
        assert_eq!(evaluate(&m)["valid"]["decode_tps"], true);
    }
    #[test]
    fn counters_and_clock_failures_are_separate_from_missing_values() {
        let mut m = base();
        m.reasoning_tokens = Some(110);
        m.ttft_ms = Some(3000.);
        let q = evaluate(&m);
        assert_eq!(q["excluded"]["ttft_ms"], "ttft_exceeds_request");
        assert_eq!(q["excluded"]["throughput"], "inconsistent_token_counts");
        assert!(
            q["missing"]
                .as_array()
                .unwrap()
                .contains(&json!("prefill_tps"))
        );
        m.prefill_tps = Some(100.);
        m.prefill_source = "estimated_from_ttft".into();
        assert_eq!(evaluate(&m)["valid"]["prefill_tps"], false);
    }
    #[test]
    fn server_timing_consistency_and_coverage() {
        let mut m = base();
        m.decode_source = "server".into();
        m.server_decode_ms = Some(1000.);
        m.server_decode_tokens = Some(100);
        assert_eq!(evaluate(&m)["valid"]["decode_tps"], true);
        m.server_decode_tokens = Some(1000);
        assert_eq!(
            evaluate(&m)["excluded"]["decode_tps"],
            "inconsistent_server_timing"
        );
        let mut c = Coverage::default();
        c.observe(&m);
        let v = c.finish();
        assert_eq!(v["metrics"]["decode_tps"]["excluded"], 1);
    }
    #[test]
    fn unknown_sources_and_server_intervals_beyond_request_are_excluded() {
        let mut m = base();
        m.decode_source = "arbitrary-unknown-source".into();
        assert_eq!(evaluate(&m)["excluded"]["decode_tps"], "source_unavailable");
        m.wall_ms = 1000.;
        m.decode_source = "server".into();
        m.decode_tps = Some(10.);
        m.server_decode_ms = Some(10000.);
        m.server_decode_tokens = Some(100);
        assert_eq!(
            evaluate(&m)["excluded"]["decode_tps"],
            "interval_exceeds_request"
        );
        m.prefill_source = "server".into();
        m.prefill_tps = Some(10.);
        m.server_prefill_ms = Some(10000.);
        m.server_prefill_tokens = Some(100);
        assert_eq!(
            evaluate(&m)["excluded"]["prefill_tps"],
            "interval_exceeds_request"
        );
        // Allow the documented 10 ms duration-rounding tolerance.
        m.server_decode_ms = Some(1005.);
        m.decode_tps = Some(100000. / 1005.);
        assert_eq!(evaluate(&m)["valid"]["decode_tps"], true);
    }
}
