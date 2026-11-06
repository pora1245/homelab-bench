//! Local connection profiles. Credentials never enter run exports or API responses.
use crate::{ApiResult, App, bad, provider, types::*};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Defaults {
    pub temperature: f64,
    pub max_tokens: u32,
    pub concurrency: usize,
    pub timeout_s: u64,
    #[serde(default)]
    pub reasoning_effort: String,
}
impl Default for Defaults {
    fn default() -> Self {
        Self {
            temperature: 0.,
            max_tokens: 4096,
            concurrency: 1,
            timeout_s: 180,
            reasoning_effort: String::new(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Connection {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    #[serde(default = "default_api_format")]
    pub api_format: String,
    pub model: String,
    #[serde(default)]
    pub has_key: bool,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub defaults: Defaults,
    #[serde(default)]
    pub execution_info: crate::types::ExecutionInfo,
    #[serde(default)]
    pub device_id: String,
}
#[derive(Deserialize)]
pub struct ConnectionWrite {
    #[serde(flatten)]
    pub profile: Connection,
    pub api_key: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Device {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub mode: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub gpu_indices: Vec<u32>,
    #[serde(default)]
    pub include_offload: bool,
    #[serde(default)]
    pub has_key: bool,
}
#[derive(Deserialize)]
pub struct DeviceWrite {
    #[serde(flatten)]
    pub profile: Device,
    pub api_key: Option<String>,
}

pub async fn init(s: &App) -> anyhow::Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS settings(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL, PRIMARY KEY(kind,id))").execute(&s.db).await?;
    if list::<Device>(s, "device").await?.is_empty() {
        let d = Device {
            id: "local".into(),
            name: if cfg!(target_os = "macos") {
                "이 Mac"
            } else if cfg!(target_os = "windows") {
                "이 PC"
            } else {
                "로컬 장비"
            }
            .into(),
            mode: "local".into(),
            url: String::new(),
            host: String::new(),
            is_default: true,
            gpu_indices: vec![],
            include_offload: false,
            has_key: false,
        };
        put(s, "device", &d.id, &d).await?;
    }
    Ok(())
}
async fn list<T: serde::de::DeserializeOwned>(s: &App, kind: &str) -> anyhow::Result<Vec<T>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT body FROM settings WHERE kind=? ORDER BY id")
        .bind(kind)
        .fetch_all(&s.db)
        .await?;
    rows.into_iter()
        .map(|(b,)| Ok(serde_json::from_str(&b)?))
        .collect()
}
async fn get<T: serde::de::DeserializeOwned>(s: &App, kind: &str, id: &str) -> anyhow::Result<T> {
    let row: Option<(String,)> = sqlx::query_as("SELECT body FROM settings WHERE kind=? AND id=?")
        .bind(kind)
        .bind(id)
        .fetch_optional(&s.db)
        .await?;
    Ok(serde_json::from_str(
        &row.ok_or_else(|| anyhow::anyhow!("저장된 연결을 찾을 수 없습니다"))?
            .0,
    )?)
}
async fn put(s: &App, kind: &str, id: &str, v: &impl Serialize) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO settings(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body").bind(kind).bind(id).bind(serde_json::to_string(v)?).execute(&s.db).await?;
    Ok(())
}
async fn secrets(s: &App) -> anyhow::Result<BTreeMap<String, String>> {
    let p = std::path::Path::new(&s.data_dir).join("credentials.json");
    match tokio::fs::read(p).await {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.into()),
    }
}
async fn write_secrets(s: &App, v: &BTreeMap<String, String>) -> anyhow::Result<()> {
    // The temporary file is created private, before writing any credential bytes.
    use std::io::Write;
    let p = std::path::Path::new(&s.data_dir).join("credentials.json");
    let temp = p.with_extension("tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&temp)?;
    f.write_all(&serde_json::to_vec(v)?)?;
    f.sync_all()?;
    std::fs::rename(temp, p)?;
    Ok(())
}
pub async fn connections(State(s): State<App>) -> ApiResult<Json<Value>> {
    let _lock = s.settings_lock.lock().await;
    let keys = secrets(&s).await.map_err(bad)?;
    let mut items = list::<Connection>(&s, "connection").await.map_err(bad)?;
    for c in &mut items {
        c.has_key = keys.get(&c.id).is_some_and(|v| !v.is_empty());
    }
    Ok(Json(json!(items)))
}
pub async fn connection_write(
    State(s): State<App>,
    Json(body): Json<ConnectionWrite>,
) -> ApiResult<Json<Value>> {
    let _lock = s.settings_lock.lock().await;
    let mut c = body.profile;
    if c.name.trim().is_empty()
        || c.model.trim().is_empty()
        || !["target", "judge"].contains(&c.kind.as_str())
    {
        return Err(bad("연결 이름·용도·모델을 확인하세요"));
    }
    provider::endpoint_for(&c.base_url, &c.api_format).map_err(bad)?;
    if !(1..=8).contains(&c.defaults.concurrency)
        || !(1..=32768).contains(&c.defaults.max_tokens)
        || !(5..=1800).contains(&c.defaults.timeout_s)
        || !(0.0..=2.0).contains(&c.defaults.temperature)
    {
        return Err(bad("연결 기본 실행 범위를 확인하세요"));
    }
    let previous = list::<Connection>(&s, "connection").await.map_err(bad)?;
    if c.id.is_empty() {
        c.id = uuid::Uuid::new_v4().to_string()
    } else if !previous.iter().any(|p| p.id == c.id && p.kind == c.kind) {
        return Err(bad("수정할 연결의 ID·용도를 확인하세요"));
    }
    if !previous
        .iter()
        .any(|p| p.kind == c.kind && p.is_default && p.id != c.id)
    {
        c.is_default = true
    }
    let mut keys = secrets(&s).await.map_err(bad)?;
    if let Some(key) = body.api_key {
        if key.is_empty() {
            keys.remove(&c.id);
        } else {
            keys.insert(c.id.clone(), key);
        }
        write_secrets(&s, &keys).await.map_err(bad)?;
    }
    c.has_key = keys.get(&c.id).is_some_and(|v| !v.is_empty());
    for mut p in previous {
        if c.is_default && p.kind == c.kind && p.id != c.id && p.is_default {
            p.is_default = false;
            put(&s, "connection", &p.id, &p).await.map_err(bad)?;
        }
    }
    put(&s, "connection", &c.id, &c).await.map_err(bad)?;
    Ok(Json(json!(c)))
}
pub async fn connection_action(
    State(s): State<App>,
    Path((id, action)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let _lock = s.settings_lock.lock().await;
    let c: Connection = get(&s, "connection", &id).await.map_err(bad)?;
    match action.as_str() {
        "check" => {
            let keys = secrets(&s).await.map_err(bad)?;
            let endpoint = provider::endpoint_for(&c.base_url, &c.api_format).map_err(bad)?;
            let root = endpoint
                .strip_suffix("/chat/completions")
                .or_else(|| endpoint.strip_suffix("/responses"))
                .ok_or_else(|| bad("API 주소 형식을 확인하세요"))?;
            let url = format!("{root}/models");
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(8))
                .build()
                .map_err(bad)?;
            let mut req = client.get(url);
            if let Some(k) = keys.get(&id) {
                req = req.bearer_auth(k)
            }
            let result = req.send().await;
            let v = match result {
                Ok(r) if r.status().is_success() => match r.json::<Value>().await {
                    Ok(v) => json!({"ok":true,"models":v["data"],"checked_at":now()}),
                    Err(_) => json!({"ok":false,"error":"모델 목록 응답을 읽을 수 없습니다"}),
                },
                Ok(r) => {
                    json!({"ok":false,"error":format!("연결 응답 HTTP {}",r.status().as_u16())})
                }
                Err(e) if e.is_timeout() => json!({"ok":false,"error":"API 응답 시간 초과 (8초)"}),
                Err(e) if e.is_connect() => {
                    json!({"ok":false,"error":"API 주소 연결 실패: 주소·실행 상태를 확인하세요"})
                }
                Err(_) => json!({"ok":false,"error":"API 통신 실패: 연결 설정을 확인하세요"}),
            };
            Ok(Json(v))
        }
        "default" => {
            for mut p in list::<Connection>(&s, "connection").await.map_err(bad)? {
                if p.kind == c.kind {
                    p.is_default = p.id == id;
                    put(&s, "connection", &p.id, &p).await.map_err(bad)?;
                }
            }
            Ok(Json(json!({"ok":true})))
        }
        "delete" => {
            sqlx::query("DELETE FROM settings WHERE kind='connection' AND id=?")
                .bind(&id)
                .execute(&s.db)
                .await
                .map_err(bad)?;
            let mut keys = secrets(&s).await.map_err(bad)?;
            keys.remove(&id);
            write_secrets(&s, &keys).await.map_err(bad)?;
            if c.is_default {
                if let Some(mut p) = list::<Connection>(&s, "connection")
                    .await
                    .map_err(bad)?
                    .into_iter()
                    .find(|x| x.kind == c.kind)
                {
                    p.is_default = true;
                    put(&s, "connection", &p.id, &p).await.map_err(bad)?;
                }
            }
            Ok(Json(json!({"ok":true})))
        }
        _ => Err(bad("지원하지 않는 연결 작업")),
    }
}
pub async fn devices(State(s): State<App>) -> ApiResult<Json<Value>> {
    let _lock = s.settings_lock.lock().await;
    let keys = secrets(&s).await.map_err(bad)?;
    let mut items = list::<Device>(&s, "device").await.map_err(bad)?;
    for d in &mut items {
        d.has_key = keys
            .get(&device_key_id(&d.id))
            .is_some_and(|v| !v.is_empty());
    }
    Ok(Json(json!(items)))
}
pub async fn device_write(
    State(s): State<App>,
    Json(body): Json<DeviceWrite>,
) -> ApiResult<Json<Value>> {
    let _lock = s.settings_lock.lock().await;
    let mut d = body.profile;
    if d.name.trim().is_empty() || !["local", "http", "ssh"].contains(&d.mode.as_str()) {
        return Err(bad("장비 이름·연결 방식을 확인하세요"));
    }
    if d.gpu_indices.len() > 32 || d.gpu_indices.iter().any(|i| *i > 1023) {
        return Err(bad("선택 GPU 번호 범위를 확인하세요"));
    }
    d.gpu_indices.sort_unstable();
    d.gpu_indices.dedup();
    if d.mode == "http" {
        provider::endpoint(&d.url).map_err(bad)?;
    }
    if d.mode == "ssh" {
        validate_host(&d.host).map_err(bad)?;
    }
    let previous = list::<Device>(&s, "device").await.map_err(bad)?;
    if d.id.is_empty() {
        d.id = uuid::Uuid::new_v4().to_string()
    } else if !previous.iter().any(|p| p.id == d.id) {
        return Err(bad("수정할 장비 ID를 확인하세요"));
    }
    if !previous.iter().any(|p| p.is_default && p.id != d.id) {
        d.is_default = true
    }
    let mut keys = secrets(&s).await.map_err(bad)?;
    let key_id = device_key_id(&d.id);
    // Changing destinations must not forward an old token to a new endpoint.
    let destination_changed = previous
        .iter()
        .find(|p| p.id == d.id)
        .is_some_and(|p| p.mode != d.mode || p.url != d.url);
    if destination_changed || d.mode != "http" {
        keys.remove(&key_id);
    }
    if let Some(key) = body.api_key {
        if key.is_empty() {
            keys.remove(&key_id);
        } else {
            if d.mode != "http" {
                return Err(bad("수집기 인증 토큰은 HTTP 연결에만 저장할 수 있습니다"));
            }
            crate::runtime::validate_agent_token(&key).map_err(bad)?;
            keys.insert(key_id.clone(), key);
        }
    }
    d.has_key = keys.get(&key_id).is_some_and(|v| !v.is_empty());
    write_secrets(&s, &keys).await.map_err(bad)?;
    for mut p in previous {
        if d.is_default && p.id != d.id && p.is_default {
            p.is_default = false;
            put(&s, "device", &p.id, &p).await.map_err(bad)?;
        }
    }
    put(&s, "device", &d.id, &d).await.map_err(bad)?;
    Ok(Json(json!(d)))
}
pub async fn device_action(
    State(s): State<App>,
    Path((id, action)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let lock = s.settings_lock.lock().await;
    let d: Device = get(&s, "device", &id).await.map_err(bad)?;
    if action == "check" {
        drop(lock);
        return Ok(Json(sample(&s, &d).await));
    }
    match action.as_str() {
        "default" => {
            for mut p in list::<Device>(&s, "device").await.map_err(bad)? {
                p.is_default = p.id == id;
                put(&s, "device", &p.id, &p).await.map_err(bad)?;
            }
            Ok(Json(json!({"ok":true})))
        }
        "delete" => {
            let mut keys = secrets(&s).await.map_err(bad)?;
            keys.remove(&device_key_id(&id));
            write_secrets(&s, &keys).await.map_err(bad)?;
            sqlx::query("DELETE FROM settings WHERE kind='device' AND id=?")
                .bind(id)
                .execute(&s.db)
                .await
                .map_err(bad)?;
            if d.is_default {
                if let Some(mut p) = list::<Device>(&s, "device")
                    .await
                    .map_err(bad)?
                    .into_iter()
                    .next()
                {
                    p.is_default = true;
                    put(&s, "device", &p.id, &p).await.map_err(bad)?;
                }
            }
            Ok(Json(json!({"ok":true})))
        }
        _ => Err(bad("지원하지 않는 장비 작업")),
    }
}
pub async fn device_sample(State(s): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let d: Device = get(&s, "device", &id).await.map_err(bad)?;
    Ok(Json(sample(&s, &d).await))
}
fn validate_host(host: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !host.is_empty()
            && host.len() < 254
            && !host.starts_with('-')
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-@:".contains(c)),
        "SSH 호스트 또는 저장된 별칭을 확인하세요"
    );
    Ok(())
}
pub async fn resolve(s: &App, b: &mut Start) -> anyhow::Result<()> {
    let _lock = s.settings_lock.lock().await;
    let keys = secrets(s).await?;
    let id = if b.connection_id.is_empty() {
        b.config.connection_id.clone()
    } else {
        b.connection_id.clone()
    };
    let mut connection_device_id = String::new();
    if !id.is_empty() {
        let c: Connection = get(s, "connection", &id).await?;
        anyhow::ensure!(c.kind == "target", "시험 API 연결이 아닙니다");
        connection_device_id = c.device_id.clone();
        b.config.execution_info = c.execution_info.clone();
        b.config.api_format = c.api_format;
        b.config.base_url = c.base_url;
        b.config.model = c.model;
        b.config.connection_id = id.clone();
        b.api_key = keys.get(&id).cloned().unwrap_or_default();
    }
    let id = if b.judge_connection_id.is_empty() {
        b.config.judge_connection_id.clone()
    } else {
        b.judge_connection_id.clone()
    };
    if !id.is_empty() {
        let c: Connection = get(s, "connection", &id).await?;
        anyhow::ensure!(c.kind == "judge", "채점 API 연결이 아닙니다");
        b.config.judge = Some(JudgeConfig {
            api_format: c.api_format,
            base_url: c.base_url,
            model: c.model,
            max_tokens: c.defaults.max_tokens.min(8192),
        });
        b.config.judge_connection_id = id.clone();
        b.judge_key = keys.get(&id).cloned().unwrap_or_default();
    }
    // Omitted top-level device_id uses the explicitly saved connection default.
    // Explicit null/empty means no telemetry, including for current web clients.
    let id = match &b.device_id {
        Some(id) => id.clone(),
        None if !b.config.device_id.is_empty() => b.config.device_id.clone(),
        None => connection_device_id,
    };
    if !id.is_empty() {
        let d: Device = get(s, "device", &id).await?;
        b.config.device_id = id;
        b.config.device_name = d.name.clone();
        b.config.device = Some(d);
        b.config.telemetry_url.clear();
    } else {
        b.config.device_id.clear();
        b.config.device = None;
        b.config.device_name.clear();
        if b.device_id.is_some() {
            b.config.telemetry_url.clear();
        }
    }
    Ok(())
}
pub async fn restore_keys(s: &App, id: &str, c: &Config, target: bool) -> anyhow::Result<()> {
    let keys = secrets(s).await?;
    if target && !c.connection_id.is_empty() && !s.keys.lock().await.contains_key(id) {
        let saved: Connection = get(s, "connection", &c.connection_id).await?;
        anyhow::ensure!(
            saved.kind == "target"
                && saved.base_url == c.base_url
                && saved.model == c.model
                && saved.api_format == c.api_format,
            "저장된 시험 연결이 변경되었습니다. 실행의 원래 주소를 확인하고 키를 지정해 재개하세요"
        );
        s.keys.lock().await.insert(
            id.into(),
            keys.get(&c.connection_id).cloned().unwrap_or_default(),
        );
    }
    if !c.judge_connection_id.is_empty() && !s.judge_keys.lock().await.contains_key(id) {
        let saved: Connection = get(s, "connection", &c.judge_connection_id).await?;
        anyhow::ensure!(
            saved.kind == "judge"
                && c.judge
                    .as_ref()
                    .is_some_and(|j| j.base_url == saved.base_url
                        && j.model == saved.model
                        && j.api_format == saved.api_format),
            "저장된 채점 연결이 변경되었습니다. 원래 주소를 확인하고 키를 지정해 주세요"
        );
        s.judge_keys.lock().await.insert(
            id.into(),
            keys.get(&c.judge_connection_id)
                .cloned()
                .unwrap_or_default(),
        );
    }
    Ok(())
}

fn device_key_id(id: &str) -> String {
    format!("device:{id}")
}

async fn device_token(s: &App, snapshot: &Device) -> anyhow::Result<Option<String>> {
    let _lock = s.settings_lock.lock().await;
    let saved: Device = get(s, "device", &snapshot.id).await?;
    anyhow::ensure!(
        saved.mode == "http" && snapshot.mode == "http" && saved.url == snapshot.url,
        "저장된 장비 연결이 변경되어 인증 토큰을 전송하지 않았습니다"
    );
    Ok(secrets(s).await?.get(&device_key_id(&snapshot.id)).cloned())
}

pub async fn sample(s: &App, d: &Device) -> Value {
    let result = tokio::time::timeout(Duration::from_secs(7), read_sample(s, d)).await;
    let result = match result {
        Ok(v) => v,
        Err(_) => Err(anyhow::anyhow!("장비 응답 시간 초과")),
    };
    match result {
        Ok(v) => {
            let v = crate::telemetry::normalize(v, d);
            let age = v["timestamp"]
                .as_str()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_milliseconds());
            let fresh = age.is_some_and(|n| (-5000..=15000).contains(&n));
            let missing = v["gpu_selection"]["missing_indices"]
                .as_array()
                .is_some_and(|a| !a.is_empty());
            json!({"ok":fresh && !missing,"status":if !fresh{"stale"}else if missing{"partial"}else{"connected"},"data":v,"checked_at":now(),"age_ms":age,"error":if !fresh{json!("장비 시각이 없거나 오래된 자료입니다")}else if missing{json!("선택한 GPU 일부를 찾을 수 없습니다")}else{Value::Null}})
        }
        Err(_) => {
            json!({"ok":false,"status":"unavailable","checked_at":now(),"error":"장비에 연결할 수 없습니다. 주소·SSH 인증·수집기 상태를 확인하세요"})
        }
    }
}
async fn read_sample(s: &App, d: &Device) -> anyhow::Result<Value> {
    match d.mode.as_str() {
        "local" => crate::telemetry::local_sample(d.include_offload).await,
        "http" => {
            provider::endpoint(&d.url)?;
            let token = device_token(s, d).await?;
            let c = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?;
            let mut request = c.get(&d.url);
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            Ok(request
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await?)
        }
        "ssh" => {
            validate_host(&d.host)?;
            let script = crate::telemetry::linux_script(d.include_offload);
            let out = tokio::process::Command::new("ssh")
                .kill_on_drop(true)
                .args([
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=4",
                    "-o",
                    "ServerAliveInterval=2",
                    "-o",
                    "ServerAliveCountMax=1",
                    "--",
                    &d.host,
                    &script,
                ])
                .output()
                .await?;
            anyhow::ensure!(out.status.success(), "SSH 연결 실패");
            crate::telemetry::parse_linux(&String::from_utf8(out.stdout)?, d.include_offload)
        }
        _ => anyhow::bail!("장비 연결 방식 오류"),
    }
}
#[derive(Deserialize)]
pub struct ReadinessQuery {
    scorers: Option<String>,
}
pub async fn readiness(Query(query): Query<ReadinessQuery>) -> ApiResult<Json<Value>> {
    const ALLOWED: &[&str] = &[
        "numeric",
        "choice",
        "exact",
        "json",
        "experience",
        "bbh",
        "ifeval",
        "math",
        "humaneval",
        "mbpp",
        "livecodebench",
    ];
    let names = query
        .scorers
        .unwrap_or_else(|| "ifeval,math,humaneval,mbpp,livecodebench".into())
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if names.iter().any(|name| !ALLOWED.contains(&name.as_str())) {
        return Err(bad("알 수 없는 채점기입니다"));
    }
    Ok(Json(crate::scoring::readiness(&names, None).await))
}

#[cfg(test)]
mod device_auth_tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::{Mutex, broadcast};

    async fn fixture() -> App {
        let dir =
            std::env::temp_dir().join(format!("llm-bench-device-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&dir).await.unwrap();
        let app = App {
            data_dir: dir.to_string_lossy().into(),
            db: sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap(),
            runs: Arc::new(Mutex::new(BTreeMap::new())),
            packs: Arc::new(Mutex::new(BTreeMap::new())),
            keys: Arc::new(Mutex::new(BTreeMap::new())),
            judge_keys: Arc::new(Mutex::new(BTreeMap::new())),
            active: Arc::new(Mutex::new(None)),
            events: broadcast::channel(8).0,
            settings_lock: Arc::new(Mutex::new(())),
            dirty: Arc::new(Mutex::new(BTreeMap::new())),
        };
        init(&app).await.unwrap();
        app
    }
    const TOKEN: &str = "fixture-device-token-01234567890123456789";

    #[tokio::test]
    async fn device_secrets_are_private_destination_bound_and_removed_on_change() {
        let s = fixture().await;
        let body = json!({"name":"fixture","mode":"http","url":"http://127.0.0.1:1/metrics","api_key":TOKEN});
        let Json(saved) = device_write(
            State(s.clone()),
            Json(serde_json::from_value(body).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(saved["has_key"], true);
        assert!(!saved.to_string().contains(TOKEN));
        let d: Device = serde_json::from_value(saved).unwrap();
        assert_eq!(
            secrets(&s)
                .await
                .unwrap()
                .get(&device_key_id(&d.id))
                .unwrap(),
            TOKEN
        );
        assert_eq!(device_token(&s, &d).await.unwrap().as_deref(), Some(TOKEN));
        let mut stale = d.clone();
        stale.url = "http://127.0.0.1:2/metrics".into();
        assert!(device_token(&s, &stale).await.is_err());
        let Json(changed) = device_write(
            State(s.clone()),
            Json(DeviceWrite {
                profile: stale,
                api_key: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(changed["has_key"], false);
        assert!(
            secrets(&s)
                .await
                .unwrap()
                .get(&device_key_id(&d.id))
                .is_none()
        );
        assert!(device_token(&s, &d).await.is_err());
        let public: Vec<Device> = list(&s, "device").await.unwrap();
        assert!(!serde_json::to_string(&public).unwrap().contains(TOKEN));
        s.db.close().await;
        tokio::fs::remove_dir_all(&s.data_dir).await.unwrap();
    }

    #[tokio::test]
    async fn omitted_device_uses_saved_default_but_explicit_null_or_empty_disables_it() {
        let s = fixture().await;
        let c: Connection = serde_json::from_value(json!({"id":"model","name":"fixture","kind":"target","base_url":"http://127.0.0.1:1/v1","model":"fixture","device_id":"local"})).unwrap();
        put(&s, "connection", &c.id, &c).await.unwrap();
        let base = json!({"connection_id":"model","config":{"name":"fixture","base_url":"","model":"","pack_id":"fixture","profile":"quick","temperature":0,"max_tokens":1,"concurrency":1,"timeout_s":5,"telemetry_url":"http://127.0.0.1:9/metrics"}});
        let mut b: Start = serde_json::from_value(base.clone()).unwrap();
        resolve(&s, &mut b).await.unwrap();
        assert_eq!(b.config.device_id, "local");
        assert!(b.config.device.is_some());
        for explicit in [Value::Null, json!("")] {
            let mut request = base.clone();
            request["device_id"] = explicit;
            let mut b: Start = serde_json::from_value(request).unwrap();
            resolve(&s, &mut b).await.unwrap();
            assert!(
                b.config.device.is_none()
                    && b.config.device_id.is_empty()
                    && b.config.telemetry_url.is_empty()
            );
        }
        s.db.close().await;
        tokio::fs::remove_dir_all(&s.data_dir).await.unwrap();
    }
}
