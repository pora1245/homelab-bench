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
    pub samples: Vec<Sample>,
    pub throughput_tps: Option<f64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Tuning {
    pub version: String,
    pub status: String,
    pub max_concurrency: usize,
    pub selected_concurrency: usize,
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
        // Round-robin subjects, deterministic hash order within each subject.
        // Selection is from actual selected questions, not artificial speed text.
        let mut groups: BTreeMap<&str, Vec<&Task>> = BTreeMap::new();
        for t in tasks.iter().filter(|t| t.scorer != "experience") {
            groups.entry(&t.subject).or_default().push(t);
        }
        for tasks in groups.values_mut() {
            tasks.sort_by_key(|t| prompt_hash(&t.id));
        }
        let mut ids = Vec::new();
        for offset in 0..8 {
            for group in groups.values() {
                if ids.len() == 8 {
                    break;
                }
                if let Some(t) = group.get(offset) {
                    ids.push(t.id.clone());
                }
            }
        }
        let settings = snapshot(c);
        Self {
            version: "auto-concurrency-v1".into(),
            status: "baseline".into(),
            max_concurrency: c.concurrency.clamp(1, 8).min(ids.len().max(1)),
            selected_concurrency: 1,
            sample_ids: ids,
            selection_reason: "선택 과목을 고르게 포함하는 고정 ID 해시 표본".into(),
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
    pub fn for_existing(c: &Config, items: &[Item]) -> Self {
        let tasks = items.iter().map(|i| i.task.clone()).collect::<Vec<_>>();
        let mut tuning = Self::new(c, &tasks);
        let mut groups: BTreeMap<&str, Vec<(&str, f64)>> = BTreeMap::new();
        for item in items.iter().filter(|i| i.task.scorer != "experience") {
            if let Some(a) = item.attempts.last().filter(|a| {
                a.error.is_none()
                    && a.ended_at.is_some()
                    && matches!(
                        a.finish_reason.as_deref(),
                        Some("stop" | "eos" | "end_turn")
                    )
                    && a.metrics.wall_ms.is_finite()
                    && a.metrics.wall_ms > 0.0
            }) {
                groups.entry(&item.task.subject).or_default().push((
                    &item.task.id,
                    a.metrics.wall_ms + a.metrics.grading_ms.unwrap_or(0.0).max(0.0),
                ));
            }
        }
        if groups.is_empty() {
            return tuning;
        }
        for group in groups.values_mut() {
            group.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(b.0)));
        }
        let mut ids = Vec::new();
        // Prefer the global pool of measured, normally completed questions.
        // Rotate subjects within that pool; an unvisited subject must not
        // displace an available measured question with an unknown long probe.
        for offset in 0..8 {
            for group in groups.values() {
                if ids.len() == 8 {
                    break;
                }
                if let Some((id, _)) = group.get(offset) {
                    ids.push((*id).to_string());
                }
            }
        }
        let measured_count = ids.len();
        if measured_count < 8 {
            let mut pending: BTreeMap<&str, Vec<&Task>> = BTreeMap::new();
            for task in tasks
                .iter()
                .filter(|t| t.scorer != "experience" && !ids.contains(&t.id))
            {
                pending.entry(&task.subject).or_default().push(task);
            }
            for group in pending.values_mut() {
                group.sort_by_key(|t| prompt_hash(&t.id));
            }
            for offset in 0..8 {
                for group in pending.values() {
                    if ids.len() == 8 {
                        break;
                    }
                    if let Some(task) = group.get(offset) {
                        ids.push(task.id.clone());
                    }
                }
            }
        }
        tuning.sample_ids = ids;
        tuning.max_concurrency = c
            .concurrency
            .clamp(1, 8)
            .min(tuning.sample_ids.len().max(1));
        tuning.selection_reason = format!(
            "기존 정상 종료·실측 표본 {measured_count}건을 먼저 모아 그 안에서 과목별 짧은 문항을 선택했습니다. 부족한 {}건만 미측정 문항으로 보충했으며 정답 여부는 선택에 사용하지 않았습니다.",
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
            samples: vec![],
            throughput_tps: None,
        });
    }
    fn usable(&self, index: usize) -> bool {
        let r = &self.rounds[index];
        r.status == "completed"
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
            / r.elapsed_ms
    }
    fn gains(&self, base: usize, candidate: usize) -> (f64, f64) {
        (
            self.throughput(candidate) / self.throughput(base),
            self.rounds[base].elapsed_ms / self.rounds[candidate].elapsed_ms,
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
            self.selected_concurrency = 1;
            self.selected_round_index = self.baseline_round_index;
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
    /// Return the next round or finalize. No candidate is selected on a partial batch.
    fn advance(&mut self) {
        if self.sample_ids.len() < 2 || self.max_concurrency < 2 {
            self.finish(
                "동시 비교에 필요한 문항 또는 상한이 부족해 단일 요청으로 진행합니다.",
                true,
            );
            return;
        }
        if self.rounds.is_empty() {
            self.add_round(1, "baseline");
            return;
        }
        if self.rounds.iter().any(|r| r.status == "running") {
            return;
        }
        if !self.usable(0) {
            self.finish(
                "단일 요청 표본의 응답·사용량·채점이 완결되지 않아 단일 요청으로 진행합니다.",
                true,
            );
            return;
        }
        // Compare against the faster c1 round after caches have seen the same prompts.
        let baseline = self
            .rounds
            .iter()
            .enumerate()
            .filter(|(i, r)| r.concurrency == 1 && self.usable(*i))
            .min_by(|(_, a), (_, b)| a.elapsed_ms.total_cmp(&b.elapsed_ms))
            .unwrap()
            .0;
        self.baseline_round_index = Some(baseline);
        self.selected_round_index = Some(baseline);
        self.selected_concurrency = 1;
        let last = self.rounds.len() - 1;
        if self.rounds[last].role == "confirmation" && !self.usable(last) {
            self.finish(
                "캐시 영향을 확인하는 단일 요청 재측정이 완결되지 않아 단일 요청으로 진행합니다.",
                true,
            );
            return;
        }
        let candidates = self
            .rounds
            .iter()
            .enumerate()
            .filter(|(_, r)| r.concurrency > 1)
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            self.add_round(2.min(self.max_concurrency), "candidate");
            return;
        }
        let last_candidate = *candidates.last().unwrap();
        if self.better(baseline, last_candidate)
            && !self.rounds.iter().any(|r| r.role == "confirmation")
        {
            self.add_round(1, "confirmation");
            return;
        }
        let mut best = baseline;
        for &candidate in &candidates {
            if self.better(baseline, candidate) && self.better(best, candidate) {
                best = candidate;
            }
        }
        self.selected_round_index = Some(best);
        self.selected_concurrency = self.rounds[best].concurrency;
        if best != last_candidate {
            self.finish(
                "동일 문항의 처리량과 완료시간이 모두 10% 이상 개선되는 최선의 설정을 유지합니다.",
                false,
            );
            return;
        }
        let next = (self.rounds[best].concurrency * 2).min(self.max_concurrency);
        if next <= self.rounds[best].concurrency {
            self.finish(
                "설정 상한까지 같은 문항을 비교하고 가장 빠른 검증 설정을 선택했습니다.",
                false,
            );
        } else {
            self.add_round(next, "candidate");
        }
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
    if attempt.error.is_none() {
        let clock = Instant::now();
        attempt.score = Some(
            match tokio::time::timeout_at(
                deadline,
                runtime::evaluate(&s, &id, &config, &task, &attempt.output),
            )
            .await
            {
                Ok(score) => score,
                Err(_) => {
                    scoring::unavailable("동시 요청 측정 예산 내 채점을 마치지 못했습니다.".into())
                }
            },
        );
        attempt.metrics.grading_ms = Some(clock.elapsed().as_secs_f64() * 1000.0);
    }
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
    let clock = Instant::now();
    let old_elapsed = tuning.elapsed_ms;
    let mut sensor_jobs = JoinSet::new();
    let mut sensor_clock = Instant::now();
    if tuning.settings_fingerprint != digest(&snapshot(&config))
        || tuning.sample_ids.iter().any(|id| !tasks.contains_key(id))
    {
        tuning.finish(
            "표본 또는 실행 설정이 변경되어 단일 요청으로 진행합니다.",
            true,
        );
    }
    while !tuning.finished() {
        tuning.elapsed_ms = old_elapsed + clock.elapsed().as_secs_f64() * 1000.0;
        if tuning.elapsed_ms >= tuning.budget_ms {
            tuning.finish(
                "동시 요청 측정 10분 예산이 끝나 단일 요청으로 진행합니다.",
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
        let round_clock = Instant::now();
        persist(
            s,
            id,
            &tuning,
            original_ms + clock.elapsed().as_secs_f64() * 1000.0,
        )
        .await?;
        let mut jobs = JoinSet::new();
        let mut admitted = tuning.rounds[round_index]
            .samples
            .iter()
            .map(|a| a.task_id.clone())
            .collect::<BTreeSet<_>>();
        let mut pulse = tokio::time::interval(Duration::from_millis(100));
        let mut checkpoint = Instant::now();
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
                    "동시 요청 측정 10분 예산이 끝나 단일 요청으로 진행합니다.",
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
                    r.throughput_tps = Some(
                        r.samples
                            .iter()
                            .filter_map(|s| s.attempt.metrics.output_tokens)
                            .sum::<u64>() as f64
                            * 1000.0
                            / r.elapsed_ms,
                    );
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
            if checkpoint.elapsed() >= Duration::from_secs(1) {
                persist(
                    s,
                    id,
                    &tuning,
                    original_ms + clock.elapsed().as_secs_f64() * 1000.0,
                )
                .await?;
                checkpoint = Instant::now();
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
                        tuning.finish("동시 요청 비교 작업을 끝내지 못해 단일 요청으로 진행합니다.",true);break;
                    }};tuning.rounds[round_index].samples.push(sample);
                    tuning.elapsed_ms=old_elapsed+clock.elapsed().as_secs_f64()*1000.0;
                    tuning.rounds[round_index].elapsed_ms=round_base+round_clock.elapsed().as_secs_f64()*1000.0;
                    persist(s,id,&tuning,original_ms+clock.elapsed().as_secs_f64()*1000.0).await?;
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
        r.config.concurrency=tuning.selected_concurrency;
        r.execution_segments.push(json!({"started_at":now(),"concurrency":tuning.selected_concurrency,"completed_before":r.items.iter().filter(|i|["done","error"].contains(&i.status.as_str())).count(),"reason":"auto_tuned"}));
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
                        output_tokens: Some(10),
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
    fn historical_selection_uses_time_and_subject_not_correctness() {
        let c = config();
        let mut rows = items();
        let t = Tuning::for_existing(&c, &rows);
        assert_eq!(
            t.sample_ids,
            (0..8).map(|n| format!("t{n}")).collect::<Vec<_>>()
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
}
