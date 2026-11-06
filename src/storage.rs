//! Incremental SQLite checkpoints: unchanged questions are not rewritten for every token.
use crate::{App, types::*};
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
#[derive(Serialize)]
struct Header<'a> {
    id: &'a str,
    created_at: &'a str,
    config: &'a Config,
    status: &'a str,
    suite_hash: &'a str,
    protocol_version: &'a str,
    pack_version: &'a str,
    provenance: &'a str,
    telemetry: &'a Vec<Value>,
    active_ms: f64,
    error: &'a Option<String>,
    execution_segments: &'a Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    initial_concurrency: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    concurrency_tuning: &'a Option<crate::auto_concurrency::Tuning>,
    items: [u8; 0],
}
fn header(r: &Run) -> Header<'_> {
    Header {
        id: &r.id,
        created_at: &r.created_at,
        config: &r.config,
        status: &r.status,
        suite_hash: &r.suite_hash,
        protocol_version: &r.protocol_version,
        pack_version: &r.pack_version,
        provenance: &r.provenance,
        telemetry: &r.telemetry,
        active_ms: r.active_ms,
        error: &r.error,
        execution_segments: &r.execution_segments,
        initial_concurrency: r.initial_concurrency,
        concurrency_tuning: &r.concurrency_tuning,
        items: [],
    }
}
pub async fn init(db: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS run_items(run_id TEXT NOT NULL,position INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,position))").execute(db).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS run_trash(run_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL,metadata TEXT NOT NULL)").execute(db).await?;
    Ok(())
}
pub async fn load_items(db: &SqlitePool, r: &mut Run) -> anyhow::Result<()> {
    if !r.items.is_empty() {
        return Ok(());
    }
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT body FROM run_items WHERE run_id=? ORDER BY position")
            .bind(&r.id)
            .fetch_all(db)
            .await?;
    r.items = rows
        .into_iter()
        .map(|(b,)| Ok(serde_json::from_str(&b)?))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(())
}
pub async fn save(s: &App, r: &Run, all: bool) -> anyhow::Result<()> {
    save_with_trash(s, r, all, None).await
}
// Persist any interrupted/recovered in-memory state and the deletion marker in
// one transaction. Original questions, attempts and telemetry are retained.
pub async fn move_to_trash(s: &App, r: &Run, deleted_at: &str) -> anyhow::Result<()> {
    save_with_trash(s, r, true, Some(deleted_at)).await
}
async fn save_with_trash(
    s: &App,
    r: &Run,
    all: bool,
    deleted_at: Option<&str>,
) -> anyhow::Result<()> {
    let mut dirty = s.dirty.lock().await;
    let indices = if all {
        (0..r.items.len()).collect::<Vec<_>>()
    } else {
        dirty
            .get(&r.id)
            .map(|v| v.iter().copied().collect::<Vec<_>>())
            .unwrap_or_default()
    };
    let mut tx = s.db.begin().await?;
    let head = header(r);
    sqlx::query(
        "INSERT INTO runs(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    )
    .bind(&r.id)
    .bind(serde_json::to_string(&head)?)
    .execute(&mut *tx)
    .await?;
    for index in indices {
        let item = &r.items[index];
        sqlx::query("INSERT INTO run_items(run_id,position,body) VALUES(?,?,?) ON CONFLICT(run_id,position) DO UPDATE SET body=excluded.body").bind(&r.id).bind(index as i64).bind(serde_json::to_string(item)?).execute(&mut *tx).await?;
    }
    if let Some(deleted_at) = deleted_at {
        let metadata = serde_json::json!({"id":r.id,"name":r.config.name,"model":r.config.model,
            "created_at":r.created_at,"status":r.status,"provenance":r.provenance,"summary":r.summary(),"busy":false});
        sqlx::query("INSERT INTO run_trash(run_id,deleted_at,metadata) VALUES(?,?,?) ON CONFLICT(run_id) DO NOTHING")
            .bind(&r.id).bind(deleted_at).bind(serde_json::to_string(&metadata)?)
            .execute(&mut *tx).await?;
    }
    tx.commit().await?;
    dirty.remove(&r.id);
    let _ = s.events.send(r.id.clone());
    Ok(())
}

pub async fn trash_list(db: &SqlitePool) -> anyhow::Result<Vec<Value>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT metadata,deleted_at FROM run_trash ORDER BY deleted_at DESC,run_id")
            .fetch_all(db)
            .await?;
    rows.into_iter()
        .map(|(metadata, deleted_at)| {
            let mut v: Value = serde_json::from_str(&metadata)?;
            v["deleted_at"] = deleted_at.into();
            Ok(v)
        })
        .collect()
}

pub async fn deleted_at(db: &SqlitePool, id: &str) -> anyhow::Result<Option<String>> {
    Ok(
        sqlx::query_as::<_, (String,)>("SELECT deleted_at FROM run_trash WHERE run_id=?")
            .bind(id)
            .fetch_optional(db)
            .await?
            .map(|v| v.0),
    )
}

pub async fn restore(db: &SqlitePool, id: &str) -> anyhow::Result<Run> {
    let mut tx = db.begin().await?;
    let body: Option<(String,)> = sqlx::query_as(
        "SELECT runs.body FROM runs JOIN run_trash ON runs.id=run_trash.run_id WHERE runs.id=?",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (body,) = body.ok_or_else(|| anyhow::anyhow!("휴지통에 이 시험 기록이 없습니다"))?;
    let mut r: Run = serde_json::from_str(&body)?;
    anyhow::ensure!(r.id == id, "시험 ID가 일치하지 않아 삭제 표식을 유지합니다");
    if r.items.is_empty() {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT body FROM run_items WHERE run_id=? ORDER BY position")
                .bind(id)
                .fetch_all(&mut *tx)
                .await?;
        r.items = rows
            .into_iter()
            .map(|(body,)| serde_json::from_str(&body))
            .collect::<Result<Vec<_>, _>>()?;
    }
    anyhow::ensure!(
        !r.items.is_empty(),
        "복구할 시험 문항이 없어 삭제 표식을 유지합니다"
    );
    anyhow::ensure!(
        !["running", "pausing", "cancelling", "scoring"].contains(&r.status.as_str()),
        "활성 상태로 저장된 기록은 복구할 수 없습니다"
    );
    // Upgrade and restore atomically: a failed score write must leave the
    // record in the trash, with its original evidence and deletion marker.
    if crate::scoring::upgrade_experience_scores(&mut r) > 0 {
        sqlx::query("UPDATE runs SET body=? WHERE id=?")
            .bind(serde_json::to_string(&header(&r))?)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for (position, item) in r.items.iter().enumerate() {
            sqlx::query("INSERT INTO run_items(run_id,position,body) VALUES(?,?,?) ON CONFLICT(run_id,position) DO UPDATE SET body=excluded.body")
                .bind(id).bind(position as i64).bind(serde_json::to_string(item)?)
                .execute(&mut *tx).await?;
        }
    }
    sqlx::query("DELETE FROM run_trash WHERE run_id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(r)
}

#[cfg(test)]
mod segment_persistence_tests {
    use super::*;
    use axum::{
        Json,
        extract::{Path, State},
    };
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use tokio::sync::broadcast;

    #[tokio::test]
    async fn concurrency_control_persists_segments_without_rewriting_original_items() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE runs(id TEXT PRIMARY KEY,body TEXT NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        init(&db).await.unwrap();
        let (events, _) = broadcast::channel(8);
        let s = App {
            data_dir: "/unused-no-credentials".into(),
            db,
            events,
            preflights: Default::default(),
            runs: Default::default(),
            packs: Default::default(),
            keys: Default::default(),
            judge_keys: Default::default(),
            active: Default::default(),
            settings_lock: Default::default(),
            dirty: Default::default(),
        };
        let r:Run=serde_json::from_value(json!({"id":"fixture","created_at":"2026-01-01T00:00:00Z","config":{"name":"fixture","base_url":"http://localhost:1/v1","model":"fixture","pack_id":"fixture","profile":"full","temperature":0,"max_tokens":32,"concurrency":1,"timeout_s":5},"status":"paused","suite_hash":"fixture","protocol_version":"fixture","pack_version":"fixture","provenance":"fixture","items":[],"telemetry":[],"active_ms":1000,"error":null})).unwrap();
        save(&s, &r, true).await.unwrap();
        // Extra precision and formatting are intentional evidence. Deserializing
        // and writing this row again would change bytes despite equal meaning.
        let original = r#"{ "task":{"id":"fixture:0","subject":"math","prompt":"p","answer":1,"scorer":"numeric","max_tokens":32},"status":"done","attempts":[{"started_at":"2026-01-01T00:00:00Z","ended_at":"2026-01-01T00:00:01Z","output":"1","reasoning":"","finish_reason":"stop","error":null,"metrics":{"ttft_ms":100,"wall_ms":1000,"input_tokens":1,"output_tokens":1,"decode_tps":0.123456789012345678901,"prefill_tps":10,"decode_source":"server","prefill_source":"server"},"score":{"value":1,"state":"scored","detail":"original","scorer_version":"fixture"},"raw":[]}] }"#;
        sqlx::query("INSERT INTO run_items(run_id,position,body) VALUES('fixture',0,?)")
            .bind(original)
            .execute(&s.db)
            .await
            .unwrap();
        let mut loaded = r.clone();
        load_items(&s.db, &mut loaded).await.unwrap();
        s.runs.lock().await.insert(loaded.id.clone(), loaded);
        let result = crate::control(
            State(s.clone()),
            Path(("fixture".into(), "concurrency".into())),
            Json(json!({"concurrency":4})),
        )
        .await
        .unwrap();
        assert_eq!(result.0["concurrency"], 4);
        let (stored,): (String,) =
            sqlx::query_as("SELECT body FROM run_items WHERE run_id='fixture'")
                .fetch_one(&s.db)
                .await
                .unwrap();
        assert_eq!(stored, original);
        let (head,): (String,) = sqlx::query_as("SELECT body FROM runs WHERE id='fixture'")
            .fetch_one(&s.db)
            .await
            .unwrap();
        let mut reloaded: Run = serde_json::from_str(&head).unwrap();
        assert_eq!(reloaded.config.concurrency, 4);
        assert_eq!(reloaded.execution_segments.len(), 2);
        assert_eq!(reloaded.execution_segments[0]["concurrency"], 1);
        assert_eq!(reloaded.execution_segments[1]["concurrency"], 4);
        assert_eq!(reloaded.execution_segments[1]["completed_before"], 1);
        load_items(&s.db, &mut reloaded).await.unwrap();
        assert_eq!(reloaded.items.len(), 1);
        assert_eq!(
            reloaded.request_concurrency(&reloaded.items[0].attempts[0]),
            1
        );
        // Metadata-only pause/cancel transitions preserve every existing byte.
        s.runs.lock().await.get_mut("fixture").unwrap().status = "running".into();
        for action in ["pause", "cancel"] {
            let _ = crate::control(
                State(s.clone()),
                Path(("fixture".into(), action.into())),
                Json(json!({})),
            )
            .await
            .unwrap();
            let (body,): (String,) =
                sqlx::query_as("SELECT body FROM run_items WHERE run_id='fixture' AND position=0")
                    .fetch_one(&s.db)
                    .await
                    .unwrap();
            assert_eq!(body, original);
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router=axum::Router::new().route("/v1/chat/completions",axum::routing::post(|| async {Json(json!({"choices":[{"message":{"content":"1"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}))}));
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        {
            let mut runs = s.runs.lock().await;
            let r = runs.get_mut("fixture").unwrap();
            r.status = "paused".into();
            r.config.base_url = url;
            let mut pending = r.items[0].clone();
            pending.task.id = "fixture:1".into();
            pending.status = "pending".into();
            pending.attempts.clear();
            r.items.push(pending);
            s.dirty
                .lock()
                .await
                .entry("fixture".into())
                .or_default()
                .insert(1);
            save(&s, r, false).await.unwrap();
        }
        let wait_complete = || async {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    if !s.active.lock().await.contains("fixture") {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        };
        let _ = crate::control(
            State(s.clone()),
            Path(("fixture".into(), "resume".into())),
            Json(json!({"api_key":""})),
        )
        .await
        .unwrap();
        wait_complete().await;
        let (body,): (String,) =
            sqlx::query_as("SELECT body FROM run_items WHERE run_id='fixture' AND position=0")
                .fetch_one(&s.db)
                .await
                .unwrap();
        assert_eq!(body, original);
        {
            let mut runs = s.runs.lock().await;
            let r = runs.get_mut("fixture").unwrap();
            r.status = "paused".into();
            r.items[1].status = "error".into();
            r.items[1].attempts.last_mut().unwrap().error = Some("fixture failure".into());
            s.dirty
                .lock()
                .await
                .entry("fixture".into())
                .or_default()
                .insert(1);
            save(&s, r, false).await.unwrap();
        }
        s.dirty
            .lock()
            .await
            .entry("fixture".into())
            .or_default()
            .insert(0);
        sqlx::query("CREATE TRIGGER fail_header BEFORE UPDATE ON runs BEGIN SELECT RAISE(FAIL,'fixture write failure'); END").execute(&s.db).await.unwrap();
        assert!(
            crate::control(
                State(s.clone()),
                Path(("fixture".into(), "retry".into())),
                Json(json!({"api_key":""}))
            )
            .await
            .is_err()
        );
        assert_eq!(
            s.dirty.lock().await["fixture"],
            std::collections::BTreeSet::from([0])
        );
        assert_eq!(s.runs.lock().await["fixture"].status, "paused");
        assert_eq!(s.runs.lock().await["fixture"].items[1].status, "error");
        sqlx::query("DROP TRIGGER fail_header")
            .execute(&s.db)
            .await
            .unwrap();
        s.dirty.lock().await.clear();
        let _ = crate::control(
            State(s.clone()),
            Path(("fixture".into(), "retry".into())),
            Json(json!({"api_key":""})),
        )
        .await
        .unwrap();
        wait_complete().await;
        let (body,): (String,) =
            sqlx::query_as("SELECT body FROM run_items WHERE run_id='fixture' AND position=0")
                .fetch_one(&s.db)
                .await
                .unwrap();
        assert_eq!(body, original);
        assert_eq!(s.runs.lock().await["fixture"].items[1].status, "done");
        server.abort();
    }
}
