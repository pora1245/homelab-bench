use crate::types::{Attempt, Config, Metrics, Task, now};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub struct Progress {
    pub output: String,
    pub reasoning: String,
    pub metrics: Metrics,
}

fn reasoning_model(model: &str) -> bool {
    ["gpt-5", "gpt-6", "o1", "o3", "o4"]
        .iter()
        .any(|p| model.starts_with(p))
}
pub fn payload(c: &Config, t: &Task) -> Value {
    if c.api_format == "responses" {
        let mut v = json!({"model":c.model,"input":[{"role":"user","content":t.prompt}],
            "stream":true,"store":false,"max_output_tokens":t.max_tokens.min(c.max_tokens)});
        let effort = c.reasoning_parameters["reasoning_effort"]
            .as_str()
            .unwrap_or(&c.reasoning_effort);
        if !effort.is_empty() {
            v["reasoning"] = json!({"effort":effort});
        }
        // Reasoning API deployments commonly reject temperature. The actual
        // transmitted body is preserved, so an omitted setting is never hidden.
        if effort.is_empty() && !reasoning_model(&c.model) {
            v["temperature"] = json!(c.temperature);
        }
        return v;
    }
    let mut v = json!({"model":c.model,"messages":[{"role":"user","content":t.prompt}],"stream":true,
        "stream_options":{"include_usage":true},"temperature":c.temperature,"max_tokens":t.max_tokens.min(c.max_tokens)});
    if !c.reasoning_effort.is_empty() {
        v["reasoning_effort"] = c.reasoning_effort.clone().into()
    }
    // Server-advertised capability parameters, never arbitrary request overrides.
    if c.reasoning_parameters.is_object() {
        v.as_object_mut().unwrap().remove("reasoning_effort");
        if let Some(x) = c
            .reasoning_parameters
            .get("reasoning_effort")
            .filter(|x| x.is_string())
        {
            v["reasoning_effort"] = x.clone();
        }
        let k = &c.reasoning_parameters["chat_template_kwargs"];
        for key in ["enable_thinking", "reasoning_effort"] {
            if let Some(x) = k.get(key).filter(|x| {
                if key == "enable_thinking" {
                    x.is_boolean()
                } else {
                    x.is_string()
                }
            }) {
                if !v["chat_template_kwargs"].is_object() {
                    v["chat_template_kwargs"] = json!({});
                }
                v["chat_template_kwargs"][key] = x.clone();
            }
        }
    }
    v
}
pub fn endpoint(base: &str) -> anyhow::Result<String> {
    endpoint_for(base, "chat_completions")
}
pub fn endpoint_for(base: &str, api_format: &str) -> anyhow::Result<String> {
    anyhow::ensure!(
        ["chat_completions", "responses"].contains(&api_format),
        "지원하지 않는 API 형식입니다"
    );
    let u = reqwest::Url::parse(base)?;
    anyhow::ensure!(
        ["http", "https"].contains(&u.scheme())
            && u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none(),
        "API 주소 형식을 확인하세요"
    );
    let b = base.trim_end_matches('/');
    let b = b
        .strip_suffix("/chat/completions")
        .or_else(|| b.strip_suffix("/responses"))
        .unwrap_or(b);
    let suffix = if api_format == "responses" {
        "responses"
    } else {
        "chat/completions"
    };
    Ok(if b.ends_with("/v1") {
        format!("{b}/{suffix}")
    } else {
        format!("{b}/v1/{suffix}")
    })
}
fn text_content(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.into();
    }
    v.as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    if let Some(s) = part.as_str() {
                        return Some(s);
                    }
                    match part["type"].as_str() {
                        Some(
                            "text" | "output_text" | "reasoning_text" | "reasoning.text"
                            | "summary_text",
                        ) => part["text"]
                            .as_str()
                            .or_else(|| part["text"]["value"].as_str()),
                        _ => None,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Default)]
struct Acc {
    output: String,
    reasoning: String,
    raw: Vec<Value>,
    usage: Value,
    timings: Value,
    finish: Option<String>,
    first: Option<f64>,
    last: Option<f64>,
    first_reasoning: Option<f64>,
    visible_chunks: usize,
    expects_reasoning_tokens: bool,
    done: bool,
}
impl Acc {
    fn append(&mut self, text: &str, reason: &str, elapsed: f64) {
        if !text.is_empty() {
            self.first.get_or_insert(elapsed);
            self.last = Some(elapsed);
            self.visible_chunks += 1;
            self.output.push_str(text);
        }
        if !reason.is_empty() {
            self.first_reasoning.get_or_insert(elapsed);
            self.reasoning.push_str(reason);
        }
    }
    fn accept(&mut self, mut v: Value, elapsed: f64) -> anyhow::Result<()> {
        // Preserve all responses, including terminal errors, with receive time.
        if let Some(o) = v.as_object_mut() {
            o.insert("_bench_elapsed_ms".into(), json!(elapsed));
        }
        self.raw.push(v.clone());
        if v.get("error").is_some_and(|error| !error.is_null()) || v["type"] == "error" {
            anyhow::bail!("API 오류 응답")
        }
        if let Some(event) = v["type"].as_str().filter(|s| s.starts_with("response.")) {
            match event {
                "response.output_text.delta" | "response.refusal.delta" => {
                    self.append(v["delta"].as_str().unwrap_or_default(), "", elapsed)
                }
                "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" => {
                    self.append("", v["delta"].as_str().unwrap_or_default(), elapsed)
                }
                "response.completed" | "response.incomplete" | "response.failed" => {
                    self.accept_response(&v["response"], false)?
                }
                _ => {}
            }
        } else if v["object"] == "response" {
            self.accept_response(&v, true)?;
        } else {
            let c = &v["choices"][0];
            let d = if c.get("delta").is_some() {
                &c["delta"]
            } else {
                &c["message"]
            };
            let text = text_content(&d["content"]);
            let reason = ["reasoning_content", "reasoning", "reasoning_details"]
                .into_iter()
                .map(|key| text_content(&d[key]))
                .find(|s| !s.is_empty())
                .unwrap_or_default();
            self.append(&text, &reason, elapsed);
            if let Some(f) = c["finish_reason"].as_str() {
                self.finish = Some(f.into());
            }
            if v["usage"].is_object() {
                self.usage = v["usage"].clone();
            }
            if v["timings"].is_object() {
                self.timings = v["timings"].clone();
            }
        }
        anyhow::ensure!(
            self.output.len() + self.reasoning.len() < 8_000_000,
            "출력 크기 제한 초과"
        );
        Ok(())
    }
    fn accept_response(&mut self, r: &Value, non_stream: bool) -> anyhow::Result<()> {
        if r["usage"].is_object() {
            self.usage = r["usage"].clone();
        }
        // Terminal output must never be counted as a newly streamed delta.
        if non_stream || self.output.is_empty() {
            if let Some(items) = r["output"].as_array() {
                self.output = items
                    .iter()
                    .filter(|i| i["type"] == "message")
                    .flat_map(|i| i["content"].as_array().into_iter().flatten())
                    .filter_map(|p| p["text"].as_str().or_else(|| p["refusal"].as_str()))
                    .collect();
            }
        }
        match r["status"].as_str() {
            Some("completed") => {
                self.finish = Some("stop".into());
                self.done = true;
            }
            Some("incomplete") if r["incomplete_details"]["reason"] == "max_output_tokens" => {
                self.finish = Some("length".into());
                self.done = true;
            }
            Some("incomplete") => {
                self.finish = Some("incomplete".into());
                self.done = true;
                anyhow::bail!("Responses 응답이 미완료 상태로 종료되었습니다");
            }
            Some("failed") => {
                self.finish = Some("failed".into());
                self.done = true;
                anyhow::bail!("Responses API 응답 실패");
            }
            _ => anyhow::bail!("Responses 완료 상태가 없습니다"),
        }
        Ok(())
    }
    fn frame(&mut self, frame: &[u8], elapsed: f64) -> anyhow::Result<()> {
        let text = std::str::from_utf8(frame)?.trim_start_matches('\u{feff}');
        let data = text
            .lines()
            .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.trim() == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        if data.trim().is_empty() {
            return Ok(());
        }
        self.accept(serde_json::from_str(&data)?, elapsed)
    }

    fn metrics(
        &self,
        elapsed: f64,
        stream: Option<bool>,
        failed: bool,
        in_flight: bool,
    ) -> Metrics {
        let output_tokens = self.usage["completion_tokens"]
            .as_u64()
            .or_else(|| self.usage["output_tokens"].as_u64());
        let reported_reasoning = self.usage["completion_tokens_details"]["reasoning_tokens"]
            .as_u64()
            .or_else(|| self.usage["output_tokens_details"]["reasoning_tokens"].as_u64());
        let reasoning_tokens = reported_reasoning
            .or_else(|| (!self.expects_reasoning_tokens && self.reasoning.is_empty()).then_some(0));
        let visible_output_tokens = output_tokens
            .zip(reasoning_tokens)
            .and_then(|(n, r)| n.checked_sub(r));
        let native_decode = self.timings["predicted_per_second"]
            .as_f64()
            .filter(|x| x.is_finite() && *x > 0.0);
        let approx = self
            .first
            .zip(self.last)
            .filter(|(f, l)| stream == Some(true) && self.visible_chunks > 1 && l - f > 1.0)
            .zip(visible_output_tokens)
            .map(|((f, l), n)| n as f64 * 1000.0 / (l - f));
        let prefill = self.timings["prompt_per_second"]
            .as_f64()
            .filter(|x| x.is_finite() && *x > 0.0);
        let ttft = if stream == Some(true) {
            self.first
        } else {
            None
        };
        Metrics {
            measurement_version: "client-visible-v1".into(),
            reasoning_ttft_ms: if stream == Some(true) {
                self.first_reasoning
            } else {
                None
            },
            visible_output_tokens,
            reasoning_tokens,
            client_visible_decode_tps: approx,
            client_visible_decode_source: if approx.is_some() {
                "client_visible_estimate"
            } else {
                "unavailable"
            }
            .into(),
            ttft_ms: ttft,
            ttft_source: if ttft.is_some() {
                "client_visible_stream"
            } else {
                "unavailable"
            }
            .into(),
            ttft_reason: if ttft.is_some() {
                ""
            } else if stream == Some(false) {
                "non_streaming_response"
            } else if failed {
                "interrupted_before_first_token"
            } else if in_flight {
                "waiting_for_first_token"
            } else {
                "no_generated_content"
            }
            .into(),
            wall_ms: elapsed,
            input_tokens: self.usage["prompt_tokens"]
                .as_u64()
                .or_else(|| self.usage["input_tokens"].as_u64()),
            output_tokens,
            decode_tps: native_decode.or(approx),
            prefill_tps: prefill,
            decode_source: if native_decode.is_some() {
                "server"
            } else if approx.is_some() {
                "client_estimate"
            } else {
                "unavailable"
            }
            .into(),
            prefill_source: if prefill.is_some() {
                "server"
            } else {
                "unavailable"
            }
            .into(),
        }
    }

    fn progress(&self, elapsed: f64) -> Progress {
        Progress {
            output: self.output.clone(),
            reasoning: self.reasoning.clone(),
            metrics: self.metrics(elapsed, Some(true), false, true),
        }
    }
}

// Gateways occasionally omit/mislabel Content-Type. Detect framing from the body
// without mistaking a full JSON response for a streamed first token.
fn framing(buffer: &[u8]) -> anyhow::Result<Option<bool>> {
    let b = buffer.strip_prefix(b"\xef\xbb\xbf").unwrap_or(buffer);
    let b = b
        .iter()
        .position(|x| !x.is_ascii_whitespace())
        .map(|i| &b[i..])
        .unwrap_or_default();
    if b.is_empty() {
        return Ok(None);
    }
    if matches!(b[0], b'{' | b'[') {
        return Ok(Some(false));
    }
    for prefix in [b"data:".as_slice(), b"event:", b"id:", b"retry:", b":"] {
        if b.starts_with(prefix) {
            return Ok(Some(true));
        }
        if prefix.starts_with(b) {
            return Ok(None);
        }
    }
    if b"\xef\xbb\xbf".starts_with(b) {
        return Ok(None);
    }
    anyhow::bail!("응답이 JSON 또는 SSE 형식이 아닙니다")
}

pub async fn generate(
    c: &Config,
    t: &Task,
    key: &str,
    progress: mpsc::Sender<Progress>,
) -> Attempt {
    let start = Instant::now();
    let mut a = Acc {
        expects_reasoning_tokens: reasoning_model(&c.model)
            || (!c.reasoning_effort.is_empty()
                && !["none", "off"].contains(&c.reasoning_effort.as_str())),
        ..Acc::default()
    };
    let started_at = now();
    let mut mode = None;
    let result = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        let url = endpoint_for(&c.base_url, &c.api_format)?;
        let body = payload(c, t);
        a.raw
            .push(json!({"kind":"request","api_format":c.api_format,"body":body}));
        let mut request = client.post(url).json(&body);
        if !key.is_empty() {
            request = request.bearer_auth(key)
        }
        let response = request.send().await?;
        anyhow::ensure!(
            response.status().is_success(),
            "API HTTP {}",
            response.status()
        );
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        let mut published = Instant::now();
        let mut first_published = false;
        while let Some(bytes) = stream.next().await {
            buffer.extend_from_slice(&bytes?);
            anyhow::ensure!(buffer.len() < 8_000_000, "SSE 프레임 크기 제한 초과");
            if mode.is_none() {
                mode = framing(&buffer)?;
            }
            if mode != Some(true) {
                continue;
            }
            while let Some((pos, len)) = boundary(&buffer) {
                let frame: Vec<_> = buffer.drain(..pos + len).collect();
                a.frame(&frame[..pos], start.elapsed().as_secs_f64() * 1000.0)?;
                // The first content event must be visible even when a response
                // finishes in a single chunk or less than the repaint interval.
                if a.first.is_some() && !first_published {
                    first_published = progress
                        .try_send(a.progress(start.elapsed().as_secs_f64() * 1000.0))
                        .is_ok();
                    published = Instant::now();
                }
                if a.done {
                    break;
                }
            }
            if published.elapsed() >= Duration::from_millis(100) {
                // UI backpressure must not become part of the measured decoding time.
                let _ = progress.try_send(a.progress(start.elapsed().as_secs_f64() * 1000.0));
                published = Instant::now()
            }
            if a.done {
                break;
            }
        }
        if mode == Some(true) {
            if !a.done && !buffer.iter().all(u8::is_ascii_whitespace) {
                a.frame(&buffer, start.elapsed().as_secs_f64() * 1000.0)?
            }
            anyhow::ensure!(
                a.done || a.finish.is_some(),
                "스트림이 완료 신호 전에 끊겼습니다"
            );
        } else {
            anyhow::ensure!(mode == Some(false), "비어 있거나 알 수 없는 API 응답입니다");
            a.accept(
                serde_json::from_slice(&buffer)?,
                start.elapsed().as_secs_f64() * 1000.0,
            )?;
            a.first = None;
            a.last = None;
            anyhow::ensure!(a.finish.is_some(), "API 응답에 완료 신호가 없습니다");
        }
        Ok::<(), anyhow::Error>(())
    };
    let error = match tokio::time::timeout(Duration::from_secs(c.timeout_s), result).await {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e.to_string()),
        Err(_) => Some("응답 시간 초과".into()),
    };
    let metrics = a.metrics(
        start.elapsed().as_secs_f64() * 1000.0,
        mode,
        error.is_some(),
        false,
    );
    Attempt {
        started_at,
        ended_at: Some(now()),
        output: a.output,
        reasoning: a.reasoning,
        finish_reason: a.finish,
        error,
        metrics,
        score: None,
        raw: a.raw,
    }
}
fn boundary(b: &[u8]) -> Option<(usize, usize)> {
    for i in 0..b.len() {
        if b.get(i..i + 2) == Some(b"\n\n") {
            return Some((i, 2));
        }
        if b.get(i..i + 2) == Some(b"\r\r") {
            return Some((i, 2));
        }
        if b.get(i..i + 4) == Some(b"\r\n\r\n") {
            return Some((i, 4));
        }
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, response::Response, routing::post};

    #[test]
    fn capability_parameters_cannot_override_benchmark_request() {
        let mut c = config("http://127.0.0.1:1".into());
        c.max_tokens = 32;
        c.reasoning_parameters = json!({"reasoning_effort":"high","chat_template_kwargs":{
            "enable_thinking":true,"reasoning_effort":"medium","template":"untrusted"},
            "model":"wrong-model","messages":[{"role":"system","content":"leak answer"}],
            "temperature":2,"max_tokens":1,"stream":false,"api_key":"SECRET"});
        let t = task();
        let body = payload(&c, &t);
        assert_eq!(body["model"], c.model);
        assert_eq!(
            body["messages"],
            json!([{"role":"user","content":t.prompt}])
        );
        assert_eq!(body["temperature"], 0.0);
        assert_eq!(body["max_tokens"], 32);
        assert_eq!(body["stream"], true);
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(
            body["chat_template_kwargs"],
            json!({"enable_thinking":true,"reasoning_effort":"medium"})
        );
        assert!(body.get("api_key").is_none());
        assert!(!body.to_string().contains("SECRET"));
    }

    #[test]
    fn advertised_thinking_disable_replaces_legacy_effort_and_rejects_wrong_types() {
        let mut c = config("http://127.0.0.1:1".into());
        c.reasoning_effort = "high".into();
        assert_eq!(payload(&c, &task())["reasoning_effort"], "high");
        c.reasoning_parameters = json!({"chat_template_kwargs":{"enable_thinking":false}});
        let disabled = payload(&c, &task());
        assert!(disabled.get("reasoning_effort").is_none());
        assert_eq!(disabled["chat_template_kwargs"]["enable_thinking"], false);
        c.reasoning_parameters = json!({"reasoning_effort":42,"chat_template_kwargs":{"enable_thinking":"false","reasoning_effort":true}});
        let invalid = payload(&c, &task());
        assert!(invalid.get("reasoning_effort").is_none());
        assert!(invalid.get("chat_template_kwargs").is_none());
        c.reasoning_parameters = json!({});
        assert!(payload(&c, &task()).get("reasoning_effort").is_none());
    }

    #[test]
    fn role_and_reasoning_do_not_start_visible_ttft() {
        let mut a = Acc::default();
        a.accept(
            json!({"choices":[{"delta":{"role":"assistant","content":""}}]}),
            10.0,
        )
        .unwrap();
        a.accept(json!({"choices":[],"usage":{"prompt_tokens":20}}), 20.0)
            .unwrap();
        assert!(a.first.is_none());
        a.accept(
            json!({"choices":[{"delta":{"reasoning":[{"type":"reasoning_text","text":"Think"}]}}]}),
            40.0,
        )
        .unwrap();
        a.accept(
            json!({"choices":[{"delta":{"content":[{"type":"text","text":"OK"}]}}]}),
            90.0,
        )
        .unwrap();
        assert_eq!(a.first, Some(90.0));
        assert_eq!(a.first_reasoning, Some(40.0));
        assert_eq!(a.last, Some(90.0));
        assert_eq!(a.reasoning, "Think");
        assert_eq!(a.output, "OK");
        assert_eq!(
            a.metrics(100.0, Some(true), false, false).ttft_source,
            "client_visible_stream"
        );
    }

    #[test]
    fn framing_and_absence_reasons_are_explicit() {
        assert_eq!(framing(b"da").unwrap(), None);
        assert_eq!(framing(b"data: {").unwrap(), Some(true));
        assert_eq!(framing(b"event: message\n").unwrap(), Some(true));
        assert_eq!(framing(b"\n {\"choices\":[]}").unwrap(), Some(false));
        assert!(framing(b"<html>bad gateway</html>").is_err());
        let a = Acc::default();
        assert_eq!(
            a.metrics(100.0, Some(false), false, false).ttft_reason,
            "non_streaming_response"
        );
        assert_eq!(
            a.metrics(100.0, Some(true), false, false).ttft_reason,
            "no_generated_content"
        );
        assert_eq!(
            a.metrics(100.0, None, true, false).ttft_reason,
            "interrupted_before_first_token"
        );
    }

    async fn fixture(
        chunks: Vec<(u64, Vec<u8>)>,
        mime: &'static str,
    ) -> (String, tokio::task::JoinHandle<()>) {
        fixture_path(chunks, mime, "/v1/chat/completions").await
    }
    async fn fixture_path(
        chunks: Vec<(u64, Vec<u8>)>,
        mime: &'static str,
        path: &'static str,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().route(
            path,
            post(move || {
                let chunks = chunks.clone();
                async move {
                    let stream = async_stream::stream! {
                        for (delay, chunk) in chunks {
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                            yield Ok::<_, std::io::Error>(chunk);
                        }
                    };
                    Response::builder()
                        .header("content-type", mime)
                        .body(Body::from_stream(stream))
                        .unwrap()
                }
            }),
        );
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (base, handle)
    }

    fn config(base: String) -> Config {
        serde_json::from_value(json!({"name":"Fixture","base_url":base,"model":"fixture",
            "pack_id":"fixture","profile":"full","temperature":0,"max_tokens":128,
            "concurrency":1,"timeout_s":5}))
        .unwrap()
    }
    fn task() -> Task {
        Task {
            id: "fixture".into(),
            subject: "fixture".into(),
            prompt: "Reply OK".into(),
            answer: json!("OK"),
            scorer: "exact".into(),
            max_tokens: 128,
            meta: Value::Null,
        }
    }

    #[tokio::test]
    async fn measured_ttft_published_before_completion_with_plain_text_sse() {
        let (base, server) = fixture(vec![
            (10, b"data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n".to_vec()),
            (40, b"data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\n".to_vec()),
            (300, b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n".to_vec())
        ], "text/plain").await;
        let (tx, mut rx) = mpsc::channel(4);
        let work = tokio::spawn(async move { generate(&config(base), &task(), "", tx).await });
        let progress = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            !work.is_finished(),
            "TTFT must be published before delayed completion"
        );
        assert_eq!(progress.output, "OK");
        let ttft = progress.metrics.ttft_ms.unwrap();
        assert!(ttft >= 40.0 && ttft < 2000.0);
        let attempt = work.await.unwrap();
        assert!(attempt.error.is_none(), "{:?}", attempt.error);
        assert_eq!(attempt.metrics.ttft_ms, Some(ttft));
        assert_eq!(attempt.metrics.ttft_source, "client_visible_stream");
        assert!(
            attempt.metrics.decode_tps.is_none(),
            "One content chunk cannot estimate decoding speed"
        );
        server.abort();
    }

    #[tokio::test]
    async fn json_fallback_never_mislabels_wall_time_as_ttft() {
        let body = serde_json::to_vec(
            &json!({"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":8,"completion_tokens":1}}),
        )
        .unwrap();
        let (base, server) = fixture(vec![(30, body)], "text/event-stream").await;
        let (tx, _rx) = mpsc::channel(4);
        let attempt = generate(&config(base), &task(), "", tx).await;
        assert!(attempt.error.is_none(), "{:?}", attempt.error);
        assert_eq!(attempt.output, "OK");
        assert!(attempt.metrics.ttft_ms.is_none());
        assert_eq!(attempt.metrics.ttft_reason, "non_streaming_response");
        server.abort();
    }

    #[tokio::test]
    async fn single_chunk_completion_keeps_ttft() {
        let (base, server) = fixture(vec![(1,
            b"data: {\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_vec())],
            "text/event-stream").await;
        let (tx, mut rx) = mpsc::channel(4);
        let attempt = generate(&config(base), &task(), "", tx).await;
        assert!(attempt.error.is_none(), "{:?}", attempt.error);
        assert_eq!(attempt.output, "OK");
        assert!(attempt.metrics.ttft_ms.is_some());
        let progress = rx.try_recv().unwrap();
        assert_eq!(progress.metrics.ttft_ms, attempt.metrics.ttft_ms);
        server.abort();
    }

    #[tokio::test]
    async fn truncated_stream_preserves_observed_ttft_and_error() {
        let (base, server) = fixture(
            vec![(
                30,
                b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".to_vec(),
            )],
            "application/octet-stream",
        )
        .await;
        let (tx, _rx) = mpsc::channel(4);
        let attempt = generate(&config(base), &task(), "", tx).await;
        assert!(attempt.error.is_some());
        assert_eq!(attempt.output, "partial");
        assert!(attempt.metrics.ttft_ms.is_some());
        server.abort();
    }
    #[test]
    fn sse_multiline_and_usage() {
        let mut a = Acc::default();
        a.frame(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}",
            10.0,
        )
        .unwrap();
        a.frame(
            b"data: {\"choices\":[],\"usage\":{\"completion_tokens\":2}}",
            20.0,
        )
        .unwrap();
        a.frame(b"data: [DONE]", 30.0).unwrap();
        assert_eq!(a.output, "hello");
        assert!(a.done);
        assert_eq!(a.first, Some(10.0));
        assert_eq!(boundary(b"data: x\r\n\r\n"), Some((7, 4)));
    }
    #[test]
    fn responses_payload_and_endpoint_preserve_only_supported_settings() {
        let mut c = config("https://example.test/v1".into());
        assert_eq!(c.api_format, "chat_completions");
        c.api_format = "responses".into();
        c.model = "gpt-6.1-sol".into();
        c.reasoning_effort = "low".into();
        c.max_tokens = 4096;
        let mut t = task();
        t.max_tokens = 8192;
        t.answer = json!("SECRET REFERENCE");
        c.reasoning_parameters = json!({"input":"SECRET","store":true,"max_output_tokens":1});
        let p = payload(&c, &t);
        assert_eq!(p["input"], json!([{"role":"user","content":"Reply OK"}]));
        assert_eq!(p["max_output_tokens"], 4096);
        assert_eq!(p["reasoning"]["effort"], "low");
        assert_eq!(p["store"], false);
        assert_eq!(p["stream"], true);
        assert!(p.get("temperature").is_none());
        assert!(!p.to_string().contains("SECRET"));
        for base in [
            "https://example.test",
            "https://example.test/v1",
            "https://example.test/v1/responses",
            "https://example.test/v1/chat/completions",
        ] {
            assert_eq!(
                endpoint_for(base, "responses").unwrap(),
                "https://example.test/v1/responses"
            );
        }
        assert!(endpoint_for("https://x.test/v1?key=secret", "responses").is_err());
        assert!(endpoint_for("https://x.test", "unknown").is_err());
    }

    #[test]
    fn visible_metrics_exclude_reasoning_tokens_and_keep_server_metrics_separate() {
        let mut a = Acc::default();
        a.accept(
            json!({"choices":[{"delta":{"reasoning_content":"think"}}]}),
            100.,
        )
        .unwrap();
        assert!(a.metrics(200., Some(true), false, true).ttft_ms.is_none());
        a.accept(json!({"choices":[{"delta":{"content":"Hello"}}]}), 500.)
            .unwrap();
        a.accept(json!({"choices":[{"delta":{"content":" world"}}]}), 1500.)
            .unwrap();
        a.accept(json!({"choices":[], "usage":{"completion_tokens":100,"completion_tokens_details":{"reasoning_tokens":80}},
            "timings":{"predicted_per_second":999,"prompt_per_second":123}}), 2000.).unwrap();
        let m = a.metrics(2000., Some(true), false, false);
        assert_eq!(m.ttft_ms, Some(500.));
        assert_eq!(m.reasoning_ttft_ms, Some(100.));
        assert_eq!(m.visible_output_tokens, Some(20));
        assert_eq!(m.client_visible_decode_tps, Some(20.));
        assert_eq!(m.decode_tps, Some(999.));
        assert_eq!(m.prefill_tps, Some(123.));
        assert_eq!(m.ttft_source, "client_visible_stream");
        a.usage = json!({"completion_tokens":100});
        assert!(
            a.metrics(2000., Some(true), false, false)
                .client_visible_decode_tps
                .is_none()
        );
        a.usage = json!({"completion_tokens":2,"completion_tokens_details":{"reasoning_tokens":3}});
        assert!(
            a.metrics(2000., Some(true), false, false)
                .visible_output_tokens
                .is_none()
        );
    }

    #[test]
    fn responses_events_do_not_duplicate_terminal_text_or_extend_decode_window() {
        let mut a = Acc::default();
        a.accept(
            json!({"type":"response.created","response":{"status":"in_progress"}}),
            20.,
        )
        .unwrap();
        a.accept(
            json!({"type":"response.reasoning_summary_text.delta","delta":"Thinking"}),
            50.,
        )
        .unwrap();
        a.accept(
            json!({"type":"response.output_text.delta","delta":"Hello"}),
            100.,
        )
        .unwrap();
        a.accept(
            json!({"type":"response.output_text.delta","delta":" world"}),
            1100.,
        )
        .unwrap();
        a.accept(
            json!({"type":"response.output_text.done","text":"Hello world"}),
            1200.,
        )
        .unwrap();
        a.accept(json!({"type":"response.completed","response":{"status":"completed","usage":{
            "input_tokens":30,"output_tokens":120,"output_tokens_details":{"reasoning_tokens":100}},
            "output":[{"type":"message","content":[{"type":"output_text","text":"Hello world"}]}]}}), 3000.).unwrap();
        assert_eq!(a.output, "Hello world");
        assert_eq!(a.first, Some(100.));
        assert_eq!(a.last, Some(1100.));
        assert_eq!(a.finish.as_deref(), Some("stop"));
        assert!(a.done);
        assert_eq!(
            a.metrics(3000., Some(true), false, false)
                .client_visible_decode_tps,
            Some(20.)
        );
    }

    #[test]
    fn responses_incomplete_and_failed_preserve_diagnostics() {
        let mut a = Acc::default();
        a.accept(json!({"type":"response.incomplete","response":{"status":"incomplete", "incomplete_details":{"reason":"max_output_tokens"},"usage":{"output_tokens":4096}}}), 100.).unwrap();
        assert_eq!(a.finish.as_deref(), Some("length"));
        assert!(a.done);
        assert_eq!(a.usage["output_tokens"], 4096);
        let mut failed = Acc::default();
        assert!(failed.accept(json!({"type":"response.failed","response":{"status":"failed","error":{"code":"server_error"}}}), 100.).is_err());
        assert_eq!(failed.raw.len(), 1);
        assert_eq!(failed.finish.as_deref(), Some("failed"));
        assert!(
            failed
                .metrics(100., Some(true), true, false)
                .client_visible_decode_tps
                .is_none()
        );
    }

    #[tokio::test]
    async fn responses_stream_uses_responses_route_and_retains_actual_request() {
        let chunks=vec![
            (5,b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\"}}\n\n".to_vec()),
            (20,b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\n".to_vec()),
            (40,b"data: {\"type\":\"response.output_text.delta\",\"delta\":\" world\"}\n\n".to_vec()),
            (10,b"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":10,\"output_tokens_details\":{\"reasoning_tokens\":8}}}}\n\n".to_vec())];
        let (base, server) = fixture_path(chunks, "text/event-stream", "/v1/responses").await;
        let mut c = config(base);
        c.api_format = "responses".into();
        c.reasoning_effort = "low".into();
        let (tx, _rx) = mpsc::channel(4);
        let a = generate(&c, &task(), "REDACTED-TEST-KEY", tx).await;
        assert!(a.error.is_none(), "{:?}", a.error);
        assert_eq!(a.output, "Hello world");
        assert_eq!(a.metrics.visible_output_tokens, Some(2));
        assert!(a.metrics.client_visible_decode_tps.unwrap() > 0.);
        assert_eq!(a.raw[0]["kind"], "request");
        assert_eq!(a.raw[0]["body"]["reasoning"]["effort"], "low");
        assert!(
            !serde_json::to_string(&a.raw)
                .unwrap()
                .contains("REDACTED-TEST-KEY")
        );
        server.abort();
    }

    #[tokio::test]
    async fn responses_json_fallback_has_output_but_no_client_timing() {
        let body = serde_json::to_vec(&json!({"object":"response","status":"completed",
            "output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}],
            "usage":{"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0}}}))
        .unwrap();
        let (base, server) =
            fixture_path(vec![(5, body)], "application/json", "/v1/responses").await;
        let mut c = config(base);
        c.api_format = "responses".into();
        let (tx, _rx) = mpsc::channel(4);
        let a = generate(&c, &task(), "", tx).await;
        assert!(a.error.is_none());
        assert_eq!(a.output, "OK");
        assert!(a.metrics.ttft_ms.is_none());
        assert!(a.metrics.client_visible_decode_tps.is_none());
        server.abort();
    }
}
