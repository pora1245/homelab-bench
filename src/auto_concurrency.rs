//! Bounded, restartable same-question concurrency calibration. Probe answers are
//! evidence, never extra scored items in the exam's intelligence denominator.
use crate::{App, provider, runtime, scoring, types::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};
use tokio::{sync::mpsc, task::JoinSet};

const BUDGET_MS: f64 = 600_000.0;
const MIN_GAIN: f64 = 1.10;
const REPEATS: usize = 3;
fn single() -> usize {
    1
}
/// Preserve subject coverage while spanning each subject's workload lengths.
/// Midpoint quantiles avoid selecting only the fastest questions or extreme tails.
fn stratified_ids(mut groups: BTreeMap<String, Vec<(String, f64)>>) -> Vec<String> {
    for rows in groups.values_mut() {
        rows.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
    }
    let mut quotas: BTreeMap<String, usize> = groups.keys().map(|s| (s.clone(), 0)).collect();
    for _ in 0..8 {
        for (subject, rows) in &groups {
            if quotas.values().sum::<usize>() == 8 {
                break;
            }
            if quotas[subject] < rows.len() {
                *quotas.get_mut(subject).unwrap() += 1;
            }
        }
    }
    let mut ids = vec![];
    for offset in 0..8 {
        for (subject, rows) in &groups {
            let quota = quotas[subject];
            if offset < quota {
                let index = ((2 * offset + 1) * rows.len() / (2 * quota)).min(rows.len() - 1);
                ids.push(rows[index].0.clone());
            }
        }
    }
    ids
}
/// Time with at least one model request in flight. Local-only grading/storage
/// gaps are reported separately and can never manufacture a model speedup.
fn inference_window(r: &Round) -> Option<f64> {
    let mut intervals = r
        .samples
        .iter()
        .map(|s| {
            let a = &s.attempt;
            let start = chrono::DateTime::parse_from_rfc3339(&a.started_at)
                .ok()?
                .timestamp_micros();
            let end = chrono::DateTime::parse_from_rfc3339(a.ended_at.as_deref()?)
                .ok()?
                .timestamp_micros();
            (end > start).then_some((start, end))
        })
        .collect::<Option<Vec<_>>>()?;
    // Timestamps must describe a physically possible overlap at this setting.
    let mut events = intervals
        .iter()
        .flat_map(|&(a, b)| [(a, 1_i32), (b, -1)])
        .collect::<Vec<_>>();
    events.sort_unstable();
    let mut active = 0;
    for (_, delta) in events {
        active += delta;
        if active < 0 || active > r.concurrency as i32 {
            return None;
        }
    }
    intervals.sort_unstable();
    let &(mut start, mut end) = intervals.first()?;
    let mut total = 0_i64;
    for &(a, b) in intervals.iter().skip(1) {
        if a > end {
            total += end - start;
            start = a;
            end = b;
        } else {
            end = end.max(b);
        }
    }
    total += end - start;
    (total > 0).then_some(total as f64 / 1000.0)
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Sample {
    pub task_id: String,
    pub prompt_sha256: String,
    pub attempt: Attempt,
    pub cached_input_tokens: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Round {
    pub concurrency: usize,
    pub role: String,
    pub status: String,
    pub settings_fingerprint: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub elapsed_ms: f64,
    #[serde(default)]
    pub inference_ms: Option<f64>,
    #[serde(default)]
    pub overhead_ms: Option<f64>,
    pub samples: Vec<Sample>,
    pub throughput_tps: Option<f64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Tuning {
    pub version: String,
    pub status: String,
    pub max_concurrency: usize,
    pub selected_concurrency: usize,
    #[serde(default = "single")]
    pub incumbent_concurrency: usize,
    pub sample_ids: Vec<String>,
    #[serde(default)]
    pub selection_reason: String,
    pub settings_snapshot: Value,
    pub settings_fingerprint: String,
    pub elapsed_ms: f64,
    pub budget_ms: f64,
    pub rounds: Vec<Round>,
    pub baseline_round_index: Option<usize>,
    pub selected_round_index: Option<usize>,
    pub throughput_gain: Option<f64>,
    pub completion_gain: Option<f64>,
    pub reason: String,
    pub cache_control: String,
    pub cache_comparison: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous_measurements: Vec<Tuning>,
}
fn snapshot(c: &Config) -> Value {
    json!({"base_url":c.base_url,"model":c.model,"api_format":c.api_format,
        "temperature":c.temperature,"max_tokens":c.max_tokens,"reasoning_effort":c.reasoning_effort,
        "reasoning_parameters":c.reasoning_parameters,"execution_info":c.execution_info})
}
fn prompt_hash(prompt: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(prompt.as_bytes()))
}
impl Tuning {
    pub fn new(c: &Config, tasks: &[Task]) -> Self {
        let mut groups: BTreeMap<String, Vec<(String, f64)>> = BTreeMap::new();
        for t in tasks.iter().filter(|t| t.scorer != "experience") {
            groups
                .entry(t.subject.clone())
                .or_default()
                .push((t.id.clone(), t.prompt.chars().count() as f64));
        }
        let ids = stratified_ids(groups);
        let settings = snapshot(c);
        Self {
            version: "auto-concurrency-v2".into(),
            status: "baseline".into(),
            max_concurrency: c.concurrency.clamp(1, 8).min(ids.len().max(1)),
            selected_concurrency: 1,
            incumbent_concurrency: 1,
            sample_ids: ids,
            selection_reason: "선택 과목별 입력 길이 분위수를 고르게 포함하는 표본".into(),
            settings_fingerprint: digest(&settings),
            settings_snapshot: settings,
            elapsed_ms: 0.0,
            budget_ms: BUDGET_MS,
            rounds: vec![],
            baseline_round_index: None,
            selected_round_index: None,
            throughput_gain: None,
            completion_gain: None,
            reason: String::new(),
            cache_control: "provider_default_uncontrolled".into(),
            cache_comparison: "unknown".into(),
            previous_measurements: vec![],
        }
    }
    pub fn retain_incumbent(&mut self, concurrency: usize) {
        self.incumbent_concurrency = concurrency.clamp(1, 8);
        self.selected_concurrency = self.incumbent_concurrency;
    }
    pub fn for_existing(c: &Config, items: &[Item]) -> Self {
        let tasks = items.iter().map(|i| i.task.clone()).collect::<Vec<_>>();
        let mut tuning = Self::new(c, &tasks);
        let mut groups: BTreeMap<String, Vec<(String, f64)>> = BTreeMap::new();
        for item in items.iter().filter(|i| i.task.scorer != "experience") {
            if let Some(a) = item.attempts.last().filter(|a| {
                a.error.is_none()
                    && a.ended_at.is_some()
                    && matches!(
                        a.finish_reason.as_deref(),
                        Some("stop" | "eos" | "end_turn")
                    )
                    && a.metrics.output_tokens.is_some_and(|n| n > 0)
            }) {
                // Request wall time depends on concurrency and queueing. Token
                // workload is the stable axis; correctness is never a selector.
                let work = a.metrics.output_tokens.unwrap() as f64
                    + a.metrics.input_tokens.unwrap_or(0) as f64;
                groups
                    .entry(item.task.subject.clone())
                    .or_default()
                    .push((item.task.id.clone(), work));
            }
        }
        if groups.is_empty() {
            return tuning;
        }
        let mut ids = stratified_ids(groups);
        let measured_count = ids.len();
        if measured_count < 8 {
            let mut pending: BTreeMap<String, Vec<(String, f64)>> = BTreeMap::new();
            for task in tasks
                .iter()
                .filter(|t| t.scorer != "experience" && !ids.contains(&t.id))
            {
                pending
                    .entry(task.subject.clone())
                    .or_default()
                    .push((task.id.clone(), task.prompt.chars().count() as f64));
            }
            ids.extend(stratified_ids(pending).into_iter().take(8 - measured_count));
        }
        tuning.sample_ids = ids;
        tuning.max_concurrency = c
            .concurrency
            .clamp(1, 8)
            .min(tuning.sample_ids.len().max(1));
        tuning.selection_reason = format!(
            "기존 정상 종료 표본 {measured_count}건을 과목·입출력 토큰 길이 분위수로 선택했습니다. 부족한 {}건은 입력 길이 분위수로 보충하며 정답 여부는 선택에 사용하지 않습니다.",
            tuning.sample_ids.len() - measured_count
        );
        tuning
    }
    pub fn finished(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "unavailable")
    }
    pub fn public(&self, raw: bool, compact: bool) -> Value {
        let mut v = serde_json::to_value(self).unwrap();
        fn redact(v: &mut Value, raw: bool, compact: bool) {
            if let Some(rounds) = v["rounds"].as_array_mut() {
                for r in rounds {
                    if let Some(samples) = r["samples"].as_array_mut() {
                        for s in samples {
                            if !raw {
                                s["attempt"]["raw"] = Value::Null;
                            }
                            if compact {
                                s["attempt"]["output"] = "".into();
                                s["attempt"]["reasoning"] = "".into();
                            }
                        }
                    }
                }
            }
            if let Some(history) = v
                .get_mut("previous_measurements")
                .and_then(Value::as_array_mut)
            {
                for t in history {
                    redact(t, raw, compact);
                }
            }
        }
        redact(&mut v, raw, compact);
        v
    }
    fn add_round(&mut self, c: usize, role: &str) {
        self.status = if c == 1 { "baseline" } else { "testing" }.into();
        self.rounds.push(Round {
            concurrency: c,
            role: role.into(),
            status: "running".into(),
            settings_fingerprint: self.settings_fingerprint.clone(),
            started_at: now(),
            ended_at: None,
            elapsed_ms: 0.0,
            inference_ms: None,
            overhead_ms: None,
            samples: vec![],
            throughput_tps: None,
        });
    }
    fn usable(&self, index: usize) -> bool {
        let r = &self.rounds[index];
        r.status == "completed"
            && r.role != "warmup"
            && inference_window(r)
                .zip(r.inference_ms)
                .is_some_and(|(actual, recorded)| {
                    actual.is_finite()
                        && recorded.is_finite()
                        && (actual - recorded).abs() <= 1.0
                        && actual <= r.elapsed_ms + 100.0
                })
            && r.elapsed_ms.is_finite()
            && r.elapsed_ms > 0.0
            && r.samples.len() == self.sample_ids.len()
            && r.samples
                .iter()
                .map(|s| &s.task_id)
                .collect::<BTreeSet<_>>()
                == self.sample_ids.iter().collect()
            && r.settings_fingerprint == self.settings_fingerprint
            && r.samples
                .iter()
                .map(|s| s.attempt.metrics.wall_ms)
                .sum::<f64>()
                / r.concurrency.max(1) as f64
                <= r.elapsed_ms + 100.0
            && r.samples.iter().all(|s| {
                let a = &s.attempt;
                let m = &a.metrics;
                let dated_ms = chrono::DateTime::parse_from_rfc3339(&a.started_at)
                    .ok()
                    .zip(
                        a.ended_at
                            .as_deref()
                            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok()),
                    )
                    .map(|(start, end)| {
                        (end - start).num_microseconds().unwrap_or(-1) as f64 / 1000.0
                    });
                let token_parts_match = m.visible_output_tokens.zip(m.reasoning_tokens).is_none_or(
                    |(visible, reasoning)| visible.checked_add(reasoning) == m.output_tokens,
                );
                a.error.is_none()
                    && a.ended_at.is_some()
                    && matches!(
                        a.finish_reason.as_deref(),
                        Some("stop" | "eos" | "end_turn")
                    )
                    && m.output_tokens
                        .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
                    && m.reasoning_tokens
                        .is_none_or(|n| m.output_tokens.is_some_and(|total| n <= total))
                    && m.visible_output_tokens
                        .is_none_or(|n| m.output_tokens.is_some_and(|total| n <= total))
                    && token_parts_match
                    && m.wall_ms.is_finite()
                    && m.wall_ms > 0.0
                    && m.wall_ms <= r.elapsed_ms + 100.0
                    && dated_ms.is_some_and(|ms| {
                        ms >= 0.0 && (ms - m.wall_ms).abs() <= 100.0_f64.max(m.wall_ms * 0.01)
                    })
                    && a.metrics.request_concurrency == Some(r.concurrency)
                    && a.score.as_ref().and_then(Score::valid_value).is_some()
            })
    }
    fn throughput(&self, i: usize) -> f64 {
        let r = &self.rounds[i];
        r.samples
            .iter()
            .filter_map(|s| s.attempt.metrics.output_tokens)
            .sum::<u64>() as f64
            * 1000.0
            / r.inference_ms.unwrap_or(f64::NAN)
    }
    fn gains(&self, base: usize, candidate: usize) -> (f64, f64) {
        (
            self.throughput(candidate) / self.throughput(base),
            self.rounds[base].inference_ms.unwrap_or(f64::NAN)
                / self.rounds[candidate].inference_ms.unwrap_or(f64::NAN),
        )
    }
    fn better(&self, base: usize, candidate: usize) -> bool {
        if !self.usable(base) || !self.usable(candidate) {
            return false;
        }
        let (throughput, completion) = self.gains(base, candidate);
        let score_sum = |i: usize| {
            self.rounds[i]
                .samples
                .iter()
                .filter_map(|s| s.attempt.score.as_ref().and_then(Score::valid_value))
                .sum::<f64>()
        };
        // A faster round that loses a previously correct answer is not adopted.
        let no_regression = self.rounds[base].samples.iter().all(|a| {
            let before = a
                .attempt
                .score
                .as_ref()
                .and_then(Score::valid_value)
                .unwrap_or(0.0);
            self.rounds[candidate]
                .samples
                .iter()
                .find(|b| b.task_id == a.task_id)
                .and_then(|b| b.attempt.score.as_ref())
                .and_then(Score::valid_value)
                .is_some_and(|after| after >= before)
        });
        throughput >= MIN_GAIN
            && completion >= MIN_GAIN
            // Local execution cannot get materially worse even if inference is faster.
            && self.rounds[candidate].elapsed_ms <= self.rounds[base].elapsed_ms * 1.05
            && self.rounds[candidate].samples.iter().all(|b| self.rounds[base].samples.iter()
                .find(|a| a.task_id == b.task_id).is_some_and(|a| a.prompt_sha256 == b.prompt_sha256))
            && no_regression
            && score_sum(candidate) >= score_sum(base)
    }
    fn finish(&mut self, reason: &str, unavailable: bool) {
        self.status = if unavailable {
            "unavailable"
        } else {
            "completed"
        }
        .into();
        self.reason = reason.into();
        if unavailable {
            self.selected_concurrency = self.incumbent_concurrency;
            self.selected_round_index = None;
            self.throughput_gain = None;
            self.completion_gain = None;
        } else if let (Some(b), Some(s)) = (self.baseline_round_index, self.selected_round_index) {
            let (t, c) = self.gains(b, s);
            self.throughput_gain = Some(t);
            self.completion_gain = Some(c);
        }
        self.cache_comparison = if self
            .rounds
            .iter()
            .flat_map(|r| &r.samples)
            .all(|s| s.cached_input_tokens.is_some())
            && !self.rounds.is_empty()
        {
            "reported_uncontrolled"
        } else {
            "unknown"
        }
        .into();
    }
    fn options(&self) -> Vec<usize> {
        let mut options = vec![1];
        if self.incumbent_concurrency > 1 {
            options.push(self.incumbent_concurrency);
        }
        for c in [2, 4, 8, self.max_concurrency] {
            if c <= self.max_concurrency && !options.contains(&c) {
                options.push(c);
            }
        }
        options
    }
    fn measured(&self, concurrency: usize) -> Vec<usize> {
        self.rounds
            .iter()
            .enumerate()
            .filter(|(i, r)| r.concurrency == concurrency && self.usable(*i))
            .map(|(i, _)| i)
            .collect()
    }
    fn representative(&self, concurrency: usize) -> Option<usize> {
        let mut ids = self.measured(concurrency);
        if ids.len() < REPEATS {
            return None;
        }
        ids.sort_by(|a, b| {
            self.rounds[*a]
                .inference_ms
                .unwrap()
                .total_cmp(&self.rounds[*b].inference_ms.unwrap())
        });
        Some(ids[ids.len() / 2])
    }
    fn confirmed_better(&self, base: usize, candidate: usize) -> bool {
        let Some(b) = self.representative(base) else {
            return false;
        };
        let Some(c) = self.representative(candidate) else {
            return false;
        };
        // A median win cannot hide one repeat losing half its throughput.
        let fastest_base = self
            .measured(base)
            .into_iter()
            .map(|i| self.throughput(i))
            .fold(0.0, f64::max);
        self.better(b, c)
            && self.measured(candidate).into_iter().all(|i| {
                self.throughput(i) >= fastest_base * 0.95
                    && self.measured(base).iter().all(|&j| {
                        self.rounds[j].samples.iter().all(|before| {
                            let score = before
                                .attempt
                                .score
                                .as_ref()
                                .and_then(Score::valid_value)
                                .unwrap_or(0.0);
                            self.rounds[i]
                                .samples
                                .iter()
                                .find(|after| after.task_id == before.task_id)
                                .is_some_and(|after| {
                                    after.prompt_sha256 == before.prompt_sha256
                                        && after
                                            .attempt
                                            .score
                                            .as_ref()
                                            .and_then(Score::valid_value)
                                            .is_some_and(|v| v >= score)
                                })
                        })
                    })
            })
    }
    /// Full bounded sweep, three completed repeats per setting. Insufficient
    /// evidence preserves the incumbent, never silently substitutes c1.
    fn advance(&mut self) {
        if self.sample_ids.len() < 2 || self.max_concurrency < 2 {
            self.finish(
                "동시 비교 표본 또는 상한이 부족해 기존 동시 설정을 유지합니다.",
                true,
            );
            return;
        }
        if self.rounds.is_empty() {
            self.add_round(1, "warmup");
            return;
        }
        if self.rounds.iter().any(|r| r.status == "running") {
            return;
        }
        let options = self.options();
        for repeat in 0..REPEATS {
            // Reverse alternating passes so one setting does not always get
            // the coldest cache or the same place in the sweep.
            let order = if repeat % 2 == 0 {
                options.clone()
            } else {
                options.iter().copied().rev().collect()
            };
            for c in order {
                if self
                    .rounds
                    .iter()
                    .filter(|r| r.concurrency == c && r.role != "warmup")
                    .count()
                    <= repeat
                {
                    self.add_round(c, if c == 1 { "baseline" } else { "candidate" });
                    return;
                }
            }
        }
        let Some(incumbent) = self.representative(self.incumbent_concurrency) else {
            self.finish(
                "기존 동시 설정의 반복 비교 근거가 부족해 설정을 유지합니다.",
                true,
            );
            return;
        };
        let Some(baseline) = self.representative(1) else {
            self.finish(
                "단일 요청 반복 비교 근거가 부족해 기존 동시 설정을 유지합니다.",
                true,
            );
            return;
        };
        // Any tested option with missing usable repetitions makes the sweep
        // inconclusive: no quality failure is interpreted as speed evidence.
        if options.iter().any(|c| self.representative(*c).is_none()) {
            self.finish(
                "일부 설정의 응답·사용량·채점 반복 검증이 미완료여서 기존 동시 설정을 유지합니다.",
                true,
            );
            return;
        }
        let mut best = self.incumbent_concurrency;
        for candidate in options {
            if candidate != best && self.confirmed_better(best, candidate) {
                best = candidate;
            }
        }
        self.baseline_round_index = Some(baseline);
        self.selected_round_index = Some(if best == self.incumbent_concurrency {
            incumbent
        } else {
            self.representative(best).unwrap()
        });
        self.selected_concurrency = best;
        self.finish(if best==self.incumbent_concurrency {"반복 비교에서 기존 동시 설정보다 확실한 개선이 없어 유지합니다."} else {"기존 설정과 모든 후보를 3회 비교해 처리량·완료시간 개선 및 본시험 복구 감시 조건으로 선택했습니다."},false);
    }
}
fn cached_tokens(raw: &[Value]) -> Option<u64> {
    fn find(v: &Value) -> Option<u64> {
        if let Some(o) = v.as_object() {
            for k in ["cached_tokens", "cache_read_input_tokens"] {
                if let Some(n) = o.get(k).and_then(Value::as_u64) {
                    return Some(n);
                }
            }
            o.values().filter_map(find).max()
        } else {
            v.as_array().and_then(|a| a.iter().filter_map(find).max())
        }
    }
    raw.iter().filter_map(find).max()
}
async fn probe(s: App, id: String, config: Config, task: Task, remaining_ms: f64) -> Sample {
    let started = Instant::now();
    let deadline =
        tokio::time::Instant::now() + Duration::from_secs_f64((remaining_ms / 1000.0).max(0.001));
    let key = s.keys.lock().await.get(&id).cloned().unwrap_or_default();
    let (tx, mut rx) = mpsc::channel(4);
    let future = provider::generate(&config, &task, &key, tx);
    tokio::pin!(future);
    let mut partial = Attempt {
        started_at: now(),
        ended_at: None,
        output: String::new(),
        reasoning: String::new(),
        finish_reason: None,
        error: None,
        metrics: Metrics::default(),
        score: None,
        raw: vec![],
    };
    let mut attempt = loop {
        tokio::select! {
            a=&mut future=>break a,
            Some(p)=rx.recv()=>{partial.output=p.output;partial.reasoning=p.reasoning;partial.metrics=p.metrics;},
            _=tokio::time::sleep_until(deadline)=>{
                partial.ended_at=Some(now());partial.error=Some("동시 요청 측정 10분 예산 도달".into());partial.metrics.wall_ms=started.elapsed().as_secs_f64()*1000.0;break partial;
            }
        }
    };
    attempt.metrics.request_concurrency = Some(config.concurrency);
    Sample {
        task_id: task.id.clone(),
        prompt_sha256: prompt_hash(&task.prompt),
        cached_input_tokens: cached_tokens(&attempt.raw),
        attempt,
    }
}
async fn persist(s: &App, id: &str, t: &Tuning, active_ms: f64) -> anyhow::Result<()> {
    s.checkpoint(id, |r| {
        r.concurrency_tuning = Some(t.clone());
        r.active_ms = active_ms;
    })
    .await?;
    let _ = s.events.send(id.into());
    Ok(())
}
async fn telemetry(s: App, config: Config) -> Value {
    if let Some(d) = config.device {
        let v = crate::settings::sample(&s, &d).await;
        return json!({"received_at":now(),"data":v["data"],"status":v["status"],"error":v["error"],"device_id":d.id,"device_name":d.name,"phase":"concurrency_tuning"});
    }
    let result = async {
        let c = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()?;
        c.get(&config.telemetry_url)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await
    }
    .await;
    match result {
        Ok(v) => json!({"received_at":now(),"data":v,"phase":"concurrency_tuning"}),
        Err(_) => {
            json!({"received_at":now(),"error":"장비 수집기 연결 실패","phase":"concurrency_tuning"})
        }
    }
}
pub async fn drive(s: &App, id: &str) -> anyhow::Result<bool> {
    let (config, mut tuning, tasks, original_ms) = {
        let runs = s.runs.lock().await;
        let r = &runs[id];
        if !r.config.auto_concurrency || r.concurrency_tuning.as_ref().is_none_or(Tuning::finished)
        {
            return Ok(true);
        }
        (
            r.config.clone(),
            r.concurrency_tuning.clone().unwrap(),
            r.items
                .iter()
                .map(|i| (i.task.id.clone(), i.task.clone()))
                .collect::<BTreeMap<_, _>>(),
            r.active_ms,
        )
    };
    if tuning.version != "auto-concurrency-v2" {
        tuning.retain_incumbent(config.concurrency);
        tuning.finish("이전 자동 비교 기록은 새 검증 방식과 달라 기존 동시 설정을 유지합니다. 재측정 시 새 방식이 적용됩니다.",true);
    }
    let clock = Instant::now();
    let old_elapsed = tuning.elapsed_ms;
    let mut sensor_jobs = JoinSet::new();
    let mut sensor_clock = Instant::now();
    if tuning.settings_fingerprint != digest(&snapshot(&config))
        || tuning.sample_ids.iter().any(|id| !tasks.contains_key(id))
    {
        tuning.finish(
            "표본 또는 실행 설정이 변경되어 기존 동시 설정을 유지합니다.",
            true,
        );
    }
    while !tuning.finished() {
        tuning.elapsed_ms = old_elapsed + clock.elapsed().as_secs_f64() * 1000.0;
        if tuning.elapsed_ms >= tuning.budget_ms {
            tuning.finish(
                "동시 요청 측정 10분 예산이 끝나 기존 동시 설정을 유지합니다.",
                true,
            );
            break;
        }
        tuning.advance();
        if tuning.finished() {
            break;
        }
        let round_index = tuning.rounds.len() - 1;
        let concurrency = tuning.rounds[round_index].concurrency;
        let round_base = tuning.rounds[round_index].elapsed_ms;
        persist(
            s,
            id,
            &tuning,
            original_ms + clock.elapsed().as_secs_f64() * 1000.0,
        )
        .await?;
        let round_clock = Instant::now();
        let mut jobs = JoinSet::new();
        let mut admitted = tuning.rounds[round_index]
            .samples
            .iter()
            .map(|a| a.task_id.clone())
            .collect::<BTreeSet<_>>();
        let mut pulse = tokio::time::interval(Duration::from_millis(100));
        loop {
            tuning.elapsed_ms = old_elapsed + clock.elapsed().as_secs_f64() * 1000.0;
            tuning.rounds[round_index].elapsed_ms =
                round_base + round_clock.elapsed().as_secs_f64() * 1000.0;
            let status = s.runs.lock().await[id].status.clone();
            if status == "cancelling" {
                jobs.abort_all();
                while jobs.join_next().await.is_some() {}
                scoring::cleanup_run(id).await;
                persist(
                    s,
                    id,
                    &tuning,
                    original_ms + clock.elapsed().as_secs_f64() * 1000.0,
                )
                .await?;
                s.checkpoint(id, |r| r.status = "cancelled".into()).await?;
                return Ok(false);
            }
            let remaining = tuning.budget_ms - tuning.elapsed_ms;
            if remaining <= 0.0 {
                jobs.abort_all();
                while jobs.join_next().await.is_some() {}
                scoring::cleanup_run(id).await;
                tuning.rounds[round_index].status = "budget_exhausted".into();
                tuning.rounds[round_index].ended_at = Some(now());
                tuning.finish(
                    "동시 요청 측정 10분 예산이 끝나 기존 동시 설정을 유지합니다.",
                    true,
                );
                break;
            }
            if status == "running" {
                for task_id in &tuning.sample_ids {
                    if jobs.len() >= concurrency {
                        break;
                    }
                    if admitted.insert(task_id.clone()) {
                        let mut c = config.clone();
                        c.concurrency = concurrency;
                        jobs.spawn(probe(
                            s.clone(),
                            id.into(),
                            c,
                            tasks[task_id].clone(),
                            remaining,
                        ));
                    }
                }
            }
            if jobs.is_empty() {
                if status == "pausing" {
                    persist(
                        s,
                        id,
                        &tuning,
                        original_ms + clock.elapsed().as_secs_f64() * 1000.0,
                    )
                    .await?;
                    s.checkpoint(id, |r| r.status = "paused".into()).await?;
                    return Ok(false);
                }
                if tuning.rounds[round_index].samples.len() == tuning.sample_ids.len() {
                    // Release every model request before grading. Grader startup
                    // and checkpoints must not occupy model concurrency slots.
                    for sample in &mut tuning.rounds[round_index].samples {
                        if sample.attempt.error.is_none() && sample.attempt.score.is_none() {
                            let grade_clock = Instant::now();
                            let remaining = (tuning.budget_ms
                                - old_elapsed
                                - clock.elapsed().as_secs_f64() * 1000.0)
                                .max(1.0);
                            sample.attempt.score = Some(
                                match tokio::time::timeout(
                                    Duration::from_secs_f64(remaining / 1000.0),
                                    runtime::evaluate(
                                        s,
                                        id,
                                        &config,
                                        &tasks[&sample.task_id],
                                        &sample.attempt.output,
                                    ),
                                )
                                .await
                                {
                                    Ok(score) => score,
                                    Err(_) => scoring::unavailable(
                                        "자동 비교 예산 내 채점을 마치지 못했습니다.".into(),
                                    ),
                                },
                            );
                            sample.attempt.metrics.grading_ms =
                                Some(grade_clock.elapsed().as_secs_f64() * 1000.0);
                        }
                    }
                    tuning.rounds[round_index].elapsed_ms =
                        round_base + round_clock.elapsed().as_secs_f64() * 1000.0;
                    let r = &mut tuning.rounds[round_index];
                    r.status = "completed".into();
                    r.ended_at = Some(now());
                    r.samples.sort_by_key(|s| {
                        tuning
                            .sample_ids
                            .iter()
                            .position(|id| id == &s.task_id)
                            .unwrap_or(usize::MAX)
                    });
                    r.inference_ms = inference_window(r);
                    r.overhead_ms = r.inference_ms.map(|ms| (r.elapsed_ms - ms).max(0.0));
                    r.throughput_tps = r.inference_ms.map(|ms| {
                        r.samples
                            .iter()
                            .filter_map(|s| s.attempt.metrics.output_tokens)
                            .sum::<u64>() as f64
                            * 1000.0
                            / ms
                    });
                    persist(
                        s,
                        id,
                        &tuning,
                        original_ms + clock.elapsed().as_secs_f64() * 1000.0,
                    )
                    .await?;
                    break;
                }
            }
            if sensor_jobs.is_empty()
                && sensor_clock.elapsed() >= Duration::from_secs(2)
                && (config.device.is_some() || !config.telemetry_url.is_empty())
            {
                sensor_jobs.spawn(telemetry(s.clone(), config.clone()));
                sensor_clock = Instant::now();
            }
            tokio::select! {
                Some(joined)=jobs.join_next(),if !jobs.is_empty()=>{
                    let sample=match joined {Ok(sample)=>sample,Err(_)=>{
                        jobs.abort_all();while jobs.join_next().await.is_some(){}scoring::cleanup_run(id).await;
                        tuning.rounds[round_index].status="failed".into();tuning.rounds[round_index].ended_at=Some(now());
                        tuning.finish("동시 요청 비교 작업을 끝내지 못해 기존 동시 설정을 유지합니다.",true);break;
                    }};tuning.rounds[round_index].samples.push(sample);
                    tuning.elapsed_ms=old_elapsed+clock.elapsed().as_secs_f64()*1000.0;
                    tuning.rounds[round_index].elapsed_ms=round_base+round_clock.elapsed().as_secs_f64()*1000.0;
                    s.update_progress(id,|r| { r.concurrency_tuning=Some(tuning.clone()); r.active_ms=original_ms+clock.elapsed().as_secs_f64()*1000.0; }).await?;
                },
                Some(Ok(v))=sensor_jobs.join_next(),if !sensor_jobs.is_empty()=>{s.update_progress(id,|r|r.telemetry.push(v)).await?;},
                _=pulse.tick()=>{}
            }
        }
    }
    tuning.elapsed_ms = old_elapsed + clock.elapsed().as_secs_f64() * 1000.0;
    s.checkpoint(id,|r| {
        r.initial_concurrency.get_or_insert(r.config.concurrency);
        if r.execution_segments.is_empty() {
            r.execution_segments.push(json!({"started_at":r.created_at,"concurrency":r.config.concurrency,"completed_before":0,"reason":"initial"}));
        }
        let incumbent_started_at=r.execution_segments.last().and_then(|v|v["started_at"].as_str()).unwrap_or(&r.created_at).to_string();
        r.config.concurrency=tuning.selected_concurrency;
        r.execution_segments.push(json!({"started_at":now(),"concurrency":tuning.selected_concurrency,"completed_before":r.items.iter().filter(|i|["done","error"].contains(&i.status.as_str())).count(),"reason":"auto_tuned","incumbent_concurrency":tuning.incumbent_concurrency,"incumbent_started_at":incumbent_started_at,"operation_changed":tuning.selected_concurrency!=tuning.incumbent_concurrency}));
        r.active_ms=original_ms+clock.elapsed().as_secs_f64()*1000.0;r.concurrency_tuning=Some(tuning);
    }).await?;
    let _ = s.events.send(id.into());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        serde_json::from_value(json!({"name":"synthetic","base_url":"http://127.0.0.1:1/v1","model":"fixture","pack_id":"fixture","profile":"full","subjects":[],"temperature":0,"max_tokens":128,"concurrency":8,"timeout_s":5})).unwrap()
    }
    fn items() -> Vec<Item> {
        (0..20)
            .map(|n| {
                let a = Attempt {
                    started_at: now(),
                    ended_at: Some(now()),
                    output: "1".into(),
                    reasoning: String::new(),
                    finish_reason: Some("stop".into()),
                    error: None,
                    metrics: Metrics {
                        wall_ms: 100.0 + (n / 2) as f64 * 10.0,
                        output_tokens: Some(10 + n as u64 * 10),
                        ..Default::default()
                    },
                    score: Some(Score {
                        value: Some(if n % 3 == 0 { 0.0 } else { 1.0 }),
                        state: "scored".into(),
                        detail: "fixture".into(),
                        scorer_version: "fixture".into(),
                        extra: Value::Null,
                    }),
                    raw: vec![],
                };
                Item {
                    task: Task {
                        id: format!("t{n}"),
                        subject: if n % 2 == 0 { "a" } else { "b" }.into(),
                        prompt: format!("p{n}"),
                        answer: json!(1),
                        scorer: "numeric".into(),
                        max_tokens: 128,
                        meta: Value::Null,
                    },
                    status: "done".into(),
                    attempts: vec![a],
                }
            })
            .collect()
    }
    #[test]
    fn historical_selection_spans_token_quantiles_not_correctness() {
        let c = config();
        let mut rows = items();
        let t = Tuning::for_existing(&c, &rows);
        assert_eq!(
            t.sample_ids,
            ["t2", "t3", "t6", "t7", "t12", "t13", "t16", "t17"]
                .map(str::to_string)
                .to_vec()
        );
        for row in &mut rows {
            row.task.answer = json!(999);
            row.attempts[0].score.as_mut().unwrap().value = Some(0.0);
        }
        assert_eq!(t.sample_ids, Tuning::for_existing(&c, &rows).sample_ids);
        assert_eq!(t.max_concurrency, 8);
    }
    #[test]
    fn measured_pool_excludes_unvisited_subjects_when_eight_samples_exist() {
        let mut rows = items();
        for row in rows.iter_mut().filter(|i| i.task.subject == "b") {
            row.attempts.clear();
            row.status = "pending".into();
        }
        let t = Tuning::for_existing(&config(), &rows);
        assert_eq!(t.sample_ids.len(), 8);
        assert_eq!(
            t.sample_ids
                .iter()
                .filter(|id| rows
                    .iter()
                    .find(|r| &r.task.id == *id)
                    .unwrap()
                    .task
                    .subject
                    == "b")
                .count(),
            0
        );
    }
    #[test]
    fn only_missing_slots_are_filled_from_unmeasured_questions() {
        let mut rows = items();
        for (n, row) in rows.iter_mut().enumerate() {
            if n >= 7 {
                row.attempts.clear();
                row.status = "pending".into();
            }
        }
        let t = Tuning::for_existing(&config(), &rows);
        assert_eq!(t.sample_ids.len(), 8);
        assert!((0..7).all(|n| t.sample_ids.contains(&format!("t{n}"))));
        assert!(t.selection_reason.contains("부족한 1건"));
    }
    #[test]
    fn public_calibration_roundtrips_without_materializing_null_vectors() {
        let t = Tuning::for_existing(&config(), &items());
        let value = t.public(true, false);
        assert!(value.get("previous_measurements").is_none());
        let restored: Tuning = serde_json::from_value(value).unwrap();
        assert_eq!(restored.sample_ids, t.sample_ids);
        let old = config();
        assert!(
            serde_json::to_value(old)
                .unwrap()
                .get("auto_concurrency")
                .is_none()
        );
    }
    fn finish_fixture_round(t: &mut Tuning, per_request_ms: i64, overhead_ms: f64) {
        let index = t.rounds.len() - 1;
        let c = t.rounds[index].concurrency;
        let start = chrono::DateTime::parse_from_rfc3339("2026-11-07T00:00:00Z").unwrap();
        let mut samples = vec![];
        for (i, id) in t.sample_ids.iter().enumerate() {
            let a = start + chrono::Duration::milliseconds((i / c) as i64 * per_request_ms);
            let b = a + chrono::Duration::milliseconds(per_request_ms);
            samples.push(Sample {
                task_id: id.clone(),
                prompt_sha256: prompt_hash(id),
                cached_input_tokens: None,
                attempt: Attempt {
                    started_at: a.to_rfc3339(),
                    ended_at: Some(b.to_rfc3339()),
                    output: "1".into(),
                    reasoning: String::new(),
                    finish_reason: Some("stop".into()),
                    error: None,
                    metrics: Metrics {
                        wall_ms: per_request_ms as f64,
                        output_tokens: Some(100),
                        request_concurrency: Some(c),
                        ..Default::default()
                    },
                    score: Some(Score {
                        value: Some(1.0),
                        state: "scored".into(),
                        detail: String::new(),
                        scorer_version: "fixture".into(),
                        extra: Value::Null,
                    }),
                    raw: vec![],
                },
            });
        }
        let r = &mut t.rounds[index];
        r.samples = samples;
        r.status = "completed".into();
        r.inference_ms = inference_window(r);
        r.elapsed_ms = r.inference_ms.unwrap() + overhead_ms;
        r.overhead_ms = Some(overhead_ms);
        r.started_at = start.to_rfc3339();
        r.ended_at =
            Some((start + chrono::Duration::milliseconds(r.elapsed_ms as i64)).to_rfc3339());
        r.throughput_tps = Some(r.samples.len() as f64 * 100000.0 / r.inference_ms.unwrap());
    }
    fn fixture() -> Tuning {
        Tuning::new(
            &config(),
            &items().iter().map(|i| i.task.clone()).collect::<Vec<_>>(),
        )
    }
    #[test]
    fn explores_c8_after_slower_c4_and_requires_three_repeats() {
        let mut t = fixture();
        for _ in 0..20 {
            t.advance();
            if t.finished() {
                break;
            }
            let c = t.rounds.last().unwrap().concurrency;
            finish_fixture_round(&mut t, if c == 4 { 300 } else { 100 }, 10.0);
        }
        assert_eq!(t.status, "completed");
        assert_eq!(t.selected_concurrency, 8);
        for c in [1, 2, 4, 8] {
            assert_eq!(t.measured(c).len(), 3);
        }
        assert_eq!(t.rounds.iter().filter(|r| r.role == "warmup").count(), 1);
    }
    #[test]
    fn worse_throughput_never_replaces_incumbent_despite_faster_storage() {
        let mut t = fixture();
        t.retain_incumbent(8);
        for _ in 0..20 {
            t.advance();
            if t.finished() {
                break;
            }
            let c = t.rounds.last().unwrap().concurrency;
            finish_fixture_round(
                &mut t,
                1000.0_f64 as i64,
                if c == 8 { 10000.0 } else { 0.0 },
            );
        }
        assert_eq!(t.selected_concurrency, 8);
        assert!(t.rounds.iter().any(|r| r.concurrency == 2
            && r.elapsed_ms < t.rounds[t.selected_round_index.unwrap()].elapsed_ms));
    }
    #[test]
    fn insufficient_or_failed_evidence_retains_incumbent() {
        let mut t = fixture();
        t.retain_incumbent(8);
        t.advance();
        finish_fixture_round(&mut t, 100, 0.0);
        t.finish("budget exhausted", true);
        assert_eq!(t.selected_concurrency, 8);
        assert!(t.selected_round_index.is_none());
        assert!(t.throughput_gain.is_none());
        let serialized = serde_json::to_value(&t).unwrap();
        let restored: Tuning = serde_json::from_value(serialized).unwrap();
        assert_eq!(restored.incumbent_concurrency, 8);
    }
    #[test]
    fn one_repeat_quality_regression_rejects_candidate() {
        let mut t = fixture();
        t.retain_incumbent(1);
        for _ in 0..20 {
            t.advance();
            if t.finished() {
                break;
            }
            finish_fixture_round(&mut t, 100, 0.0);
            let r = t.rounds.last_mut().unwrap();
            if r.concurrency > 1 {
                r.samples[0].attempt.score.as_mut().unwrap().value = Some(0.0);
            }
        }
        assert_eq!(t.selected_concurrency, 1);
    }
    #[test]
    fn interval_union_separates_storage_gaps_and_rejects_impossible_overlap() {
        let mut t = fixture();
        t.add_round(2, "candidate");
        finish_fixture_round(&mut t, 100, 900.0);
        let r = t.rounds.last().unwrap();
        assert_eq!(r.inference_ms, Some(400.0));
        assert_eq!(r.elapsed_ms, 1300.0);
        let mut bad = r.clone();
        bad.concurrency = 1;
        assert_eq!(inference_window(&bad), None);
    }
}
