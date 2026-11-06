//! A short real streaming probe, separate from scored runs and their datasets.
use crate::{ApiResult, App, bad, metrics_quality, provider, settings, types::*};
use axum::{Json, extract::State};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub struct Ticket {
    created: Instant,
    fingerprint: String,
    status: String,
}
const TTL: Duration = Duration::from_secs(30 * 60);
fn fingerprint(b: &Start) -> String {
    let c = &b.config;
    digest(
        &json!({"base_url":c.base_url,"model":c.model,"api_format":c.api_format,
        "temperature":c.temperature,"max_tokens":c.max_tokens,"timeout_s":c.timeout_s,
        "concurrency":c.concurrency,"auto_concurrency":c.auto_concurrency,"reasoning_effort":c.reasoning_effort,
        "reasoning_parameters":c.reasoning_parameters,"execution_info":c.execution_info,
        "device":c.device,"telemetry_url":c.telemetry_url,"key_digest":digest(&b.api_key)}),
    )
}
pub async fn validate(s: &App, b: &Start) -> anyhow::Result<()> {
    let mut tickets = s.preflights.lock().await;
    tickets.retain(|_, t| t.created.elapsed() < TTL);
    let t = tickets.get(&b.preflight_token).ok_or_else(|| {
        anyhow::anyhow!("계측 사전검증을 실행하세요. 검증 결과는 30분 동안 유효합니다.")
    })?;
    validate_ticket(t, b)
}
fn validate_ticket(t: &Ticket, b: &Start) -> anyhow::Result<()> {
    anyhow::ensure!(
        t.created.elapsed() < TTL,
        "계측 사전검증이 만료됐습니다. 다시 실행하세요."
    );
    anyhow::ensure!(
        t.fingerprint == fingerprint(b),
        "실행 설정이 바뀌었습니다. 계측 사전검증을 다시 실행하세요."
    );
    anyhow::ensure!(
        t.status != "failed",
        "API 응답 검증에 실패했습니다. 연결을 확인하세요."
    );
    anyhow::ensure!(
        t.status == "ready" || b.allow_limited_metrics,
        "일부 지표를 수집할 수 없습니다. 제한 사항을 확인한 뒤 진행을 선택하세요."
    );
    Ok(())
}
fn check_row(id: &str, status: &str, detail: impl Into<String>, required: bool) -> Value {
    json!({"id":id,"status":status,"detail":detail.into(),"required":required})
}
fn metric_check(m: &Metrics, quality: &Value, key: &str, label: &str) -> Value {
    let value = serde_json::to_value(m).unwrap()[key].clone();
    if quality["valid"][key] == true {
        let mut row = check_row(key, "ok", label, true);
        row["value"] = value;
        return row;
    }
    if let Some(reason) = quality["excluded"][key].as_str() {
        let mut row = check_row(key, "error", format!("측정값 검증 실패: {reason}"), true);
        row["reason"] = reason.into();
        return row;
    }
    check_row(
        key,
        "unsupported",
        if key == "prefill_tps" {
            "이번 응답에 서버 Prefill 계측값이 없습니다. TTFT로 대체하지 않습니다."
        } else {
            "이번 응답에서 측정 근거를 확보하지 못했습니다."
        },
        true,
    )
}
fn finish_check(reason: Option<&str>, visible_output: &str) -> Value {
    let (status, detail) = match reason {
        Some("length") => (
            "unsupported",
            "검증 요청이 출력 한도에 도달했습니다. 본 시험의 출력 한도를 확인하세요.",
        ),
        Some("stop" | "end_turn") if !visible_output.trim().is_empty() => {
            ("ok", "정상 답변 종료 확인")
        }
        Some("stop" | "end_turn") => ("error", "정상 종료 신호는 있지만 답변 본문이 없습니다."),
        Some("content_filter") => (
            "error",
            "콘텐츠 필터로 종료되어 정상 답변 완료를 확인하지 못했습니다.",
        ),
        Some("tool_calls" | "function_call") => (
            "error",
            "도구 호출로 종료되어 답변 완료를 확인하지 못했습니다.",
        ),
        Some(_) => (
            "error",
            "알 수 없는 종료 사유입니다. API 응답을 확인하세요.",
        ),
        None => ("error", "API 종료 사유가 없습니다."),
    };
    check_row("finish_reason", status, detail, true)
}
pub async fn check(State(s): State<App>, Json(mut b): Json<Start>) -> ApiResult<Json<Value>> {
    settings::resolve(&s, &mut b).await.map_err(bad)?;
    provider::endpoint_for(&b.config.base_url, &b.config.api_format).map_err(bad)?;
    if b.config.model.is_empty()
        || !(1..=32768).contains(&b.config.max_tokens)
        || !(5..=1800).contains(&b.config.timeout_s)
    {
        return Err(bad("모델·출력 한도·요청 시간을 확인하세요"));
    }
    let task = Task {
        id:"preflight:stream-v1".into(), subject:"계측 검증".into(),
        prompt:"Write a plain, factual paragraph of about 150 words explaining how rain forms and reaches the ground. Start directly with the explanation.".into(),
        answer:Value::Null, scorer:"exact".into(), max_tokens:2048,
        meta:json!({"preflight":true}),
    };
    let (tx, _rx) = mpsc::channel(1);
    let mut probe_config = b.config.clone();
    probe_config.timeout_s = probe_config.timeout_s.min(120);
    let a = provider::generate(&probe_config, &task, &b.api_key, tx).await;
    let quality = metrics_quality::evaluate(&a.metrics);
    let mut checks = vec![check_row(
        "response",
        if a.error.is_none() { "ok" } else { "error" },
        if a.error.is_none() {
            "응답 수신 완료".to_owned()
        } else {
            a.error.clone().unwrap_or_default()
        },
        true,
    )];
    for (key, label) in [
        ("ttft_ms", "가시 답변 첫 토큰"),
        ("decode_tps", "Decode"),
        ("client_visible_decode_tps", "성능 점수용 가시 출력 Decode"),
        ("prefill_tps", "서버 Prefill"),
    ] {
        checks.push(metric_check(&a.metrics, &quality, key, label));
    }
    for (id, value) in [
        ("input_tokens", a.metrics.input_tokens),
        ("output_tokens", a.metrics.output_tokens),
    ] {
        let mut row = check_row(
            id,
            if value.is_some() { "ok" } else { "unsupported" },
            if value.is_some() {
                "API 토큰 집계 제공"
            } else {
                "API 응답에 토큰 집계가 없습니다."
            },
            true,
        );
        row["value"] = json!(value);
        checks.push(row);
    }
    checks.push(check_row(
        "reasoning_tokens",
        if a.metrics.reasoning_tokens.is_some() {
            "ok"
        } else {
            "unsupported"
        },
        if a.metrics.reasoning_tokens == Some(0) {
            "추론 토큰 0 또는 비추론 응답"
        } else if a.metrics.reasoning_tokens.is_some() {
            "API 추론 토큰 집계 제공"
        } else {
            "추론 토큰 별도 집계 미제공"
        },
        false,
    ));
    checks.push(check_row(
        "reasoning_ttft_ms",
        if a.metrics.reasoning_ttft_ms.is_some() {
            "ok"
        } else {
            "unsupported"
        },
        if a.metrics.reasoning_ttft_ms.is_some() {
            "첫 추론 토큰을 가시 답변 TTFT와 별도로 측정"
        } else {
            "별도 추론 스트림 미제공 또는 비추론 응답"
        },
        false,
    ));
    checks.push(finish_check(a.finish_reason.as_deref(), &a.output));
    if let Some(d) = &b.config.device {
        let sample = settings::sample(&s, d).await;
        checks.push(check_row(
            "device",
            if sample["ok"] == true { "ok" } else { "error" },
            sample["error"].as_str().unwrap_or("선택 장비 연결 확인"),
            true,
        ));
        for key in ["utilization_pct", "temperature_c", "power_w"] {
            let gpus = sample["data"]["gpus"].as_array();
            let available =
                gpus.is_some_and(|g| !g.is_empty() && g.iter().all(|gpu| gpu[key].is_number()));
            checks.push(check_row(
                &format!("device_{key}"),
                if available { "ok" } else { "unsupported" },
                if available {
                    "선택 GPU 계측값 확인"
                } else {
                    "선택 장비가 해당 GPU 지표를 제공하지 않습니다."
                },
                true,
            ));
        }
    } else if !b.config.telemetry_url.is_empty() {
        let result = async {
            let c = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?;
            c.get(&b.config.telemetry_url)
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await
        }
        .await;
        checks.push(check_row(
            "device",
            if result.is_ok() { "ok" } else { "error" },
            if result.is_ok() {
                "장비 수집기 응답 확인"
            } else {
                "장비 수집기 연결 실패"
            },
            true,
        ));
    } else {
        checks.push(check_row(
            "device",
            "unsupported",
            "장비를 선택하지 않았습니다.",
            false,
        ));
    }
    let status = if a.error.is_some() {
        "failed"
    } else if checks
        .iter()
        .any(|c| c["required"] == true && c["status"] != "ok")
    {
        "limited"
    } else {
        "ready"
    };
    let token = uuid::Uuid::new_v4().to_string();
    let mut tickets = s.preflights.lock().await;
    tickets.retain(|_, t| t.created.elapsed() < TTL);
    if tickets.len() > 512 {
        tickets.clear();
    }
    tickets.insert(
        token.clone(),
        Ticket {
            created: Instant::now(),
            fingerprint: fingerprint(&b),
            status: status.into(),
        },
    );
    Ok(Json(
        json!({"status":status,"checked_at":now(),"expires_in_seconds":TTL.as_secs(),"preflight_token":token,
        "requires_acknowledgement":status=="limited","checks":checks,"metrics":a.metrics,"metric_quality":quality,
        "finish_reason":a.finish_reason,"probe":{"max_tokens":task.max_tokens.min(b.config.max_tokens),"timeout_s":probe_config.timeout_s,"scored":false},
        "measurement_version":metrics_quality::VERSION}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Start {
        serde_json::from_value(json!({"config":{"name":"fixture","base_url":"http://localhost:1/v1","model":"fixture","pack_id":"p","profile":"quick","temperature":0,"max_tokens":4096,"concurrency":1,"timeout_s":120}})).unwrap()
    }
    #[test]
    fn ticket_binds_measurement_settings_but_not_run_name_or_pack() {
        let a = request();
        let mut b = request();
        b.config.name = "new name".into();
        b.config.pack_id = "another pack".into();
        assert_eq!(fingerprint(&a), fingerprint(&b));
        b.config.reasoning_effort = "high".into();
        assert_ne!(fingerprint(&a), fingerprint(&b));
        b = request();
        b.api_key = "changed credential".into();
        assert_ne!(fingerprint(&a), fingerprint(&b));
    }
    #[test]
    fn absent_prefill_is_explicitly_unsupported() {
        let m = Metrics::default();
        let q = metrics_quality::evaluate(&m);
        let row = metric_check(&m, &q, "prefill_tps", "Prefill");
        assert_eq!(row["status"], "unsupported");
        assert!(row["detail"].as_str().unwrap().contains("TTFT"));
    }
    #[test]
    fn finish_requires_known_normal_termination_and_visible_answer() {
        assert_eq!(finish_check(Some("stop"), "answer")["status"], "ok");
        assert_eq!(finish_check(Some("end_turn"), "answer")["status"], "ok");
        assert_eq!(finish_check(Some("length"), "")["status"], "unsupported");
        assert_eq!(finish_check(Some("stop"), " \n")["status"], "error");
        for reason in [
            Some("content_filter"),
            Some("tool_calls"),
            Some("function_call"),
            Some("unknown"),
            None,
        ] {
            assert_eq!(finish_check(reason, "partial answer")["status"], "error");
        }
    }
    #[test]
    fn limited_failed_expired_and_changed_settings_cannot_silently_start() {
        let mut b = request();
        let mut t = Ticket {
            created: Instant::now(),
            fingerprint: fingerprint(&b),
            status: "limited".into(),
        };
        assert!(validate_ticket(&t, &b).is_err());
        b.allow_limited_metrics = true;
        assert!(validate_ticket(&t, &b).is_ok());
        t.status = "failed".into();
        assert!(validate_ticket(&t, &b).is_err());
        t.status = "ready".into();
        b.config.max_tokens = 8192;
        assert!(validate_ticket(&t, &b).is_err());
        b = request();
        t.fingerprint = fingerprint(&b);
        assert!(validate_ticket(&t, &b).is_ok());
        t.created = Instant::now() - TTL;
        assert!(validate_ticket(&t, &b).is_err());
    }
}
