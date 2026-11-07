use crate::{App, provider, scoring, types::*};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinSet,
};

pub fn launch(s: App, id: String) {
    tokio::spawn(async move {
        if let Err(e) = drive(s.clone(), id.clone()).await {
            mark_running_dirty(&s, &id).await;
            let _ = s
                .checkpoint(&id, |r| {
                    r.status = "interrupted".into();
                    r.error = Some(e.to_string());
                    for item in &mut r.items {
                        if item.status == "running" {
                            item.status = "pending".into();
                            if let Some(a) = item.attempts.last_mut() {
                                a.error = Some("실행기 오류로 중단".into());
                                a.ended_at = Some(now());
                            }
                        }
                    }
                })
                .await;
        }
        s.active.lock().await.remove(&id);
        let _ = s.events.send(id);
    });
}
async fn mark_running_dirty(s: &App, id: &str) {
    let runs = s.runs.lock().await;
    if let Some(r) = runs.get(id) {
        let indices = r
            .items
            .iter()
            .enumerate()
            .filter(|(_, i)| i.status == "running")
            .map(|(n, _)| n)
            .collect::<Vec<_>>();
        if !indices.is_empty() {
            s.dirty
                .lock()
                .await
                .entry(id.into())
                .or_default()
                .extend(indices);
        }
    }
}
fn admission_indices(r: &Run, active_jobs: usize) -> Vec<usize> {
    // Run the existing API-experience items before more quality work so the
    // performance score is available early. Select indices only: task order,
    // item identities, completed answers and the suite hash remain unchanged.
    // The c1 reference must drain active requests AND grading before starting.
    if r.items.iter().any(|i| {
        i.task.scorer == "experience" && ["running", "grading"].contains(&i.status.as_str())
    }) {
        return Vec::new();
    }
    // The optional temporary cap changes admission, never saved questions.
    let mut occupied = std::collections::BTreeMap::<&str, usize>::new();
    for item in &r.items {
        if ["done", "error", "running", "grading"].contains(&item.status.as_str()) {
            *occupied.entry(&item.task.subject).or_default() += 1;
        }
    }
    let pending = r
        .items
        .iter()
        .enumerate()
        .filter(|(_, i)| i.status == "pending")
        .filter(|(_, i)| {
            let Some(limit) = r.config.subject_item_limit else {
                return true;
            };
            let count = occupied.entry(&i.task.subject).or_default();
            if *count >= limit {
                return false;
            }
            *count += 1;
            true
        })
        .collect::<Vec<_>>();
    if let Some((index, _)) = pending
        .iter()
        .filter(|(_, i)| i.task.scorer == "experience")
        .min_by_key(|(index, i)| {
            let warmup = i.task.meta["warmup"] == true || i.task.id == "experience:warmup:0";
            (!warmup, *index)
        })
    {
        return if active_jobs == 0 {
            vec![*index]
        } else {
            Vec::new()
        };
    }
    pending
        .into_iter()
        .take(r.config.concurrency.saturating_sub(active_jobs))
        .map(|(n, _)| n)
        .collect()
}
async fn drive(s: App, id: String) -> anyhow::Result<()> {
    if !crate::auto_concurrency::drive(&s, &id).await? {
        return Ok(());
    }
    let mut jobs = JoinSet::new();
    let grading = s.runs.lock().await[&id]
        .items
        .iter()
        .enumerate()
        .filter(|(_, i)| i.status == "grading")
        .map(|(n, _)| n)
        .collect::<Vec<_>>();
    for index in grading {
        jobs.spawn(finish_grading(s.clone(), id.clone(), index));
    }

    let mut tick = tokio::time::interval(Duration::from_millis(200));
    let mut sensor_tick = Instant::now();
    let mut clock_tick = Instant::now();
    let mut checkpoint_tick = Instant::now();
    let mut guard_tick = Instant::now();
    let mut rollback = None;
    let segment = Instant::now();
    let original_ms = s.runs.lock().await[&id].active_ms;
    let mut telemetry_job: Option<tokio::task::JoinHandle<Value>> = None;
    loop {
        if rollback.is_none() && guard_tick.elapsed() >= Duration::from_secs(5) {
            rollback = crate::concurrency_guard::evaluate(&s.runs.lock().await[&id]);
            guard_tick = Instant::now();
        }
        if rollback.is_some() && jobs.is_empty() {
            let decision = rollback.take().unwrap();
            let previous = {
                let runs = s.runs.lock().await;
                let r = &runs[&id];
                (
                    r.config.clone(),
                    r.execution_segments.clone(),
                    r.concurrency_tuning.clone(),
                )
            };
            if let Err(error) = s
                .checkpoint(&id, |r| {
                    crate::concurrency_guard::apply(r, &decision);
                })
                .await
            {
                s.update_progress(&id, |r| {
                    r.config = previous.0;
                    r.execution_segments = previous.1;
                    r.concurrency_tuning = previous.2;
                })
                .await?;
                return Err(error);
            }
            let _ = s.events.send(id.clone());
        }
        if checkpoint_tick.elapsed() >= Duration::from_secs(5) {
            s.checkpoint(&id, |_| {}).await?;
            checkpoint_tick = Instant::now();
        }
        if clock_tick.elapsed() >= Duration::from_secs(1) {
            s.update_progress(&id, |r| {
                r.active_ms = original_ms + segment.elapsed().as_secs_f64() * 1000.0
            })
            .await?;
            clock_tick = Instant::now();
        }
        let (status, config, indices) = {
            let runs = s.runs.lock().await;
            let r = &runs[&id];
            (
                r.status.clone(),
                r.config.clone(),
                if rollback.is_some() {
                    Vec::new()
                } else {
                    admission_indices(r, jobs.len())
                },
            )
        };
        if status == "cancelling" {
            jobs.abort_all();
            while jobs.join_next().await.is_some() {}
            scoring::cleanup_run(&id).await;
            if let Some(h) = telemetry_job.take() {
                h.abort()
            }
            mark_running_dirty(&s, &id).await;
            s.checkpoint(&id, |r| {
                r.status = "cancelled".into();
                r.active_ms = original_ms + segment.elapsed().as_secs_f64() * 1000.0;
                for i in &mut r.items {
                    if i.status == "running" {
                        i.status = "pending".into();
                        if let Some(a) = i.attempts.last_mut() {
                            a.ended_at = Some(now());
                            a.error = Some("사용자 중단".into())
                        }
                    }
                }
            })
            .await?;
            break;
        }
        if status == "running" {
            for index in indices {
                s.update_item(&id, index, true, |r| {
                    let i = &mut r.items[index];
                    i.status = "running".into();
                    i.attempts.push(Attempt {
                        started_at: now(),
                        ended_at: None,
                        output: String::new(),
                        reasoning: String::new(),
                        finish_reason: None,
                        error: None,
                        metrics: Metrics {
                            request_concurrency: Some(if i.task.scorer == "experience" {
                                1
                            } else {
                                config.concurrency
                            }),
                            ..Metrics::default()
                        },
                        score: None,
                        raw: vec![],
                    })
                })
                .await?;
                jobs.spawn(run_item(s.clone(), id.clone(), index));
            }
        }
        if jobs.is_empty() {
            if let Some(h) = telemetry_job.take() {
                h.abort()
            }
            s.checkpoint(&id, |r| {
                r.status = if status == "pausing" {
                    "paused"
                } else {
                    "completed"
                }
                .into();
                r.active_ms = original_ms + segment.elapsed().as_secs_f64() * 1000.0;
            })
            .await?;
            break;
        }
        if sensor_tick.elapsed() >= Duration::from_secs(2)
            && telemetry_job.is_none()
            && (config.device.is_some() || !config.telemetry_url.is_empty())
        {
            let url = config.telemetry_url.clone();
            let device = config.device.clone();
            let sensor_app = s.clone();
            telemetry_job = Some(tokio::spawn(async move {
                if let Some(d) = device {
                    let v = crate::settings::sample(&sensor_app, &d).await;
                    return json!({"received_at":now(),"data":v["data"],"status":v["status"],"error":v["error"],"device_id":d.id,"device_name":d.name});
                }
                let result = async {
                    let c = reqwest::Client::builder()
                        .redirect(reqwest::redirect::Policy::none())
                        .timeout(Duration::from_secs(3))
                        .build()?;
                    Ok::<Value, reqwest::Error>(
                        c.get(&url).send().await?.error_for_status()?.json().await?,
                    )
                }
                .await;
                match result {
                    Ok(v) => json!({"received_at":now(),"data":v}),
                    Err(_) => json!({"received_at":now(),"error":"장비 수집기 연결 실패"}),
                }
            }));
            sensor_tick = Instant::now();
        }
        if telemetry_job.as_ref().is_some_and(|h| h.is_finished()) {
            let v = telemetry_job.take().unwrap().await?;
            s.update_progress(&id, |r| r.telemetry.push(v)).await?;
        }
        tokio::select! {
            result=jobs.join_next()=>{if let Some(result)=result{result??;}},
            _=tick.tick()=>{}
        }
    }
    Ok(())
}
async fn run_item(s: App, id: String, index: usize) -> anyhow::Result<()> {
    let (mut config, task) = {
        let runs = s.runs.lock().await;
        let r = &runs[&id];
        (r.config.clone(), r.items[index].task.clone())
    };
    if task.scorer == "experience" {
        config.concurrency = 1;
    }
    let request_concurrency = config.concurrency;
    let key = s.keys.lock().await.get(&id).cloned().unwrap_or_default();
    let (tx, mut rx) = mpsc::channel(4);
    let future = provider::generate(&config, &task, &key, tx);
    tokio::pin!(future);
    let mut a = loop {
        tokio::select! {
            a=&mut future=>break a,
            Some(mut p)=rx.recv()=>{p.metrics.request_concurrency=Some(request_concurrency);s.update_item(&id,index,false,|r|{let a=r.items[index].attempts.last_mut().unwrap();a.output=p.output;a.reasoning=p.reasoning;a.metrics=p.metrics;}).await?}
        }
    };
    a.metrics.request_concurrency = Some(request_concurrency);
    if a.error.is_none() {
        s.update_item(&id, index, true, |r| {
            r.items[index].status = "grading".into();
            *r.items[index].attempts.last_mut().unwrap() = a;
        })
        .await?;
        return finish_grading(s, id, index).await;
    }
    s.update_item(&id, index, true, |r| {
        let i = &mut r.items[index];
        i.status = "error".into();
        *i.attempts.last_mut().unwrap() = a;
    })
    .await?;
    Ok(())
}
async fn finish_grading(s: App, id: String, index: usize) -> anyhow::Result<()> {
    let (config, task, output) = {
        let runs = s.runs.lock().await;
        let r = &runs[&id];
        let i = &r.items[index];
        (
            r.config.clone(),
            i.task.clone(),
            i.attempts.last().unwrap().output.clone(),
        )
    };
    let grading_start = Instant::now();
    let score = evaluate(&s, &id, &config, &task, &output).await;
    let grading_ms = grading_start.elapsed().as_secs_f64() * 1000.0;
    s.update_item(&id, index, true, |r| {
        let i = &mut r.items[index];
        i.status = "done".into();
        let a = i.attempts.last_mut().unwrap();
        a.metrics.grading_ms = Some(grading_ms);
        a.score = Some(score.with_previous(a.score.as_ref()));
    })
    .await?;
    Ok(())
}

pub(crate) async fn evaluate(
    s: &App,
    id: &str,
    config: &Config,
    task: &Task,
    output: &str,
) -> Score {
    if task.scorer == "judge" {
        let key = s
            .judge_keys
            .lock()
            .await
            .get(id)
            .cloned()
            .unwrap_or_default();
        scoring::judge(config, task, output, &key).await
    } else {
        scoring::score_for_run(task, output, id).await
    }
}
pub fn rescore(s: App, id: String, previous: String) {
    tokio::spawn(async move {
        let (config, items) = {
            let runs = s.runs.lock().await;
            let r = &runs[&id];
            (r.config.clone(), r.items.clone())
        };
        for (index, item) in items.iter().enumerate() {
            if let Some(a) = item
                .attempts
                .last()
                .filter(|a| a.error.is_none() && a.ended_at.is_some())
            {
                let score = evaluate(&s, &id, &config, &item.task, &a.output).await;
                if let Err(e) = s
                    .update_item(&id, index, true, |r| {
                        let a = r.items[index].attempts.last_mut().unwrap();
                        a.score = Some(score.with_previous(a.score.as_ref()))
                    })
                    .await
                {
                    eprintln!("재채점 기록 오류: {e}");
                    break;
                }
            }
        }
        let _ = s.checkpoint(&id, |r| r.status = previous).await;
        s.active.lock().await.remove(&id);
        let _ = s.events.send(id);
    });
}

pub(crate) fn validate_agent_token(token: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        (32..=4096).contains(&token.len())
            && token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b)),
        "수집기 토큰은 공백 없는 ASCII 토큰 32~4096자로 지정하세요"
    );
    Ok(())
}

#[derive(Clone)]
struct AgentAuth {
    digest: Option<[u8; 32]>,
}
impl AgentAuth {
    fn new(address: std::net::SocketAddr, token: Option<String>) -> anyhow::Result<Self> {
        use sha2::{Digest, Sha256};
        anyhow::ensure!(
            address.ip().is_loopback() || token.is_some(),
            "외부 수집기 주소에는 BENCH_AGENT_TOKEN_FILE 또는 BENCH_AGENT_TOKEN이 필요합니다"
        );
        if let Some(token) = token {
            validate_agent_token(&token)?;
            Ok(Self {
                digest: Some(Sha256::digest(token.as_bytes()).into()),
            })
        } else {
            Ok(Self { digest: None })
        }
    }
    fn permits(&self, headers: &axum::http::HeaderMap) -> bool {
        use sha2::{Digest, Sha256};
        let Some(expected) = &self.digest else {
            return true;
        };
        if headers
            .get_all(axum::http::header::AUTHORIZATION)
            .iter()
            .count()
            != 1
        {
            return false;
        }
        let Some(value) = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
        else {
            return false;
        };
        let Some((scheme, token)) = value.split_once(' ') else {
            return false;
        };
        if !scheme.eq_ignore_ascii_case("Bearer") {
            return false;
        }
        let actual: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        expected
            .iter()
            .zip(actual.iter())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
    }
}
async fn authorize_agent(
    axum::extract::State(auth): axum::extract::State<AgentAuth>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !auth.permits(request.headers()) {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            [
                (axum::http::header::WWW_AUTHENTICATE, "Bearer"),
                (axum::http::header::CACHE_CONTROL, "no-store"),
            ],
            axum::Json(json!({"error":"수집기 인증이 필요합니다"})),
        )
            .into_response();
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

pub async fn agent() -> anyhow::Result<()> {
    let address = std::env::var("BENCH_AGENT_BIND").unwrap_or_else(|_| "127.0.0.1:18761".into());
    let address = address
        .parse::<std::net::SocketAddr>()
        .map_err(|_| anyhow::anyhow!("BENCH_AGENT_BIND는 IP:포트 형식으로 지정하세요"))?;
    let read_env = |name| match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(_) => Err(anyhow::anyhow!("수집기 인증 환경변수 형식을 확인하세요")),
    };
    let env_token = read_env("BENCH_AGENT_TOKEN")?;
    let token_file = read_env("BENCH_AGENT_TOKEN_FILE")?;
    anyhow::ensure!(
        env_token.is_none() || token_file.is_none(),
        "BENCH_AGENT_TOKEN과 BENCH_AGENT_TOKEN_FILE 중 하나만 지정하세요"
    );
    let token = if let Some(file) = token_file {
        let metadata = tokio::fs::metadata(&file)
            .await
            .map_err(|_| anyhow::anyhow!("수집기 토큰 파일을 읽을 수 없습니다"))?;
        anyhow::ensure!(metadata.len() <= 8192, "수집기 토큰 파일이 너무 큽니다");
        Some(
            tokio::fs::read_to_string(file)
                .await
                .map_err(|_| anyhow::anyhow!("수집기 토큰 파일을 읽을 수 없습니다"))?
                .trim()
                .to_string(),
        )
    } else {
        env_token
    };
    let auth = AgentAuth::new(address, token)?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let value = Arc::new(Mutex::new(json!({"status":"starting"})));
    let dest = value.clone();
    tokio::spawn(async move {
        let offload = std::env::var("BENCH_AGENT_OFFLOAD").is_ok_and(|v| v == "1");
        loop {
            *dest.lock().await = match tokio::time::timeout(
                Duration::from_secs(7),
                crate::telemetry::local_sample(offload),
            )
            .await
            {
                Ok(Ok(mut v)) => {
                    v["source"] = "bench-agent".into();
                    v
                }
                _ => json!({"status":"unavailable","error":"장비 상태를 수집할 수 없습니다"}),
            };
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    let app = axum::Router::new()
        .route(
            "/metrics",
            axum::routing::get(move || {
                let v = value.clone();
                async move { axum::Json(v.lock().await.clone()) }
            }),
        )
        .route(
            "/health",
            axum::routing::get(|| async {
                axum::Json(json!({"status":"ok","service":"bench-agent","read_only":true}))
            }),
        )
        .layer(axum::middleware::from_fn_with_state(auth, authorize_agent));
    println!("읽기 전용 장비 수집기 http://{address}/metrics");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod agent_auth_tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue, header::AUTHORIZATION};
    const TOKEN: &str = "fixture-only-agent-token-01234567890123456789";
    #[test]
    fn external_bind_requires_token_but_loopback_keeps_compatibility() {
        assert!(AgentAuth::new("0.0.0.0:18761".parse().unwrap(), None).is_err());
        assert!(AgentAuth::new("[::]:18761".parse().unwrap(), None).is_err());
        assert!(AgentAuth::new("192.0.2.1:18761".parse().unwrap(), None).is_err());
        assert!(AgentAuth::new("127.0.0.1:18761".parse().unwrap(), None).is_ok());
        assert!(AgentAuth::new("[::1]:18761".parse().unwrap(), None).is_ok());
        assert!(AgentAuth::new("0.0.0.0:18761".parse().unwrap(), Some(TOKEN.into())).is_ok());
    }
    #[test]
    fn bearer_auth_rejects_missing_wrong_and_duplicate_headers() {
        let auth = AgentAuth::new("127.0.0.1:1".parse().unwrap(), Some(TOKEN.into())).unwrap();
        let mut headers = HeaderMap::new();
        assert!(!auth.permits(&headers));
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer wrong"));
        assert!(!auth.permits(&headers));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {TOKEN}")).unwrap(),
        );
        assert!(auth.permits(&headers));
        headers.append(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {TOKEN}")).unwrap(),
        );
        assert!(!auth.permits(&headers));
    }
    #[test]
    fn configured_tokens_reject_empty_short_and_header_injection() {
        for token in [
            "",
            "short",
            "fixture-only-agent-token-0123456789\nX: injected",
        ] {
            assert!(validate_agent_token(token).is_err());
        }
        assert!(validate_agent_token(TOKEN).is_ok());
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    fn run() -> Run {
        let items=(0..4).map(|n| json!({"task":{"id":format!("fixture:{n}"),"subject":"fixture","prompt":"p","answer":null,"scorer":if n==2{"experience"}else{"exact"},"max_tokens":32,"meta":{}},"status":"pending","attempts":[]})).collect::<Vec<_>>();
        serde_json::from_value(json!({"id":"fixture","created_at":now(),"config":{"name":"fixture","base_url":"http://localhost:1/v1","model":"fixture","pack_id":"fixture","profile":"full","temperature":0,"max_tokens":32,"concurrency":4,"timeout_s":5},"status":"running","suite_hash":"fixture","protocol_version":"fixture","pack_version":"fixture","provenance":"fixture","items":items,"telemetry":[],"active_ms":0,"error":null})).unwrap()
    }
    #[test]
    fn subject_cap_counts_finished_and_inflight_without_deleting_tasks() {
        let mut r = run();
        for item in &mut r.items {
            item.task.scorer = "exact".into();
        }
        r.config.subject_item_limit = Some(2);
        assert_eq!(admission_indices(&r, 0), vec![0, 1]);
        r.items[0].status = "done".into();
        r.items[1].status = "running".into();
        assert!(admission_indices(&r, 1).is_empty());
        r.items[1].status = "done".into();
        assert!(admission_indices(&r, 0).is_empty());
        r.items[2].task.subject = "other".into();
        assert_eq!(admission_indices(&r, 0), vec![2]);
        assert_eq!(r.items.len(), 4);
        assert_eq!(r.items[3].status, "pending");
        r.config.subject_item_limit = None;
        assert_eq!(admission_indices(&r, 0), vec![2, 3]);
    }
    #[test]
    fn experience_runs_first_after_quality_requests_and_grading_drain() {
        let mut r = run();
        assert_eq!(admission_indices(&r, 0), vec![2]);
        r.items[0].status = "running".into();
        assert!(admission_indices(&r, 1).is_empty());
        r.items[0].status = "grading".into();
        assert!(admission_indices(&r, 1).is_empty());
        r.items[0].status = "done".into();
        // A finished task can still be waiting for JoinSet to reap it.
        assert!(admission_indices(&r, 1).is_empty());
        assert_eq!(admission_indices(&r, 0), vec![2]);
        r.items[2].status = "running".into();
        assert!(admission_indices(&r, 1).is_empty());
        r.items[2].status = "grading".into();
        assert!(admission_indices(&r, 1).is_empty());
        r.items[2].status = "done".into();
        assert_eq!(admission_indices(&r, 0), vec![1, 3]);
    }

    fn run_with_performance(concurrency: usize) -> Run {
        let mut r = run();
        r.config.concurrency = concurrency;
        r.items = (0..10)
            .map(|n| {
                let mut item = r.items[0].clone();
                item.task.id = format!("quality:{n}");
                item
            })
            .collect();
        let pack: Pack =
            serde_json::from_str(include_str!("../datasets/api-experience-v1.json")).unwrap();
        r.items.extend(pack.tasks.into_iter().map(|task| Item {
            task,
            status: "pending".into(),
            attempts: vec![],
        }));
        r
    }

    #[test]
    fn existing_thirteen_items_run_serially_then_restore_c1_or_c8_quality() {
        for concurrency in [1, 8] {
            let mut r = run_with_performance(concurrency);
            let tasks_before =
                serde_json::to_value(r.items.iter().map(|i| &i.task).collect::<Vec<_>>()).unwrap();
            let hash_before = r.suite_hash.clone();
            assert_eq!(r.items[10].task.id, "experience:warmup:0");
            assert_eq!(r.items.len(), 23);
            for index in 10..23 {
                let before = serde_json::to_value(&r).unwrap();
                assert_eq!(admission_indices(&r, 0), vec![index]);
                assert_eq!(serde_json::to_value(&r).unwrap(), before);
                r.items[index].status = "running".into();
                assert!(admission_indices(&r, 1).is_empty());
                r.items[index].status = "grading".into();
                assert!(admission_indices(&r, 1).is_empty());
                r.items[index].status = "done".into();
            }
            assert_eq!(
                admission_indices(&r, 0),
                (0..concurrency).collect::<Vec<_>>()
            );
            assert_eq!(r.config.concurrency, concurrency);
            assert_eq!(r.suite_hash, hash_before);
            assert_eq!(
                serde_json::to_value(r.items.iter().map(|i| &i.task).collect::<Vec<_>>()).unwrap(),
                tasks_before,
            );
        }
    }

    #[test]
    fn completed_or_failed_performance_items_are_not_automatically_retried() {
        let mut r = run_with_performance(8);
        for index in 10..23 {
            r.items[index].status = if index % 2 == 0 { "done" } else { "error" }.into();
        }
        assert_eq!(admission_indices(&r, 0), (0..8).collect::<Vec<_>>());
        r.items[0].status = "running".into();
        assert_eq!(admission_indices(&r, 1), (1..8).collect::<Vec<_>>());
    }

    #[test]
    fn pending_warmup_precedes_other_performance_without_reordering_items() {
        let mut r = run_with_performance(1);
        r.items.swap(10, 22);
        let before = serde_json::to_value(&r).unwrap();
        assert_eq!(admission_indices(&r, 0), vec![22]);
        assert_eq!(serde_json::to_value(&r).unwrap(), before);
        r.items[22].status = "done".into();
        assert_eq!(admission_indices(&r, 0), vec![10]);
    }
}
