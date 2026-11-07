mod auto_concurrency;
mod concurrency_guard;
mod metrics_quality;
mod preflight;
mod provider;
mod report;
mod runtime;
mod scoring;
mod settings;
mod setup;
mod storage;
mod telemetry;
mod types;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        Html, IntoResponse, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, broadcast};
use types::*;

#[derive(Clone)]
pub struct App {
    pub data_dir: String,
    pub preflights: Arc<Mutex<BTreeMap<String, preflight::Ticket>>>,
    pub db: SqlitePool,
    pub runs: Arc<Mutex<BTreeMap<String, Run>>>,
    pub packs: Arc<Mutex<BTreeMap<String, Pack>>>,
    pub keys: Arc<Mutex<BTreeMap<String, String>>>,
    pub judge_keys: Arc<Mutex<BTreeMap<String, String>>>,
    pub active: Arc<Mutex<BTreeSet<String>>>,
    pub events: broadcast::Sender<String>,
    pub settings_lock: Arc<Mutex<()>>,
    pub dirty: Arc<Mutex<BTreeMap<String, std::collections::BTreeSet<usize>>>>,
}
type ApiResult<T> = Result<T, (StatusCode, Json<Value>)>;
fn bad(s: impl ToString) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":s.to_string()})),
    )
}
impl App {
    pub async fn save(&self, run: &Run) -> anyhow::Result<()> {
        storage::save(self, run, true).await
    }
    pub async fn update_progress<F>(&self, id: &str, f: F) -> anyhow::Result<()>
    where
        F: FnOnce(&mut Run),
    {
        let mut runs = self.runs.lock().await;
        let r = runs
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("실행 없음"))?;
        f(r);
        let _ = self.events.send(id.into());
        Ok(())
    }
    pub async fn checkpoint<F>(&self, id: &str, f: F) -> anyhow::Result<()>
    where
        F: FnOnce(&mut Run),
    {
        let mut runs = self.runs.lock().await;
        let r = runs
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("실행 없음"))?;
        f(r);
        storage::save(self, r, false).await
    }
    pub async fn update_item<F>(
        &self,
        id: &str,
        index: usize,
        persist: bool,
        f: F,
    ) -> anyhow::Result<()>
    where
        F: FnOnce(&mut Run),
    {
        let mut runs = self.runs.lock().await;
        let r = runs
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("실행 없음"))?;
        f(r);
        self.dirty
            .lock()
            .await
            .entry(id.into())
            .or_default()
            .insert(index);
        if persist {
            storage::save(self, r, false).await?;
        } else {
            let _ = self.events.send(id.into());
        }
        Ok(())
    }
    pub async fn update<F>(&self, id: &str, f: F) -> anyhow::Result<()>
    where
        F: FnOnce(&mut Run),
    {
        let mut runs = self.runs.lock().await;
        let r = runs
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("실행 없음"))?;
        f(r);
        self.save(r).await
    }
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|x| x == "agent") {
        return runtime::agent().await;
    }
    let data = std::env::var("BENCH_DATA_DIR").unwrap_or_else(|_| "data".into());
    std::fs::create_dir_all(&data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700))?;
    }
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(format!("{data}/app.sqlite3"))
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
        )
        .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, body TEXT NOT NULL)")
        .execute(&db)
        .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS packs(id TEXT PRIMARY KEY, body TEXT NOT NULL)")
        .execute(&db)
        .await?;
    storage::init(&db).await?;
    let mut runs = BTreeMap::new();
    for (body,) in sqlx::query_as::<_, (String,)>("SELECT body FROM runs WHERE NOT EXISTS(SELECT 1 FROM run_trash WHERE run_trash.run_id=runs.id)")
        .fetch_all(&db)
        .await?
    {
        let mut r: Run = serde_json::from_str(&body)?;
        storage::load_items(&db, &mut r).await?;
        if ["running", "pausing", "cancelling", "scoring"].contains(&r.status.as_str()) {
            r.status = "interrupted".into();
            for i in &mut r.items {
                if i.status == "running" {
                    if i.attempts
                        .last()
                        .is_some_and(|a| a.ended_at.is_some() && a.error.is_none())
                    {
                        i.status = "grading".into();
                        continue;
                    }
                    i.status = "pending".into();
                    if let Some(a) = i.attempts.last_mut() {
                        a.error = Some("앱 재시작으로 중단".into());
                        a.ended_at = Some(now())
                    }
                }
            }
        }
        runs.insert(r.id.clone(), r);
    }
    let mut packs = BTreeMap::new();
    if let Ok(entries) = std::fs::read_dir("datasets") {
        for entry in entries.flatten() {
            if entry.path().extension().is_some_and(|e| e == "json") {
                let p: Pack = serde_json::from_slice(&std::fs::read(entry.path())?)?;
                packs.insert(p.id.clone(), p);
            }
        }
    }
    for (body,) in sqlx::query_as::<_, (String,)>("SELECT body FROM packs")
        .fetch_all(&db)
        .await?
    {
        let p: Pack = serde_json::from_str(&body)?;
        packs.insert(p.id.clone(), p);
    }
    // New quality exams collect timing from their own responses. Keep the
    // legacy experience pack available for records/API compatibility, but do
    // not append its fixed requests to quick or full quality selections.
    let components = [
        "gsm8k-test-v1",
        "math500-test-v1",
        "mmlu-pro-test-v1",
        "ifeval-full-v1",
        "humaneval-full-v1",
        "mbpp-test-v1",
        "livecodebench-v6-v1",
        "bbh-cot-full-v1",
    ];
    let installed = components
        .iter()
        .filter(|id| packs.contains_key(**id))
        .collect::<Vec<_>>();
    let missing = components
        .iter()
        .filter(|id| !packs.contains_key(**id))
        .collect::<Vec<_>>();
    if !installed.is_empty() {
        let mut tasks = Vec::new();
        let mut quick = Vec::new();
        let mut source = Vec::new();
        for id in installed {
            let p = &packs[*id];
            tasks.extend(p.tasks.iter().cloned());
            if let Some(ids) = p.sources["quick_ids"].as_array() {
                quick.extend(ids.iter().cloned());
            }
            source.push(
                json!({"id":p.id,"version":p.version,"count":p.tasks.len(),"sources":p.sources}),
            );
        }
        let count = tasks.len();
        let combined = Pack {
            id: "collection-full-v1".into(),
            name: if missing.is_empty() {
                "전체 분야 종합"
            } else {
                "설치된 평가팩 종합"
            }
            .into(),
            version: "2026-11-07.1".into(),
            sources: json!({"benchmark":"전체 분야 종합","split":"설치된 평가팩의 전체 평가 구간","source_count":count,"installed_count":count,"quick_count":quick.len(),"quick_ids":quick,"components":source,"missing_components":missing,"complete_collection":missing.is_empty(),"license":"구성 평가팩별 조건","redistribution":"local_collection","selection":"전체: 설치된 원본 평가 구간 전체 / 빠른: 각 팩의 고정 문항 ID"}),
            tasks,
        };
        packs.insert(combined.id.clone(), combined);
    }
    let (events, _) = broadcast::channel(128);
    let app = App {
        data_dir: data,
        preflights: Default::default(),
        db,
        runs: Arc::new(Mutex::new(runs)),
        packs: Arc::new(Mutex::new(packs)),
        keys: Default::default(),
        judge_keys: Default::default(),
        active: Default::default(),
        events,
        settings_lock: Default::default(),
        dirty: Default::default(),
    };
    settings::init(&app).await?;
    upgrade_performance_records(&app).await?;
    let router = Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({"ok":true,"version":"0.1.0"})) }),
        )
        .route("/api/readiness", get(settings::readiness))
        .route("/api/preflight", post(preflight::check))
        .route("/api/setup", get(setup::read).post(setup::write))
        .route("/api/packs", get(packs_list).post(pack_import))
        .route("/api/runs", get(runs_list).post(start_run))
        .route("/api/trash", get(trash_list))
        .route("/api/trash/{id}/restore", post(run_restore))
        .route(
            "/api/connections",
            get(settings::connections).post(settings::connection_write),
        )
        .route(
            "/api/connections/{id}/{action}",
            post(settings::connection_action),
        )
        .route(
            "/api/devices",
            get(settings::devices).post(settings::device_write),
        )
        .route("/api/devices/{id}/{action}", post(settings::device_action))
        .route("/api/devices/{id}/sample", get(settings::device_sample))
        .route("/api/import", post(import_run))
        .route("/api/artifacts", post(artifact_save))
        .route("/api/artifacts/{id}", get(artifact_get))
        .route("/api/runs/{id}", get(run_get))
        .route("/api/runs/{id}/delete", post(run_delete))
        .route("/api/runs/{id}/items/{index}", get(item_get))
        .route("/api/runs/{id}/telemetry", get(run_telemetry_get))
        .route("/api/runs/{id}/{action}", post(control))
        .route("/api/compare/{a}/{b}", get(compare))
        .route("/api/export/{id}", get(export))
        .route("/api/report/{id}", get(html_report))
        .route("/api/events", get(event_stream))
        .route("/api/check", post(check))
        .layer(DefaultBodyLimit::max(128 * 1024 * 1024))
        .layer(axum::middleware::from_fn(local_origin))
        .fallback_service(
            tower_http::services::ServeDir::new("web/dist").append_index_html_on_directories(true),
        )
        .with_state(app);
    let port = std::env::var("BENCH_PORT").unwrap_or_else(|_| "18760".into());
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await?;
    println!("LLM Bench → http://127.0.0.1:{port}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
async fn local_origin(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let host = req
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !host.starts_with("127.0.0.1:") && !host.starts_with("localhost:") {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Some(o) = req.headers().get("origin").and_then(|h| h.to_str().ok()) {
        if o != format!("http://{host}") {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    next.run(req).await
}
async fn packs_list(State(s): State<App>) -> Json<Value> {
    Json(json!(s.packs.lock().await.values().map(|p|{
        let ids = p.sources["quick_ids"].as_array().map(|v|v.iter().filter_map(|v|v.as_str()).collect::<std::collections::HashSet<_>>());
        let mut subjects = BTreeMap::new(); let mut quick = BTreeMap::new();
        for t in &p.tasks { let n = subjects.entry(&t.subject).or_insert(0usize); *n+=1;
            if ids.as_ref().map(|ids|ids.contains(t.id.as_str())).unwrap_or(*n<=5) {*quick.entry(&t.subject).or_insert(0usize)+=1;}
        }
        json!({"id":p.id,"name":p.name,"version":p.version,"sources":p.sources,"count":p.tasks.len(),"subjects":subjects,"quick_subjects":quick})
    }).collect::<Vec<_>>()))
}
async fn pack_import(State(s): State<App>, Json(p): Json<Pack>) -> ApiResult<Json<Value>> {
    validate_pack(&p).map_err(bad)?;
    // Only user registration is restricted. Bundled/file-installed official
    // packs and historical runs retain their original identities.
    let reserved = |id: &str| {
        let id = id.to_lowercase();
        [
            "experience:",
            "api-experience",
            "gsm8k",
            "bbh",
            "math500",
            "math-500",
            "mmlu-pro",
            "ifeval",
            "humaneval",
            "mbpp",
            "livecodebench",
            "lcb:",
            "ko-core",
            "korean-core",
            "collection-full",
            "public-core",
        ]
        .iter()
        .any(|prefix| id.starts_with(prefix))
    };
    if reserved(&p.id) || p.tasks.iter().any(|t| reserved(&t.id)) {
        return Err(bad(
            "공식 평가팩·문항 ID는 예약되어 있습니다. 사용자팩 ID와 문항 ID에 custom: 접두사를 사용하세요",
        ));
    }
    if s.packs.lock().await.contains_key(&p.id) {
        return Err(bad("이미 있는 평가팩 ID입니다. 새 ID·버전으로 추가하세요"));
    }
    sqlx::query("INSERT INTO packs(id,body) VALUES(?,?)")
        .bind(&p.id)
        .bind(serde_json::to_string(&p).unwrap())
        .execute(&s.db)
        .await
        .map_err(bad)?;
    s.packs.lock().await.insert(p.id.clone(), p);
    Ok(Json(json!({"ok":true})))
}
fn validate_pack(p: &Pack) -> anyhow::Result<()> {
    anyhow::ensure!(
        !p.id.is_empty() && !p.version.is_empty() && !p.tasks.is_empty() && p.tasks.len() <= 100000,
        "팩 ID·버전·문항을 확인하세요"
    );
    let mut ids = std::collections::HashSet::new();
    for t in &p.tasks {
        anyhow::ensure!(ids.insert(&t.id), "중복 문항 ID");
        anyhow::ensure!(!t.prompt.is_empty() && t.max_tokens > 0, "문항 입력 확인");
        anyhow::ensure!(
            [
                "numeric",
                "choice",
                "exact",
                "json",
                "ifeval",
                "humaneval",
                "judge",
                "math",
                "mbpp",
                "livecodebench",
                "korean_rules",
                "experience",
                "bbh"
            ]
            .contains(&t.scorer.as_str()),
            "지원 채점기 확인"
        );
    }
    Ok(())
}
async fn runs_list(State(s): State<App>) -> Json<Value> {
    let active = s.active.lock().await;
    let runs = s.runs.lock().await;
    let mut v = runs.values().collect::<Vec<_>>();
    v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(json!(v.into_iter().map(|r|json!({"id":r.id,"name":r.config.name,"model":r.config.model,"created_at":r.created_at,"status":r.status,"provenance":r.provenance,"summary":r.summary(),"busy":run_busy(r,&active)})).collect::<Vec<_>>()))
}
fn run_busy(r: &Run, active: &BTreeSet<String>) -> bool {
    active.contains(&r.id)
        || ["running", "pausing", "cancelling", "scoring"].contains(&r.status.as_str())
}
async fn trash_list(State(s): State<App>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(storage::trash_list(&s.db).await.map_err(bad)?)))
}
async fn run_delete(State(s): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    // Same order as start/control: active -> runs -> dirty -> DB. Holding both
    // guards makes delete atomic with resume/retry/rescore admission.
    let active = s.active.lock().await;
    let mut runs = s.runs.lock().await;
    let Some(r) = runs.get(&id) else {
        if let Some(deleted_at) = storage::deleted_at(&s.db, &id).await.map_err(bad)? {
            return Ok(Json(json!({"ok":true,"id":id,"deleted_at":deleted_at})));
        }
        return Err(bad("삭제할 시험 기록이 없습니다"));
    };
    if run_busy(r, &active) {
        return Err((
            StatusCode::CONFLICT,
            Json(
                json!({"error":"진행 중인 시험은 휴지통으로 이동할 수 없습니다. 일시정지 또는 중단이 끝난 뒤 다시 시도하세요.","code":"run_active"}),
            ),
        ));
    }
    let deleted_at = now();
    storage::move_to_trash(&s, r, &deleted_at)
        .await
        .map_err(bad)?;
    runs.remove(&id);
    let _ = s.events.send(id.clone());
    Ok(Json(json!({"ok":true,"id":id,"deleted_at":deleted_at})))
}
async fn run_restore(State(s): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let _active = s.active.lock().await;
    let mut runs = s.runs.lock().await;
    if runs.contains_key(&id) {
        return Ok(Json(json!({"ok":true,"id":id})));
    }
    let r = storage::restore(&s.db, &id).await.map_err(bad)?;
    runs.insert(id.clone(), r);
    let _ = s.events.send(id.clone());
    Ok(Json(json!({"ok":true,"id":id})))
}
async fn run_get(
    State(s): State<App>,
    Path(id): Path<String>,
    Query(q): Query<BTreeMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let compact = q.get("view").is_some_and(|v| v == "compact");
    let (snapshot, telemetry_count) = {
        let runs = s.runs.lock().await;
        let r = runs.get(&id).ok_or_else(|| bad("실행 없음"))?;
        (if compact { r.compact_snapshot() } else { r.clone() }, r.telemetry.len())
    };
    let value = tokio::task::spawn_blocking(move || {
        if compact {
            let mut v = snapshot.compact();
            v["telemetry_count"] = telemetry_count.into();
            v["telemetry_truncated"] = (telemetry_count > 300).into();
            v
        } else { snapshot.public(false) }
    }).await.map_err(bad)?;
    Ok(Json(value))
}
async fn run_telemetry_get(State(s): State<App>, Path(id): Path<String>, Query(q): Query<BTreeMap<String,String>>) -> ApiResult<Json<Value>> {
    let after=q.get("after").map(|v|v.parse::<usize>()).transpose().map_err(bad)?.unwrap_or(0);
    let (persisted,): (i64,) = sqlx::query_as("SELECT COALESCE(MAX(position)+1,0) FROM run_telemetry WHERE run_id=?")
        .bind(&id).fetch_one(&s.db).await.map_err(bad)?;
    let (tail, total) = {
        let runs = s.runs.lock().await;
        let r = runs.get(&id).ok_or_else(|| bad("실행 없음"))?;
        if persisted as usize > r.telemetry.len() { return Err(bad("장비 기록을 다시 확인하세요.")); }
        if after > r.telemetry.len() { return Err(bad("장비 기록 시작 위치가 범위를 벗어났습니다.")); }
        (r.telemetry[(persisted as usize).max(after)..].to_vec(), r.telemetry.len())
    };
    // Rows are append-only: the persisted prefix and this memory tail form one
    // complete snapshot even if a checkpoint appends more rows while we read.
    let rows: Vec<(String,)> = sqlx::query_as("SELECT body FROM run_telemetry WHERE run_id=? AND position>=? AND position<? ORDER BY position")
        .bind(&id).bind(after as i64).bind(persisted).fetch_all(&s.db).await.map_err(bad)?;
    let value = tokio::task::spawn_blocking(move || -> anyhow::Result<Value> {
        let mut samples=rows.into_iter().map(|(b,)|serde_json::from_str::<Value>(&b)).collect::<Result<Vec<_>,_>>()?;
        samples.extend(tail);
        anyhow::ensure!(samples.len()+after==total,"장비 기록 수가 일치하지 않습니다.");
        Ok(json!({"telemetry":samples,"telemetry_count":total,"after":after}))
    }).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(value))
}
async fn item_get(
    State(s): State<App>,
    Path((id, index)): Path<(String, usize)>,
) -> ApiResult<Json<Value>> {
    let runs = s.runs.lock().await;
    let r = runs.get(&id).ok_or_else(|| bad("실행 없음"))?;
    let item = r.items.get(index).ok_or_else(|| bad("문항 없음"))?;
    let mut v = serde_json::to_value(item).map_err(bad)?;
    v["verdict"] = item.verdict().into();
    if !["done", "error"].contains(&item.status.as_str()) {
        v["task"]["answer"] = Value::Null;
        v["task"]["meta"] = Value::Null;
    }
    for (n, a) in v["attempts"].as_array_mut().unwrap().iter_mut().enumerate() {
        a["metric_quality"] = metrics_quality::evaluate(&item.attempts[n].metrics);
        a["raw"] = Value::Null;
    }
    Ok(Json(v))
}
async fn start_run(State(s): State<App>, Json(mut body): Json<Start>) -> ApiResult<Json<Value>> {
    settings::resolve(&s, &mut body).await.map_err(bad)?;
    preflight::validate(&s, &body).await.map_err(bad)?;
    let mut c = body.config;
    if c.pack_id == "korean-core-v1" {
        return Err(bad(
            "자체 한국어 참고팩은 새 시험에서 제외됐습니다. 기존 실행 기록은 유지됩니다.",
        ));
    }
    if c.name.trim().is_empty() {
        c.name = format!(
            "{} · {}",
            c.model,
            chrono::Local::now().format("%m/%d %H:%M")
        );
    }
    provider::endpoint_for(&c.base_url, &c.api_format).map_err(bad)?;
    if let Some(j) = &c.judge {
        provider::endpoint_for(&j.base_url, &j.api_format).map_err(bad)?;
        if j.model.is_empty() || !(1..=8192).contains(&j.max_tokens) {
            return Err(bad("채점 모델·출력 한도를 확인하세요"));
        }
    }
    if !c.telemetry_url.is_empty() {
        provider::endpoint(&c.telemetry_url).map_err(bad)?;
    }
    if c.model.trim().is_empty()
        || c.name.trim().is_empty()
        || !(1..=8).contains(&c.concurrency)
        || !(1..=32768).contains(&c.max_tokens)
        || !(5..=1800).contains(&c.timeout_s)
        || !c.temperature.is_finite()
        || !(0.0..=2.0).contains(&c.temperature)
    {
        return Err(bad("모델·이름·실행 범위를 확인하세요"));
    }
    if !["quick", "standard", "full"].contains(&c.profile.as_str()) {
        return Err(bad("시험 프로필 오류"));
    }
    let packs = s.packs.lock().await;
    let p = packs
        .get(&c.pack_id)
        .ok_or_else(|| bad("평가팩을 선택하세요"))?;
    let per = match c.profile.as_str() {
        "quick" => 5,
        "standard" => 25,
        _ => usize::MAX,
    };
    let quick_ids = p.sources["quick_ids"].as_array().map(|v| {
        v.iter()
            .filter_map(|v| v.as_str())
            .collect::<std::collections::HashSet<_>>()
    });
    let mut counts = BTreeMap::new();
    let tasks = p
        .tasks
        .iter()
        .filter(|t| c.subjects.is_empty() || c.subjects.contains(&t.subject))
        .filter(|t| {
            if c.profile == "quick" {
                if let Some(ids) = &quick_ids {
                    return ids.contains(t.id.as_str());
                }
            }
            let n = counts.entry(&t.subject).or_insert(0);
            *n += 1;
            *n <= per
        })
        .cloned()
        .collect::<Vec<_>>();
    if tasks.is_empty() {
        return Err(bad("선택 과목에 문항이 없습니다"));
    }
    let pack_version = p.version.clone();
    drop(packs);
    scoring::ensure_ready(&tasks, &c)
        .await
        .map_err(|v| (StatusCode::BAD_REQUEST, Json(v)))?;
    // Admission is per run; other runs continue while readiness is checked.
    let mut active = s.active.lock().await;
    let id = uuid::Uuid::new_v4().to_string();
    let initial_concurrency = Some(c.concurrency);
    let concurrency_tuning = c
        .auto_concurrency
        .then(|| auto_concurrency::Tuning::new(&c, &tasks));
    let run = Run {
        id: id.clone(),
        created_at: now(),
        config: c,
        status: "running".into(),
        suite_hash: digest(&tasks),
        protocol_version: "bench-0.1".into(),
        pack_version,
        provenance: "live_api".into(),
        items: tasks
            .into_iter()
            .map(|task| Item {
                task,
                status: "pending".into(),
                attempts: vec![],
            })
            .collect(),
        telemetry: vec![],
        active_ms: 0.0,
        error: None,
        execution_segments: vec![],
        initial_concurrency,
        concurrency_tuning,
    };
    s.save(&run).await.map_err(bad)?;
    s.runs.lock().await.insert(id.clone(), run);
    s.keys.lock().await.insert(id.clone(), body.api_key);
    s.judge_keys.lock().await.insert(id.clone(), body.judge_key);
    active.insert(id.clone());
    drop(active);
    runtime::launch(s, id.clone());
    Ok(Json(json!({"id":id})))
}
async fn control(
    State(s): State<App>,
    Path((id, action)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    if ["rescore", "resume", "retry"].contains(&action.as_str()) {
        let (config, tasks) = {
            let runs = s.runs.lock().await;
            let r = runs.get(&id).ok_or_else(|| bad("실행 없음"))?;
            let tasks = r
                .items
                .iter()
                .filter(|i| {
                    if action == "rescore" {
                        i.attempts
                            .last()
                            .is_some_and(|a| a.error.is_none() && a.ended_at.is_some())
                    } else {
                        ["pending", "grading"].contains(&i.status.as_str())
                            || action == "retry" && i.status == "error"
                    }
                })
                .map(|i| i.task.clone())
                .collect::<Vec<_>>();
            (r.config.clone(), tasks)
        };
        scoring::ensure_ready(&tasks, &config)
            .await
            .map_err(|v| (StatusCode::BAD_REQUEST, Json(v)))?;
    }
    let mut active = s.active.lock().await;
    let mut runs = s.runs.lock().await;
    let r = runs.get_mut(&id).ok_or_else(|| bad("실행 없음"))?;
    if action == "subject-limit" {
        if active.contains(&id) || r.status != "paused" {
            return Err(bad("현재 문항이 끝나도록 일시정지한 뒤 과목별 제한을 설정하세요."));
        }
        let limit = if body.get("limit").is_some_and(Value::is_null) { None } else {
            Some(body["limit"].as_u64().filter(|n| (1..=100_000).contains(n))
                .ok_or_else(|| bad("limit는 1~100000 또는 null입니다."))? as usize)
        };
        let old = r.config.subject_item_limit;
        r.config.subject_item_limit = limit;
        if let Err(e) = storage::save(&s, r, false).await { r.config.subject_item_limit = old; return Err(bad(e)); }
        return Ok(Json(json!({"ok":true,"subject_item_limit":limit})));
    }
    if action == "auto-concurrency" {
        if active.contains(&id) || r.status != "paused" {
            return Err(bad(
                "현재 문항이 끝나도록 일시정지한 뒤 자동 동시 요청을 설정하세요.",
            ));
        }
        let enabled = body["enabled"]
            .as_bool()
            .ok_or_else(|| bad("enabled를 지정하세요."))?;
        let old = r.clone();
        if enabled {
            let max = body["max_concurrency"]
                .as_u64()
                .filter(|n| (1..=8).contains(n))
                .ok_or_else(|| bad("최대 동시 요청 수는 1~8입니다."))?
                as usize;
            if r.concurrency_tuning.as_ref().is_some_and(|t| t.finished())
                && body["remeasure"] != true
            {
                return Err(bad(
                    "측정 결과가 이미 있습니다. 다시 측정하려면 remeasure: true를 지정하세요.",
                ));
            }
            if r.concurrency_tuning
                .as_ref()
                .is_some_and(|t| !t.finished() && t.max_concurrency != max)
                && body["remeasure"] != true
            {
                return Err(bad(
                    "진행 중인 측정의 상한을 바꾸려면 remeasure: true를 지정하세요.",
                ));
            }
            r.initial_concurrency.get_or_insert(r.config.concurrency);
            r.config.auto_concurrency = true;
            if r.concurrency_tuning.is_none() || body["remeasure"] == true {
                let mut config = r.config.clone();
                config.concurrency = max;
                let mut next = auto_concurrency::Tuning::for_existing(&config, &r.items);
                next.retain_incumbent(r.config.concurrency);
                if let Some(previous) = r.concurrency_tuning.take() {
                    next.previous_measurements.push(previous);
                }
                r.concurrency_tuning = Some(next);
            }
        } else {
            r.config.auto_concurrency = false;
        }
        if let Err(e) = storage::save(&s, r, false).await {
            *r = old;
            return Err(bad(e));
        }
        let _ = s.events.send(id.clone());
        return Ok(Json(
            json!({"ok":true,"auto_concurrency":r.config.auto_concurrency,"concurrency_tuning":r.concurrency_tuning.as_ref().map(|t| t.public(false,true))}),
        ));
    }
    if action == "concurrency" {
        if active.contains(&id) || r.status != "paused" {
            return Err(bad(
                "현재 문항이 끝나도록 일시정지한 뒤 동시 요청 수를 변경하세요.",
            ));
        }
        let n = body["concurrency"]
            .as_u64()
            .filter(|n| (1..=8).contains(n))
            .ok_or_else(|| bad("동시 요청 수는 1~8입니다."))? as usize;
        if n != r.config.concurrency || r.config.auto_concurrency {
            let old = r.clone();
            r.initial_concurrency.get_or_insert(r.config.concurrency);
            r.config.auto_concurrency = false;
            if r.execution_segments.is_empty() {
                r.execution_segments.push(json!({"started_at":r.created_at,"concurrency":r.config.concurrency,"completed_before":0,"reason":"initial"}));
            }
            let completed = r
                .items
                .iter()
                .filter(|i| ["done", "error"].contains(&i.status.as_str()))
                .count();
            r.execution_segments.push(json!({"started_at":now(),"concurrency":n,"completed_before":completed,"reason":"user_change"}));
            r.config.concurrency = n;
            // A settings-only change must not reserialize existing answer or
            // metric rows (including their original floating-point text).
            if let Err(error) = storage::save(&s, r, false).await {
                *r = old;
                return Err(bad(error));
            }
        }
        return Ok(Json(
            json!({"ok":true,"concurrency":r.config.concurrency,"execution_segments":r.execution_segments}),
        ));
    }
    if action == "rescore"
        && !active.contains(&id)
        && !["running", "pausing", "cancelling", "scoring"].contains(&r.status.as_str())
    {
        if let Some(key) = body["judge_key"].as_str() {
            s.judge_keys.lock().await.insert(id.clone(), key.into());
        }
        settings::restore_keys(&s, &id, &r.config, false)
            .await
            .map_err(bad)?;
        let previous = r.status.clone();
        r.status = "scoring".into();
        if let Err(error) = storage::save(&s, r, false).await {
            r.status = previous;
            return Err(bad(error));
        }
        // The worker is launched only after the durable transition succeeds.
        active.insert(id.clone());
        drop(runs);
        drop(active);
        runtime::rescore(s, id, previous);
        return Ok(Json(json!({"ok":true})));
    }
    let previous_status = r.status.clone();
    match action.as_str() {
        "pause" if r.status == "running" => r.status = "pausing".into(),
        "cancel" if ["running", "pausing"].contains(&r.status.as_str()) => {
            r.status = "cancelling".into()
        }
        "resume" | "retry"
            if !active.contains(&id)
                && !["running", "pausing", "cancelling"].contains(&r.status.as_str()) =>
        {
            if let Some(key) = body["api_key"].as_str() {
                s.keys.lock().await.insert(id.clone(), key.into());
            }
            if let Some(key) = body["judge_key"].as_str() {
                s.judge_keys.lock().await.insert(id.clone(), key.into());
            }
            settings::restore_keys(&s, &id, &r.config, true)
                .await
                .map_err(bad)?;
            if !s.keys.lock().await.contains_key(&id) {
                return Err(bad(
                    "재시작 후 API 키를 다시 입력하세요. 인증이 없는 서버는 빈 값으로 제출하세요",
                ));
            }
            let previous_items = r.items.iter().map(|i| i.status.clone()).collect::<Vec<_>>();
            let previous_error = r.error.clone();
            let previous_dirty = s.dirty.lock().await.get(&id).cloned();
            let mut changed = Vec::new();
            for (index, i) in r.items.iter_mut().enumerate() {
                if action == "retry" && i.status == "error" {
                    i.status = "pending".into();
                    changed.push(index);
                }
            }
            if !r
                .items
                .iter()
                .any(|i| ["pending", "grading"].contains(&i.status.as_str()))
            {
                return Err(bad("실행할 문항이 없습니다"));
            }
            r.status = "running".into();
            r.error = None;
            if !changed.is_empty() {
                s.dirty
                    .lock()
                    .await
                    .entry(id.clone())
                    .or_default()
                    .extend(changed);
            }
            if let Err(error) = storage::save(&s, r, false).await {
                r.status = previous_status;
                r.error = previous_error;
                for (item, status) in r.items.iter_mut().zip(previous_items) {
                    item.status = status;
                }
                let mut dirty = s.dirty.lock().await;
                if let Some(previous_dirty) = previous_dirty {
                    dirty.insert(id.clone(), previous_dirty);
                } else {
                    dirty.remove(&id);
                }
                return Err(bad(error));
            }
            active.insert(id.clone());
            drop(runs);
            drop(active);
            runtime::launch(s, id.clone());
            return Ok(Json(json!({"ok":true})));
        }
        _ => return Err(bad("현재 상태에서는 실행할 수 없습니다")),
    }
    if let Err(error) = storage::save(&s, r, false).await {
        r.status = previous_status;
        return Err(bad(error));
    }
    Ok(Json(json!({"ok":true})))
}
async fn import_run(State(s): State<App>, Json(mut r): Json<Run>) -> ApiResult<Json<Value>> {
    if !["completed", "cancelled", "paused", "interrupted"].contains(&r.status.as_str())
        || r.items.len() > 100000
        || r.items.is_empty()
    {
        return Err(bad("가져올 실행 상태·문항을 확인하세요"));
    }
    if r.items.iter().any(|i| i.status == "running") {
        return Err(bad("실행 중인 문항은 가져올 수 없습니다"));
    }
    r.config.connection_id.clear();
    r.config.judge_connection_id.clear();
    r.config.device_id.clear();
    r.config.device_name.clear();
    r.config.device = None;
    r.id = uuid::Uuid::new_v4().to_string();
    r.provenance = "imported_record".into();
    r.suite_hash = digest(&r.items.iter().map(|i| i.task.clone()).collect::<Vec<_>>());
    scoring::upgrade_experience_scores(&mut r);
    let id = r.id.clone();
    s.save(&r).await.map_err(bad)?;
    s.runs.lock().await.insert(id.clone(), r);
    Ok(Json(json!({"id":id})))
}
async fn artifact_save(
    State(s): State<App>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Json<Value>> {
    let ext = match headers.get("content-type").and_then(|h| h.to_str().ok()) {
        Some("image/png") if body.starts_with(b"\x89PNG\r\n\x1a\n") => "png",
        Some("image/svg+xml") if body.starts_with(b"<svg ") => "svg",
        Some("text/html") | Some("text/html;charset=utf-8")
            if body.starts_with(b"<!doctype html>") =>
        {
            "html"
        }
        _ => return Err(bad("보고서 파일 형식 오류")),
    };
    let id = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let dir = std::path::Path::new(&s.data_dir).join("reports");
    tokio::fs::create_dir_all(&dir).await.map_err(bad)?;
    tokio::fs::write(dir.join(&id), &body).await.map_err(bad)?;
    Ok(Json(json!({"url":format!("/api/artifacts/{id}")})))
}
async fn artifact_get(
    State(s): State<App>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let (stem, ext) = id.rsplit_once('.').ok_or_else(|| bad("보고서 ID 오류"))?;
    uuid::Uuid::parse_str(stem).map_err(bad)?;
    if !["png", "svg", "html"].contains(&ext) {
        return Err(bad("보고서 형식 오류"));
    }
    let bytes = tokio::fs::read(std::path::Path::new(&s.data_dir).join("reports").join(&id))
        .await
        .map_err(bad)?;
    let mut h = HeaderMap::new();
    h.insert(
        "content-type",
        if ext == "png" {
            "image/png"
        } else if ext == "html" {
            "text/html; charset=utf-8"
        } else {
            "image/svg+xml"
        }
        .parse()
        .unwrap(),
    );
    h.insert(
        "content-disposition",
        format!("attachment; filename=bench-{id}").parse().unwrap(),
    );
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    Ok((h, bytes))
}
async fn event_stream(
    State(s): State<App>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let mut rx = s.events.subscribe();
    Sse::new(async_stream::stream!{yield Ok(Event::default().data("ready"));loop{match rx.recv().await{Ok(id)=>yield Ok(Event::default().data(id)),Err(broadcast::error::RecvError::Lagged(_))=>yield Ok(Event::default().data("refresh")),Err(_)=>break}}}).keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
}
async fn check(Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let base = b["base_url"].as_str().unwrap_or("");
    let ep = provider::endpoint(base).map_err(bad)?;
    let url = ep.trim_end_matches("/chat/completions").to_string() + "/models";
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(bad)?;
    let mut q = client.get(url);
    if let Some(k) = b["api_key"].as_str().filter(|k| !k.is_empty()) {
        q = q.bearer_auth(k)
    }
    let res = q
        .send()
        .await
        .map_err(|_| bad("API 연결 실패: 주소와 서버 상태를 확인하세요"))?;
    if !res.status().is_success() {
        return Err(bad(format!("모델 목록 HTTP {}", res.status())));
    }
    let j: Value = res.json().await.map_err(bad)?;
    Ok(Json(
        json!({"models":j["data"],"scope":"모델 목록 연결 확인 · 스트리밍/샘플링 지원은 첫 실제 요청에서 확인"}),
    ))
}
async fn compare(
    State(s): State<App>,
    Path((a, b)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let runs = s.runs.lock().await;
    Ok(Json(report::compare(
        runs.get(&a).ok_or_else(|| bad("기준 없음"))?,
        runs.get(&b).ok_or_else(|| bad("실행 없음"))?,
    )))
}
async fn export(
    State(s): State<App>,
    Path(id): Path<String>,
) -> ApiResult<(HeaderMap, Json<Value>)> {
    let runs = s.runs.lock().await;
    let r = runs.get(&id).ok_or_else(|| bad("실행 없음"))?;
    let mut h = HeaderMap::new();
    h.insert(
        "content-disposition",
        format!("attachment; filename=bench-{id}.json")
            .parse()
            .unwrap(),
    );
    Ok((h, Json(r.public(true))))
}
async fn html_report(State(s): State<App>, Path(id): Path<String>) -> ApiResult<Html<String>> {
    let runs = s.runs.lock().await;
    Ok(Html(report::html(
        runs.get(&id).ok_or_else(|| bad("실행 없음"))?,
    )))
}

// Runs before the listener starts. A persistence failure aborts startup instead
// of exposing an in-memory-only result, and v2 records are never written again.
async fn upgrade_performance_records(s: &App) -> anyhow::Result<()> {
    let mut runs = s.runs.lock().await;
    for run in runs.values_mut() {
        if scoring::upgrade_experience_scores(run) > 0 {
            s.save(run).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod performance_upgrade_tests {
    use super::*;

    async fn app_with_run() -> App {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE runs(id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        storage::init(&db).await.unwrap();
        let (events, _) = broadcast::channel(32);
        let s = App {
            data_dir: "/nonexistent-no-credentials-required".into(),
            preflights: Default::default(),
            db,
            runs: Arc::new(Mutex::new(BTreeMap::new())),
            packs: Arc::new(Mutex::new(BTreeMap::new())),
            keys: Arc::new(Mutex::new(BTreeMap::new())),
            judge_keys: Arc::new(Mutex::new(BTreeMap::new())),
            active: Default::default(),
            events,
            settings_lock: Arc::new(Mutex::new(())),
            dirty: Arc::new(Mutex::new(BTreeMap::new())),
        };
        let attempt = json!({"started_at":"2026-11-06T00:00:00Z","ended_at":"2026-11-06T00:00:02Z",
            "output":"```python\nclass Cache:\n def get(self, key): pass\n def put(self, key, value): pass\n```",
            "reasoning":"original reasoning", "finish_reason":"stop", "error":null,
            "metrics":{"ttft_ms":250,"wall_ms":2000,"output_tokens":75,"visible_output_tokens":75,
                "decode_tps":60,"client_visible_decode_tps":50,"measurement_version":"client-visible-v1","ttft_source":"client_visible_stream",
                "decode_source":"server","prefill_source":"unavailable"},
            "score":{"value":null,"state":"measured","detail":"original fence failure","scorer_version":"api-experience-v1","extra":{"valid_output":false}},
            "raw":[{"kind":"request","body":{"model":"fixture"}},{"original":"response frames"}]});
        let perf = json!({"task":{"id":"experience:code:1","subject":"performance","prompt":"fixed prompt","answer":null,"scorer":"experience","max_tokens":4096,"meta":{"experience_case":"code","performance_protocol":"api-experience-v1"}},"status":"done","attempts":[attempt]});
        let mut quality = perf.clone();
        quality["task"]["id"] = "judge:quality".into();
        quality["task"]["scorer"] = "judge".into();
        quality["attempts"][0]["score"] = json!({"value":1.0,"state":"scored","detail":"must remain unchanged","scorer_version":"fixture","extra":{"evidence":"original"}});
        let r: Run = serde_json::from_value(json!({"id":"fixture","created_at":now(),"config":{
            "name":"fixture","base_url":"http://127.0.0.1:1/v1","model":"never-call","pack_id":"fixture","profile":"quick",
            "temperature":0.0,"max_tokens":4096,"concurrency":1,"timeout_s":1,
            "judge_connection_id":"deleted-judge-connection","judge":{"base_url":"http://127.0.0.1:1/v1","model":"never-call-judge","max_tokens":1}
        },"status":"completed","suite_hash":"original-suite","protocol_version":"fixture","pack_version":"fixture","provenance":"fixture",
        "items":[perf,quality],"telemetry":[{"cpu_pct":12}],"active_ms":2000,"error":null})).unwrap();
        s.save(&r).await.unwrap();
        s.runs.lock().await.insert(r.id.clone(), r);
        s
    }

    #[tokio::test]
    async fn performance_upgrade_is_offline_scoped_idempotent_and_preserves_measurements() {
        let s = app_with_run().await;
        let before = s.runs.lock().await["fixture"].clone();
        upgrade_performance_records(&s).await.unwrap();
        let after = s.runs.lock().await["fixture"].clone();
        assert_eq!(after.status, "completed");
        assert_eq!(
            serde_json::to_value(&after.items[1]).unwrap(),
            serde_json::to_value(&before.items[1]).unwrap()
        );
        assert_eq!(after.telemetry, before.telemetry);
        assert!(after.config == before.config);
        assert_eq!(after.active_ms, before.active_ms);
        let a = &after.items[0].attempts[0];
        let old = &before.items[0].attempts[0];
        let mut a_raw = serde_json::to_value(a).unwrap();
        let mut old_raw = serde_json::to_value(old).unwrap();
        a_raw.as_object_mut().unwrap().remove("score");
        old_raw.as_object_mut().unwrap().remove("score");
        assert_eq!(a_raw, old_raw);
        let score = a.score.as_ref().unwrap();
        assert_eq!(score.scorer_version, "api-experience-output-v2");
        assert_eq!(score.extra["valid_output"], true);
        assert_eq!(score.extra["format_compliant"], false);
        assert_eq!(
            score.extra["grading_history"][0]["score"]["extra"]["valid_output"],
            false
        );
        let compact = after.compact();
        assert_eq!(
            compact["items"][0]["attempts"][0]["score"]["extra"]["presentation_wrapper"],
            "markdown_fence"
        );
        assert_eq!(
            compact["items"][0]["attempts"][0]["score"]["extra"]["format_compliant"],
            false
        );
        assert!(s.keys.lock().await.is_empty() && s.judge_keys.lock().await.is_empty());
        let mut loaded = after.clone();
        loaded.items.clear();
        storage::load_items(&s.db, &mut loaded).await.unwrap();
        assert_eq!(
            serde_json::to_value(&loaded.items).unwrap(),
            serde_json::to_value(&after.items).unwrap()
        );
        upgrade_performance_records(&s).await.unwrap();
        assert_eq!(
            serde_json::to_value(&s.runs.lock().await["fixture"]).unwrap(),
            serde_json::to_value(&after).unwrap()
        );
    }
}
