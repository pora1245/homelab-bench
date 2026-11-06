//! Installation preferences; readiness and credentials are kept separately.
use crate::{ApiResult, App, bad};
use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    schema_version: u32,
    model_location: Option<String>,
    code_grading: bool,
    device_collection: bool,
    completed: bool,
    updated_at: Option<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: 1,
            model_location: None,
            code_grading: false,
            device_collection: true,
            completed: false,
            updated_at: None,
        }
    }
}
pub async fn read(State(s): State<App>) -> ApiResult<Json<Value>> {
    let path = std::path::Path::new(&s.data_dir).join("onboarding.json");
    let preferences = match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice::<Preferences>(&bytes).map_err(bad)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Preferences::default(),
        Err(e) => return Err(bad(e)),
    };
    Ok(Json(
        json!({"preferences": preferences, "platform": std::env::consts::OS}),
    ))
}
pub async fn write(State(s): State<App>, Json(mut p): Json<Preferences>) -> ApiResult<Json<Value>> {
    if p.schema_version != 1
        || p.model_location
            .as_ref()
            .is_some_and(|v| !["local", "remote"].contains(&v.as_str()))
        || (p.completed && p.model_location.is_none())
    {
        return Err(bad("모델이 실행되는 위치를 선택하세요"));
    }
    let _lock = s.settings_lock.lock().await;
    p.updated_at = Some(chrono::Utc::now().to_rfc3339());
    let path = std::path::Path::new(&s.data_dir).join("onboarding.json");
    let temp = path.with_extension("tmp");
    tokio::fs::write(&temp, serde_json::to_vec_pretty(&p).map_err(bad)?)
        .await
        .map_err(bad)?;
    tokio::fs::rename(temp, path).await.map_err(bad)?;
    Ok(Json(
        json!({"preferences": p, "platform": std::env::consts::OS}),
    ))
}
