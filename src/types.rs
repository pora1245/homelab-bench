use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn digest(v: &impl Serialize) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(serde_json::to_vec(v).unwrap()))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub subject: String,
    pub prompt: String,
    pub answer: Value,
    pub scorer: String,
    pub max_tokens: u32,
    #[serde(default)]
    pub meta: Value,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Pack {
    pub id: String,
    pub name: String,
    pub version: String,
    pub sources: Value,
    pub tasks: Vec<Task>,
}
#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ExecutionInfo {
    pub engine: String,
    pub engine_version: String,
    pub model_revision: String,
    pub quantization: String,
    pub context_length: String,
    pub parallelism: String,
    pub speculative: String,
    pub cache: String,
    pub offload: String,
    pub provenance: String,
}
fn optional_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}
pub fn default_api_format() -> String {
    "chat_completions".into()
}
fn is_false(v: &bool) -> bool {
    !*v
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    #[serde(default = "default_api_format")]
    pub api_format: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub pack_id: String,
    pub profile: String,
    #[serde(default)]
    pub subjects: Vec<String>,
    pub temperature: f64,
    pub max_tokens: u32,
    pub concurrency: usize,
    #[serde(default, skip_serializing_if = "is_false")]
    pub auto_concurrency: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_item_limit: Option<usize>,
    pub timeout_s: u64,
    #[serde(default)]
    pub reasoning_effort: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub telemetry_url: String,
    #[serde(default)]
    pub judge: Option<JudgeConfig>,
    #[serde(default, deserialize_with = "optional_id")]
    pub connection_id: String,
    #[serde(default, deserialize_with = "optional_id")]
    pub judge_connection_id: String,
    #[serde(default, deserialize_with = "optional_id")]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub device: Option<crate::settings::Device>,
    #[serde(default)]
    pub execution_info: ExecutionInfo,
    #[serde(default)]
    pub reasoning_parameters: Value,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct JudgeConfig {
    #[serde(default = "default_api_format")]
    pub api_format: String,
    pub base_url: String,
    pub model: String,
    pub max_tokens: u32,
}
#[derive(Deserialize)]
pub struct Start {
    pub config: Config,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub judge_key: String,
    #[serde(default, deserialize_with = "optional_id")]
    pub connection_id: String,
    #[serde(default, deserialize_with = "optional_id")]
    pub judge_connection_id: String,
    #[serde(default, deserialize_with = "explicit_device_id")]
    pub device_id: Option<String>,
    #[serde(default)]
    pub preflight_token: String,
    #[serde(default)]
    pub allow_limited_metrics: bool,
}

fn explicit_device_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?.unwrap_or_default()))
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Metrics {
    #[serde(default)]
    pub request_concurrency: Option<usize>,
    #[serde(default)]
    pub visible_decode_span_ms: Option<f64>,
    #[serde(default)]
    pub visible_stream_chunks: Option<usize>,
    #[serde(default)]
    pub server_decode_ms: Option<f64>,
    #[serde(default)]
    pub server_decode_tokens: Option<u64>,
    #[serde(default)]
    pub server_prefill_ms: Option<f64>,
    #[serde(default)]
    pub server_prefill_tokens: Option<u64>,
    #[serde(default)]
    pub grading_ms: Option<f64>,
    #[serde(default)]
    pub measurement_version: String,
    #[serde(default)]
    pub reasoning_ttft_ms: Option<f64>,
    #[serde(default)]
    pub visible_output_tokens: Option<u64>,
    #[serde(default)]
    pub reasoning_tokens: Option<u64>,
    #[serde(default)]
    pub client_visible_decode_tps: Option<f64>,
    #[serde(default)]
    pub client_visible_decode_source: String,
    pub ttft_ms: Option<f64>,
    #[serde(default)]
    pub ttft_source: String,
    #[serde(default)]
    pub ttft_reason: String,
    pub wall_ms: f64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub decode_tps: Option<f64>,
    pub prefill_tps: Option<f64>,
    pub decode_source: String,
    pub prefill_source: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Score {
    pub value: Option<f64>,
    pub state: String,
    pub detail: String,
    pub scorer_version: String,
    #[serde(default)]
    pub extra: Value,
}
impl Score {
    pub fn valid_value(&self) -> Option<f64> {
        self.value
            .filter(|v| self.state == "scored" && v.is_finite() && (0.0..=1.0).contains(v))
    }
    pub fn with_previous(mut self, previous: Option<&Score>) -> Self {
        if !self.extra.is_object() {
            self.extra = serde_json::json!({});
        }
        let mut history = previous
            .and_then(|s| s.extra["grading_history"].as_array())
            .cloned()
            .unwrap_or_default();
        if let Some(old) = previous {
            let mut snapshot = serde_json::to_value(old).unwrap();
            if let Some(extra) = snapshot["extra"].as_object_mut() {
                extra.remove("grading_history");
                if !history.is_empty() {
                    extra.remove("previous_score");
                }
            }
            history.push(serde_json::json!({"superseded_at":now(),"score":snapshot}));
            self.extra["previous_score"] = snapshot;
        }
        self.extra["graded_at"] = now().into();
        self.extra["grading_history"] = history.into();
        self
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Attempt {
    pub started_at: String,
    pub ended_at: Option<String>,
    pub output: String,
    pub reasoning: String,
    pub finish_reason: Option<String>,
    pub error: Option<String>,
    pub metrics: Metrics,
    pub score: Option<Score>,
    pub raw: Vec<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Item {
    pub task: Task,
    pub status: String,
    pub attempts: Vec<Attempt>,
}
impl Item {
    pub fn verdict(&self) -> &'static str {
        match self.status.as_str() {
            "running" => "generating",
            "grading" => "grading_pending",
            "pending" => {
                if self
                    .attempts
                    .last()
                    .and_then(|a| a.error.as_deref())
                    .is_some_and(|e| e.contains("중단"))
                {
                    "interrupted"
                } else {
                    "not_started"
                }
            }
            "error" => "request_error",
            _ => match self.attempts.last().and_then(|a| a.score.as_ref()) {
                Some(s) if s.state == "measured" => {
                    if s.extra["valid_output"] == true {
                        "measured"
                    } else {
                        "measurement_invalid"
                    }
                }
                Some(s) => match s.valid_value() {
                    Some(1.0) => "correct",
                    Some(0.0) => "incorrect",
                    Some(_) => "partial",
                    None => "unscored",
                },
                None => "grading_pending",
            },
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub created_at: String,
    pub config: Config,
    pub status: String,
    pub suite_hash: String,
    pub protocol_version: String,
    pub pack_version: String,
    pub provenance: String,
    pub items: Vec<Item>,
    pub telemetry: Vec<Value>,
    pub active_ms: f64,
    pub error: Option<String>,
    #[serde(default)]
    pub execution_segments: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_concurrency: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency_tuning: Option<crate::auto_concurrency::Tuning>,
}
impl Run {
    pub fn request_concurrency(&self, a: &Attempt) -> usize {
        if let Some(n) = a.metrics.request_concurrency {
            return n;
        }
        let started = chrono::DateTime::parse_from_rfc3339(&a.started_at).ok();
        self.execution_segments
            .iter()
            .rev()
            .find_map(|segment| {
                let at = segment["started_at"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())?;
                (started.is_some_and(|s| s >= at))
                    .then(|| segment["concurrency"].as_u64().map(|n| n as usize))
                    .flatten()
            })
            .unwrap_or(self.initial_concurrency.unwrap_or(self.config.concurrency))
    }
    /// Copy only fields needed by the live view while holding the run lock.
    /// Expensive metrics/JSON work is performed after releasing that lock.
    pub fn compact_snapshot(&self) -> Self {
        Self {
            id: self.id.clone(), created_at: self.created_at.clone(), config: self.config.clone(),
            status: self.status.clone(), suite_hash: self.suite_hash.clone(),
            protocol_version: self.protocol_version.clone(), pack_version: self.pack_version.clone(),
            provenance: self.provenance.clone(), active_ms: self.active_ms, error: self.error.clone(),
            execution_segments: self.execution_segments.clone(), initial_concurrency: self.initial_concurrency,
            concurrency_tuning: self.concurrency_tuning.clone(),
            telemetry: self.telemetry.iter().skip(self.telemetry.len().saturating_sub(300)).cloned().collect(),
            items: self.items.iter().map(|i| Item {
                status: i.status.clone(), task: Task { id:i.task.id.clone(), subject:i.task.subject.clone(),
                    scorer:i.task.scorer.clone(), max_tokens:i.task.max_tokens, prompt:String::new(), answer:Value::Null,
                    meta:serde_json::json!({"performance_protocol":i.task.meta["performance_protocol"],
                      "prompt_sha256":i.task.meta["prompt_sha256"],"experience_case":i.task.meta["experience_case"],"warmup":i.task.meta["warmup"]}) },
                attempts:i.attempts.iter().map(|a| Attempt {started_at:a.started_at.clone(),ended_at:a.ended_at.clone(),
                    output:String::new(),reasoning:String::new(),finish_reason:a.finish_reason.clone(),error:a.error.clone(),
                    metrics:a.metrics.clone(),score:a.score.clone(),raw:vec![]}).collect()
            }).collect(),
        }
    }
    pub fn compact(&self) -> Value {
        let items=self.items.iter().map(|i|serde_json::json!({
            "task":{"id":i.task.id,"subject":i.task.subject,"scorer":i.task.scorer,"max_tokens":i.task.max_tokens,"prompt":"","answer":null,"meta":{
                "performance_protocol":i.task.meta["performance_protocol"],
                "prompt_sha256":i.task.meta["prompt_sha256"],
                "experience_case":i.task.meta["experience_case"],
                "warmup":i.task.meta["warmup"]}},
            "status":i.status,"verdict":i.verdict(),"attempts":i.attempts.iter().map(|a|serde_json::json!({"started_at":a.started_at,"ended_at":a.ended_at,"output":"","reasoning":"","finish_reason":a.finish_reason,"error":a.error,"metrics":a.metrics,"metric_quality":crate::metrics_quality::evaluate(&a.metrics),"score":a.score.as_ref().map(|s|serde_json::json!({"value":s.value,"state":s.state,"detail":s.detail,"scorer_version":s.scorer_version,"extra":{"valid_output":s.extra["valid_output"],"format_compliant":s.extra["format_compliant"],"presentation_wrapper":s.extra["presentation_wrapper"],"experience_case":s.extra["experience_case"],"warmup":s.extra["warmup"],"error_code":s.extra["error_code"],"remedy":s.extra["remedy"],"graded_at":s.extra["graded_at"],"grading_history_count":s.extra["grading_history"].as_array().map(|a|a.len()).unwrap_or(0)}})),"raw":null})).collect::<Vec<_>>()
        })).collect::<Vec<_>>();
        serde_json::json!({"id":self.id,"created_at":self.created_at,"config":self.config,"status":self.status,"suite_hash":self.suite_hash,"protocol_version":self.protocol_version,"pack_version":self.pack_version,"provenance":self.provenance,"items":items,"telemetry":self.telemetry.iter().skip(self.telemetry.len().saturating_sub(300)).collect::<Vec<_>>(),"telemetry_count":self.telemetry.len(),"telemetry_truncated":self.telemetry.len()>300,"active_ms":self.active_ms,"error":self.error,"execution_segments":self.execution_segments,"initial_concurrency":self.initial_concurrency,"concurrency_tuning":self.concurrency_tuning.as_ref().map(|t|t.public(false,true)),"summary":self.summary()})
    }

    pub fn public(&self, raw: bool) -> Value {
        let mut v = serde_json::to_value(self).unwrap();
        for (i, item) in v["items"].as_array_mut().unwrap().iter_mut().enumerate() {
            item["verdict"] = self.items[i].verdict().into();
            if self.items[i].status != "done" && self.items[i].status != "error" {
                item["task"]["answer"] = Value::Null;
                item["task"]["meta"] = Value::Null;
            }
            for (n, a) in item["attempts"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .enumerate()
            {
                a["metric_quality"] =
                    crate::metrics_quality::evaluate(&self.items[i].attempts[n].metrics);
                if !raw {
                    a["raw"] = Value::Null;
                }
            }
        }
        v["summary"] = self.summary();
        if let Some(t) = &self.concurrency_tuning {
            v["concurrency_tuning"] = t.public(raw, false);
        }
        v
    }
    pub fn summary(&self) -> Value {
        let current_segment = self.execution_segments.last();
        let segment_start = current_segment
            .and_then(|s| s["started_at"].as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
        let segment_concurrency = current_segment
            .and_then(|s| s["concurrency"].as_u64())
            .map(|n| n as usize)
            .unwrap_or(self.config.concurrency);
        let mut scoped_requests = 0usize;
        let mut ignored_requests = 0usize;
        let mut other_concurrency_requests = 0usize;
        let mut single_performance_ttft = Vec::new();
        let mut single_performance_decode = Vec::new();
        let mut single_performance_n = 0usize;
        let mut subjects: BTreeMap<String, Value> = BTreeMap::new();
        let mut ttft = vec![];
        let mut decode = vec![];
        let mut client_visible_decode = vec![];
        let quality_total = self
            .items
            .iter()
            .filter(|i| i.task.scorer != "experience")
            .count();
        let performance_total = self
            .items
            .iter()
            .filter(|i| i.task.scorer == "experience" && i.task.meta["warmup"] != true)
            .count();
        let warmup_total = self
            .items
            .iter()
            .filter(|i| i.task.meta["warmup"] == true)
            .count();
        let mut prefill = vec![];
        let mut completed = 0;
        let mut errors = 0;
        let mut truncated = 0;
        let mut score_errors = 0;
        let (mut measured, mut measurement_errors) = (0usize, 0usize);
        let (mut collected, mut scored, mut correct, mut incorrect, mut partial) =
            (0usize, 0usize, 0usize, 0usize, 0usize);
        let mut points = 0.0;
        let mut starts = Vec::new();
        let mut ends = Vec::new();
        let mut tokens = 0u64;
        let mut throughput_n = 0;
        let mut decode_sources: BTreeMap<String, usize> = BTreeMap::new();
        let mut metric_coverage = crate::metrics_quality::Coverage::default();
        for i in &self.items {
            let s = subjects.entry(i.task.subject.clone()).or_insert(
                serde_json::json!({"total":0,"completed":0,"collected":0,"scored":0,"points":0.0,"errors":0,"correct":0,"incorrect":0,"partial":0,"score_errors":0,"measured":0,"measurement_errors":0}),
            );
            s["total"] = (s["total"].as_u64().unwrap() + 1).into();
            if ["done", "error"].contains(&i.status.as_str()) {
                completed += 1;
                s["completed"] = (s["completed"].as_u64().unwrap() + 1).into();
            }
            if i.status == "error" {
                errors += 1;
                s["errors"] = (s["errors"].as_u64().unwrap() + 1).into();
            }
            if let Some(a) = i
                .attempts
                .last()
                .filter(|_| ["done", "error", "grading"].contains(&i.status.as_str()))
            {
                if a.finish_reason.as_deref() == Some("length") {
                    truncated += 1;
                }
                if a.ended_at.is_some() && a.error.is_none() {
                    collected += 1;
                    s["collected"] = (s["collected"].as_u64().unwrap() + 1).into();
                    let in_current_segment = segment_start.is_none_or(|at| {
                        chrono::DateTime::parse_from_rfc3339(&a.started_at).is_ok_and(|s| s >= at)
                    });
                    let request_concurrency = self.request_concurrency(a);
                    if i.task.scorer == "experience"
                        && i.task.meta["warmup"] != true
                        && request_concurrency == 1
                    {
                        let q = crate::metrics_quality::evaluate(&a.metrics);
                        single_performance_n += 1;
                        if let Some(v) = a.metrics.ttft_ms.filter(|_| q["valid"]["ttft_ms"] == true)
                        {
                            single_performance_ttft.push(v);
                        }
                        if let Some(v) = a
                            .metrics
                            .client_visible_decode_tps
                            .filter(|_| q["valid"]["client_visible_decode_tps"] == true)
                        {
                            single_performance_decode.push(v);
                        }
                    }
                    if i.task.meta["warmup"] != true {
                        if !in_current_segment {
                            ignored_requests += 1;
                        } else if request_concurrency != segment_concurrency {
                            other_concurrency_requests += 1;
                        }
                    }
                    if i.task.meta["warmup"] != true
                        && in_current_segment
                        && request_concurrency == segment_concurrency
                    {
                        scoped_requests += 1;
                        let q = metric_coverage.observe(&a.metrics);
                        if let Some(x) = a.metrics.ttft_ms.filter(|_| q["valid"]["ttft_ms"] == true)
                        {
                            ttft.push(x);
                        }
                        if let Some(x) = a
                            .metrics
                            .client_visible_decode_tps
                            .filter(|_| q["valid"]["client_visible_decode_tps"] == true)
                        {
                            client_visible_decode.push(x);
                        }
                        if let Some(x) = a
                            .metrics
                            .decode_tps
                            .filter(|_| q["valid"]["decode_tps"] == true)
                        {
                            decode.push(x);
                            *decode_sources
                                .entry(a.metrics.decode_source.clone())
                                .or_default() += 1;
                        }
                        if let Some(x) = a
                            .metrics
                            .prefill_tps
                            .filter(|_| q["valid"]["prefill_tps"] == true)
                        {
                            prefill.push(x);
                        }
                        if let (Ok(start), Some(Ok(end)), Some(n)) = (
                            chrono::DateTime::parse_from_rfc3339(&a.started_at),
                            a.ended_at
                                .as_ref()
                                .map(|x| chrono::DateTime::parse_from_rfc3339(x)),
                            (if a.metrics.measurement_version.is_empty() {
                                a.metrics.output_tokens
                            } else {
                                a.metrics.visible_output_tokens
                            })
                            .filter(|_| q["valid"]["throughput"] == true),
                        ) {
                            starts.push(start.timestamp_millis());
                            ends.push(end.timestamp_millis());
                            tokens += n;
                            throughput_n += 1;
                        }
                    }
                }
                if let Some(sc) = a
                    .score
                    .as_ref()
                    .filter(|_| a.error.is_none() && a.ended_at.is_some())
                {
                    if sc.state == "measured" {
                        let category = if sc.extra["valid_output"] == true {
                            measured += 1;
                            "measured"
                        } else {
                            measurement_errors += 1;
                            "measurement_errors"
                        };
                        s[category] = (s[category].as_u64().unwrap() + 1).into();
                    } else if let Some(x) = sc.valid_value() {
                        scored += 1;
                        points += x;
                        let category = if x == 1.0 {
                            correct += 1;
                            "correct"
                        } else if x == 0.0 {
                            incorrect += 1;
                            "incorrect"
                        } else {
                            partial += 1;
                            "partial"
                        };
                        s[category] = (s[category].as_u64().unwrap() + 1).into();
                        s["scored"] = (s["scored"].as_u64().unwrap() + 1).into();
                        s["points"] = (s["points"].as_f64().unwrap() + x).into();
                    } else {
                        score_errors += 1;
                        s["score_errors"] = (s["score_errors"].as_u64().unwrap() + 1).into();
                    }
                }
            }
        }
        for s in subjects.values_mut() {
            let n = s["scored"].as_u64().unwrap();
            s["unscored"] = (s["total"].as_u64().unwrap()
                - n
                - s["measured"].as_u64().unwrap()
                - s["measurement_errors"].as_u64().unwrap())
            .into();
            s["accuracy_percent"] = if n > 0 {
                serde_json::json!(100.0 * s["correct"].as_u64().unwrap() as f64 / n as f64)
            } else {
                Value::Null
            };
            s["percent"] = if n > 0 {
                serde_json::json!(100.0 * s["points"].as_f64().unwrap() / n as f64)
            } else {
                Value::Null
            };
        }
        let span = ends
            .iter()
            .max()
            .zip(starts.iter().min())
            .map(|(e, s)| e - s)
            .filter(|n| *n > 0);
        let throughput = if self.provenance == "live_api" {
            span.map(|ms| tokens as f64 * 1000.0 / ms as f64)
        } else {
            None
        };
        let grading_pending =
            collected.saturating_sub(scored + score_errors + measured + measurement_errors);
        let collection_status = if collected == self.items.len() {
            "completed"
        } else if self.status == "completed" {
            "partial"
        } else if ["running", "pausing"].contains(&self.status.as_str()) {
            "in_progress"
        } else {
            "incomplete"
        };
        let grading_status = if self.status == "scoring" {
            "in_progress"
        } else if scored + measured == self.items.len() {
            "completed"
        } else if score_errors + measurement_errors > 0 {
            if scored + measured == 0 {
                "failed"
            } else {
                "partial"
            }
        } else if grading_pending > 0 {
            "in_progress"
        } else if scored + measured > 0 {
            "partial"
        } else {
            "not_started"
        };
        let ttft = stats(ttft);
        let decode = stats(decode);
        let client_visible_decode = stats(client_visible_decode);
        let prefill = stats(prefill);
        let metric_quality = metric_coverage.finish();
        let scope = serde_json::json!({"started_at":current_segment.and_then(|s|s["started_at"].as_str()),"concurrency":segment_concurrency,"request_count":scoped_requests,"ignored_previous_requests":ignored_requests,"other_concurrency_requests":other_concurrency_requests});
        let current_segment_stats = serde_json::json!({"scope":scope,"ttft_ms":ttft,"decode_tps":decode,"client_visible_decode_tps":client_visible_decode,"prefill_tps":prefill,"output_throughput_tps":throughput,"throughput_n":throughput_n,"metric_quality":metric_quality,
            "single_request_performance":{"request_count":single_performance_n,"ttft_ms":stats(single_performance_ttft),"client_visible_decode_tps":stats(single_performance_decode),"concurrency":1}});
        serde_json::json!({"total":self.items.len(),"quality_total":quality_total,"performance_total":performance_total,"warmup_total":warmup_total,"completed":completed,"errors":errors,"truncated":truncated,"score_errors":score_errors,"subjects":subjects,
            "collected":collected,"measured":measured,"measurement_errors":measurement_errors,"scored":scored,"correct":correct,"incorrect":incorrect,"partial":partial,"unscored":self.items.len()-scored-measured-measurement_errors,"grading_pending":grading_pending,"collection_status":collection_status,"grading_status":grading_status,"accuracy_percent":if scored>0 {Some(100.0*correct as f64/scored as f64)} else {None},"score_percent":if scored>0 {Some(100.0*points/scored as f64)}else{None},
            "current_segment_stats":current_segment_stats,"execution_segments":self.execution_segments,"metric_scope":scope,"metric_quality":metric_quality,"ttft_ms":ttft,"client_visible_decode_tps":client_visible_decode,"decode_tps":decode,"prefill_tps":prefill,"active_ms":self.active_ms,"decode_sources":decode_sources,
            "output_throughput_tps":throughput,"throughput_n":throughput_n,"throughput_scope":"첫 요청 시작~마지막 응답 완료; 프리필·요청 사이 채점·일시정지 포함"})
    }
}
pub fn stats(mut v: Vec<f64>) -> Value {
    if v.is_empty() {
        return Value::Null;
    }
    v.sort_by(f64::total_cmp);
    let n = v.len();
    let median = if n % 2 == 0 {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    } else {
        v[n / 2]
    };
    serde_json::json!({"median":median,"min":v[0],"max":v[n-1],"n":n})
}

#[cfg(test)]
mod scoring_summary_tests {
    use super::*;
    use serde_json::json;
    fn run(items: Vec<Value>) -> Run {
        serde_json::from_value(json!({"id":"fixture","created_at":now(),"config":{
            "name":"fixture","base_url":"http://127.0.0.1:1/v1","model":"fixture","pack_id":"fixture",
            "profile":"full","temperature":0.0,"max_tokens":32,"concurrency":1,"timeout_s":30
        },"status":"completed","suite_hash":"fixture","protocol_version":"fixture","pack_version":"fixture",
        "provenance":"fixture","items":items,"telemetry":[],"active_ms":1,"error":null})).unwrap()
    }
    fn item(status: &str, score: Value) -> Value {
        json!({"task":{"id":"x","subject":"s","prompt":"p","answer":"a","scorer":"exact","max_tokens":32},
            "status":status,"attempts":[{"started_at":now(),"ended_at":now(),"output":"x","reasoning":"",
            "finish_reason":"stop","error":if status=="error" {Some("request failure")} else {None},
            "metrics":Metrics::default(),"score":score,"raw":[]}]})
    }
    fn scored(value: f64) -> Value {
        json!({"value":value,"state":"scored","detail":"fixture","scorer_version":"fixture"})
    }
    #[test]
    fn concurrency_segments_keep_quality_but_do_not_mix_performance() {
        let mut r = run(vec![
            item("done", scored(1.0)),
            item("done", scored(0.0)),
            item("done", scored(1.0)),
        ]);
        r.config.concurrency = 4;
        r.execution_segments = vec![
            json!({"started_at":"2026-11-07T00:00:00Z","concurrency":1}),
            json!({"started_at":"2026-11-07T01:00:00Z","concurrency":4}),
        ];
        for (n, i) in r.items.iter_mut().enumerate() {
            let a = &mut i.attempts[0];
            a.started_at = if n == 0 {
                "2026-11-07T00:10:00Z"
            } else {
                "2026-11-07T01:10:00Z"
            }
            .into();
            a.ended_at = Some(
                if n == 0 {
                    "2026-11-07T00:10:02Z"
                } else {
                    "2026-11-07T01:10:02Z"
                }
                .into(),
            );
            a.metrics.wall_ms = 2000.;
            a.metrics.decode_source = "server".into();
            a.metrics.decode_tps = Some(if n == 1 { 40. } else { 1000. });
            a.metrics.ttft_ms = Some(500.);
            a.metrics.output_tokens = Some(100);
        }
        r.items[2].task.scorer = "experience".into();
        r.items[2].attempts[0].metrics.request_concurrency = Some(1);
        let summary = r.summary();
        assert_eq!(summary["scored"], 3);
        assert_eq!(summary["decode_tps"]["median"], 40.);
        assert_eq!(summary["decode_tps"]["n"], 1);
        assert_eq!(summary["metric_scope"]["ignored_previous_requests"], 1);
        assert_eq!(summary["metric_scope"]["other_concurrency_requests"], 1);
        assert_eq!(
            summary["current_segment_stats"]["single_request_performance"]["request_count"],
            1
        );
        assert_eq!(r.items[0].attempts[0].metrics.decode_tps, Some(1000.));
        assert_eq!(r.request_concurrency(&r.items[0].attempts[0]), 1);
        assert_eq!(r.request_concurrency(&r.items[1].attempts[0]), 4);
    }
    #[test]
    fn collected_and_grading_failures_do_not_become_wrong_answers() {
        let r = run(vec![
            item("done", scored(1.0)),
            item("done", scored(0.0)),
            item("done", scored(0.5)),
            item(
                "done",
                json!({"value":null,"state":"unavailable","detail":"docker unavailable","scorer_version":"fixture"}),
            ),
            item("grading", Value::Null),
            item("error", Value::Null),
            item("pending", Value::Null),
        ]);
        let s = r.summary();
        assert_eq!(s["collected"], 5);
        assert_eq!(s["scored"], 3);
        assert_eq!(s["correct"], 1);
        assert_eq!(s["incorrect"], 1);
        assert_eq!(s["partial"], 1);
        assert_eq!(s["unscored"], 4);
        assert_eq!(s["grading_pending"], 1);
        assert_eq!(s["score_errors"], 1);
        assert_eq!(s["errors"], 1);
        assert_eq!(s["score_percent"], 50.0);
        assert_eq!(s["grading_status"], "partial");
        assert_eq!(r.items[3].verdict(), "unscored");
        assert_eq!(r.items[4].verdict(), "grading_pending");
        let failed=run(vec![item("done",json!({"value":1.0,"state":"unavailable","detail":"bad state","scorer_version":"fixture"}))]).summary();
        assert!(failed["accuracy_percent"].is_null());
        assert!(failed["score_percent"].is_null());
        assert_eq!(failed["collected"], 1);
        assert_eq!(failed["collection_status"], "completed");
        assert_eq!(failed["grading_status"], "failed");
        assert_eq!(failed["incorrect"], 0);
    }
    #[test]
    fn regrading_preserves_original_failure_and_each_previous_result() {
        let initial: Score = serde_json::from_value(json!({"value":null,"state":"unavailable","detail":"original exit 1","scorer_version":"old","extra":{"evidence":"saved"}})).unwrap();
        let first: Score = serde_json::from_value(scored(1.0)).unwrap();
        let first = first.with_previous(Some(&initial));
        let second: Score = serde_json::from_value(scored(0.0)).unwrap();
        let second = second.with_previous(Some(&first));
        assert_eq!(second.extra["grading_history"].as_array().unwrap().len(), 2);
        assert_eq!(
            second.extra["grading_history"][0]["score"]["detail"],
            "original exit 1"
        );
        assert_eq!(
            second.extra["grading_history"][0]["score"]["extra"]["evidence"],
            "saved"
        );
        assert_eq!(second.extra["grading_history"][1]["score"]["value"], 1.0);
        assert_eq!(second.extra["previous_score"]["value"], 1.0);
        assert!(second.extra["grading_history"][1]["score"]["extra"]["grading_history"].is_null());
    }
    #[test]
    fn experience_measurements_do_not_become_intelligence_errors_and_warmup_is_excluded() {
        let mut good = item(
            "done",
            json!({"state":"measured","value":null,"detail":"valid","scorer_version":"api-experience-v1","extra":{"valid_output":true}}),
        );
        good["task"]["scorer"] = "experience".into();
        good["task"]["meta"] = json!({"performance_protocol":"api-experience-v1","experience_case":"english","prompt_sha256":"hash","warmup":false,"private":"must not appear"});
        good["attempts"][0]["metrics"] = json!({"measurement_version":"client-visible-v1","ttft_ms":200,"wall_ms":2000,"client_visible_decode_tps":50,"decode_tps":500,"decode_source":"server","prefill_source":"unavailable","visible_output_tokens":100});
        let mut warmup = good.clone();
        warmup["task"]["meta"]["warmup"] = true.into();
        warmup["attempts"][0]["metrics"]["ttft_ms"] = 99999.into();
        let mut invalid = good.clone();
        invalid["attempts"][0]["score"]["extra"]["valid_output"] = false.into();
        let r = run(vec![item("done", scored(1.)), good, warmup, invalid]);
        let s = r.summary();
        assert_eq!(s["quality_total"], 1);
        assert_eq!(s["performance_total"], 2);
        assert_eq!(s["warmup_total"], 1);
        assert_eq!(s["scored"], 1);
        assert_eq!(s["correct"], 1);
        assert_eq!(s["score_errors"], 0);
        assert_eq!(s["measured"], 2);
        assert_eq!(s["measurement_errors"], 1);
        assert_eq!(s["unscored"], 0);
        assert_eq!(s["grading_pending"], 0);
        assert_eq!(s["ttft_ms"]["median"], 200.);
        assert_eq!(s["client_visible_decode_tps"]["n"], 2);
        assert_eq!(r.items[1].verdict(), "measured");
        assert_eq!(r.items[3].verdict(), "measurement_invalid");
        let c = r.compact();
        assert_eq!(c["items"][1]["task"]["meta"]["prompt_sha256"], "hash");
        assert!(c["items"][1]["task"]["meta"].get("private").is_none());
        assert_eq!(
            c["items"][1]["attempts"][0]["score"]["extra"]["valid_output"],
            true
        );
    }
}
