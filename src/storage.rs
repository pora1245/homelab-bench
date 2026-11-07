//! Incremental SQLite checkpoints: unchanged questions are not rewritten for every token.
use crate::{App, types::*};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;
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
    telemetry: [u8; 0],
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
        telemetry: [],
        active_ms: r.active_ms,
        error: &r.error,
        execution_segments: &r.execution_segments,
        initial_concurrency: r.initial_concurrency,
        concurrency_tuning: &r.concurrency_tuning,
        items: [],
    }
}
// Ordered telemetry is append-only and is stored separately from frequently
// updated run metadata. Retaining every sample must not make each checkpoint
// proportional to the complete history.
async fn append_telemetry(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    id: &str,
    samples: &[Value],
) -> anyhow::Result<()> {
    let (next,): (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(position)+1,0) FROM run_telemetry WHERE run_id=?")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    anyhow::ensure!(
        next >= 0 && next as usize <= samples.len(),
        "저장된 장비 기록보다 짧은 이력으로 덮어쓸 수 없습니다"
    );
    for (offset, chunk) in samples[next as usize..].chunks(200).enumerate() {
        let start = next as usize + offset * 200;
        let bodies = chunk
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()?;
        let mut query = sqlx::QueryBuilder::new("INSERT INTO run_telemetry(run_id,position,body) ");
        query.push_values(bodies.iter().enumerate(), |mut row, (i, body)| {
            row.push_bind(id)
                .push_bind((start + i) as i64)
                .push_bind(body);
        });
        query.build().execute(&mut **tx).await?;
    }
    Ok(())
}
async fn load_telemetry(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    id: &str,
) -> anyhow::Result<Vec<Value>> {
    let rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT position,body FROM run_telemetry WHERE run_id=? ORDER BY position")
            .bind(id)
            .fetch_all(&mut **tx)
            .await?;
    rows.into_iter()
        .enumerate()
        .map(|(expected, (position, body))| {
            anyhow::ensure!(
                position == expected as i64,
                "장비 기록 순서에 공백이 있어 복원을 중단합니다"
            );
            Ok(serde_json::from_str(&body)?)
        })
        .collect()
}
pub async fn init(db: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS run_items(run_id TEXT NOT NULL,position INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,position))").execute(db).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS run_trash(run_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL,metadata TEXT NOT NULL)").execute(db).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS run_telemetry(run_id TEXT NOT NULL,position INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,position))").execute(db).await?;
    // Migrate all legacy runs, including soft-deleted ones, atomically. Do not
    // deserialize/rewrite answer rows or unrelated header fields.
    let mut tx = db.begin().await?;
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM runs WHERE json_array_length(body,'$.telemetry') > 0 ORDER BY id",
    )
    .fetch_all(&mut *tx)
    .await?;
    for (id,) in ids {
        let (body,): (String,) = sqlx::query_as("SELECT body FROM runs WHERE id=?")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
        // Borrow the original JSON tokens. Parsing legacy floating-point
        // values into Value and reserializing them can change their last bit.
        // Existing evidence must retain the exact original number spelling.
        #[derive(Deserialize)]
        struct LegacyTelemetry<'a> {
            #[serde(borrow)]
            telemetry: Vec<&'a RawValue>,
        }
        let legacy: LegacyTelemetry<'_> = serde_json::from_str(&body)?;
        let existing: Vec<(i64, String)> = sqlx::query_as(
            "SELECT position,body FROM run_telemetry WHERE run_id=? ORDER BY position",
        )
        .bind(&id)
        .fetch_all(&mut *tx)
        .await?;
        anyhow::ensure!(
            existing.len() <= legacy.telemetry.len()
                && existing
                    .iter()
                    .enumerate()
                    .all(|(i, (position, old))| *position == i as i64
                        && old == legacy.telemetry[i].get()),
            "기존 장비 기록과 분리 저장된 기록이 일치하지 않아 이전을 중단합니다"
        );
        for (offset, chunk) in legacy.telemetry[existing.len()..].chunks(200).enumerate() {
            let start = existing.len() + offset * 200;
            let mut query =
                sqlx::QueryBuilder::new("INSERT INTO run_telemetry(run_id,position,body) ");
            query.push_values(chunk.iter().enumerate(), |mut row, (i, sample)| {
                row.push_bind(&id)
                    .push_bind((start + i) as i64)
                    .push_bind(sample.get());
            });
            query.build().execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE runs SET body=json_set(body,'$.telemetry',json('[]')) WHERE id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn load_items(db: &SqlitePool, r: &mut Run) -> anyhow::Result<()> {
    let mut tx = db.begin().await?;
    if r.items.is_empty() {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT body FROM run_items WHERE run_id=? ORDER BY position")
                .bind(&r.id)
                .fetch_all(&mut *tx)
                .await?;
        r.items = rows
            .into_iter()
            .map(|(b,)| Ok(serde_json::from_str(&b)?))
            .collect::<anyhow::Result<Vec<_>>>()?;
    }
    let telemetry = load_telemetry(&mut tx, &r.id).await?;
    // An imported in-memory run may still carry its own unsaved history.
    if r.telemetry.is_empty() {
        r.telemetry = telemetry;
    } else {
        anyhow::ensure!(
            telemetry.is_empty() || telemetry == r.telemetry,
            "장비 기록이 저장된 이력과 일치하지 않습니다"
        );
    }
    tx.commit().await?;
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
    append_telemetry(&mut tx, &r.id, &r.telemetry).await?;
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
    r.telemetry = load_telemetry(&mut tx, id).await?;
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
    let experience_changed = crate::scoring::upgrade_experience_scores(&mut r) > 0;
    let bbh_positions = upgrade_bbh_item_positions(&mut r);
    if experience_changed || !bbh_positions.is_empty() {
        sqlx::query("UPDATE runs SET body=? WHERE id=?")
            .bind(serde_json::to_string(&header(&r))?)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for (position, item) in r.items.iter().enumerate() {
            if !experience_changed && !bbh_positions.contains(&position) {
                continue;
            }
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

/// Determine exactly which stored item score arrays changed during the scoped
/// BBH compatibility upgrade. This avoids rewriting unrelated response rows.
pub(crate) fn upgrade_bbh_item_positions(run: &mut Run) -> Vec<usize> {
    let before = run.items.iter().enumerate()
        .filter(|(_, item)| item.task.scorer == "bbh")
        .map(|(index, item)| (index, serde_json::to_value(
            item.attempts.iter().map(|a| &a.score).collect::<Vec<_>>()
        ).expect("score serializes")))
        .collect::<Vec<_>>();
    if crate::scoring::upgrade_bbh_scores(run) == 0 {
        return Vec::new();
    }
    before.into_iter().filter_map(|(index, old)| {
        let new = serde_json::to_value(run.items[index].attempts.iter()
            .map(|a| &a.score).collect::<Vec<_>>()).expect("score serializes");
        (old != new).then_some(index)
    }).collect()
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

#[cfg(test)]
mod telemetry_persistence_tests {
    use super::*;
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn database() -> SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE runs(id TEXT PRIMARY KEY,body TEXT NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        db
    }
    fn fixture(id: &str, telemetry: Vec<Value>) -> Run {
        serde_json::from_value(json!({"id":id,"created_at":"2026-01-01T00:00:00Z","config":{"name":"fixture","base_url":"http://localhost:1/v1","model":"fixture","pack_id":"fixture","profile":"full","temperature":0,"max_tokens":32,"concurrency":8,"timeout_s":5},"status":"paused","suite_hash":"keep-suite","protocol_version":"fixture","pack_version":"fixture","provenance":"fixture","items":[],"telemetry":telemetry,"active_ms":1000,"error":null})).unwrap()
    }
    async fn insert(db: &SqlitePool, id: &str, telemetry: Vec<Value>) -> String {
        let mut v = serde_json::to_value(fixture(id, telemetry)).unwrap();
        v["unknown_future_field"] = json!({"keep":"unrelated"});
        let body = serde_json::to_string(&v).unwrap();
        sqlx::query("INSERT INTO runs(id,body) VALUES(?,?)")
            .bind(id)
            .bind(&body)
            .execute(db)
            .await
            .unwrap();
        body
    }
    #[tokio::test]
    async fn legacy_telemetry_migration_is_ordered_idempotent_and_preserves_answer_bytes() {
        let db = database().await;
        let samples = vec![
            json!({"at":"t2","watts":1.23456789012345}),
            Value::Null,
            json!(true),
            json!(false),
            json!(42),
            json!("한국어"),
            json!([2, 1]),
            json!({"at":"t1"}),
        ];
        let original = insert(&db, "fixture", samples.clone()).await;
        init(&db).await.unwrap();
        let row = r#"{ "task":{"id":"a","subject":"x","prompt":"p","answer":1,"scorer":"numeric","max_tokens":32},"status":"pending","attempts":[] }"#;
        sqlx::query("INSERT INTO run_items VALUES('fixture',0,?)")
            .bind(row)
            .execute(&db)
            .await
            .unwrap();
        let (head,): (String,) = sqlx::query_as("SELECT body FROM runs WHERE id='fixture'")
            .fetch_one(&db)
            .await
            .unwrap();
        let mut expected: Value = serde_json::from_str(&original).unwrap();
        expected["telemetry"] = json!([]);
        assert_eq!(serde_json::from_str::<Value>(&head).unwrap(), expected);
        let mut r: Run = serde_json::from_str(&head).unwrap();
        load_items(&db, &mut r).await.unwrap();
        assert_eq!(r.telemetry, samples);
        assert_eq!(r.public(false)["telemetry"], json!(samples));
        init(&db).await.unwrap();
        let (after,): (String,) =
            sqlx::query_as("SELECT body FROM run_items WHERE run_id='fixture'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(after, row);
        let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM run_telemetry")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 8);
    }
    #[tokio::test]
    async fn migration_preserves_raw_numeric_tokens_and_f64_bits() {
        let db = database().await;
        let sample_raw = r#"{ "watts":26.912181303116146,"tiny":2.2250738585072014e-308,"large":9007199254740991,"array":[0.10000000000000001,-0.0] }"#;
        let number_raw = "26.912181303116146";
        let mut original = serde_json::to_string(&fixture("precision", vec![])).unwrap();
        original = original.replace(
            "\"telemetry\":[]",
            &format!("\"telemetry\":[{sample_raw},{number_raw}]"),
        );
        // Keep an unrelated header numeric token intact through SQL json_set.
        original = original.replace("\"temperature\":0.0", "\"temperature\":26.912181303116146");
        sqlx::query("INSERT INTO runs(id,body) VALUES('precision',?)")
            .bind(&original)
            .execute(&db)
            .await
            .unwrap();
        init(&db).await.unwrap();
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT body FROM run_telemetry WHERE run_id='precision' ORDER BY position",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(rows, vec![(sample_raw.into(),), (number_raw.into(),)]);
        let (head,): (String,) = sqlx::query_as("SELECT body FROM runs WHERE id='precision'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(head.contains("\"temperature\":26.912181303116146"));
        let mut loaded: Run = serde_json::from_str(&head).unwrap();
        load_items(&db, &mut loaded).await.unwrap();
        let expected = number_raw.parse::<f64>().unwrap();
        assert_eq!(
            loaded.telemetry[0]["watts"].as_f64().unwrap().to_bits(),
            expected.to_bits()
        );
        assert_eq!(
            loaded.telemetry[1].as_f64().unwrap().to_bits(),
            expected.to_bits()
        );
        assert_eq!(loaded.config.temperature.to_bits(), expected.to_bits());
        let exported = serde_json::to_string(&loaded.telemetry).unwrap();
        assert!(exported.contains(number_raw));
        init(&db).await.unwrap();
        let (again,): (String,) = sqlx::query_as(
            "SELECT body FROM run_telemetry WHERE run_id='precision' AND position=0",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(again, sample_raw);
    }

    #[tokio::test]
    async fn migration_failure_rolls_back_all_runs_and_inline_history() {
        let db = database().await;
        init(&db).await.unwrap();
        let a = insert(&db, "a", vec![json!({"n":1})]).await;
        let b = insert(&db, "b", vec![json!({"n":2})]).await;
        sqlx::query("CREATE TRIGGER fail_migration BEFORE INSERT ON run_telemetry WHEN NEW.run_id='b' BEGIN SELECT RAISE(ABORT,'fixture failure'); END").execute(&db).await.unwrap();
        assert!(init(&db).await.is_err());
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT id,body FROM runs ORDER BY id")
            .fetch_all(&db)
            .await
            .unwrap();
        assert_eq!(rows, vec![("a".into(), a), ("b".into(), b)]);
        let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM run_telemetry")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0);
        sqlx::query("DROP TRIGGER fail_migration")
            .execute(&db)
            .await
            .unwrap();
        init(&db).await.unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM run_telemetry")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 2);
    }
    #[tokio::test]
    async fn append_only_checkpoints_keep_old_sample_bytes_and_header_size_bounded() {
        let db = database().await;
        init(&db).await.unwrap();
        let mut r = fixture("fixture", vec![json!({"n":0})]);
        let first_len = serde_json::to_vec(&header(&r)).unwrap().len();
        let mut tx = db.begin().await.unwrap();
        append_telemetry(&mut tx, &r.id, &r.telemetry)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let original = "{ \"n\": 0 }";
        sqlx::query("UPDATE run_telemetry SET body=? WHERE run_id='fixture'")
            .bind(original)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER prevent_rewrite BEFORE UPDATE ON run_telemetry BEGIN SELECT RAISE(ABORT,'old telemetry rewritten'); END").execute(&db).await.unwrap();
        r.telemetry.extend(
            (1..10_000).map(
                |n| json!({"n":n,"gpu":{"watts":100,"temperature":53},"padding":"x".repeat(64)}),
            ),
        );
        let mut tx = db.begin().await.unwrap();
        append_telemetry(&mut tx, &r.id, &r.telemetry)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let (stored,): (String,) =
            sqlx::query_as("SELECT body FROM run_telemetry WHERE run_id='fixture' AND position=0")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(stored, original);
        assert_eq!(serde_json::to_vec(&header(&r)).unwrap().len(), first_len);
        let mut tx = db.begin().await.unwrap();
        assert_eq!(load_telemetry(&mut tx, &r.id).await.unwrap(), r.telemetry);
        append_telemetry(&mut tx, &r.id, &r.telemetry)
            .await
            .unwrap();
        assert!(append_telemetry(&mut tx, &r.id, &[]).await.is_err());
        tx.rollback().await.unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM run_telemetry")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 10_000);
    }
    #[tokio::test]
    async fn trash_legacy_history_is_migrated_and_restored_without_loss() {
        let db = database().await;
        init(&db).await.unwrap();
        let samples = vec![json!({"ordinal":0}), json!({"ordinal":1})];
        insert(&db, "trash", samples.clone()).await;
        sqlx::query("INSERT INTO run_items VALUES('trash',0,?)").bind(r#"{"task":{"id":"a","subject":"x","prompt":"p","answer":1,"scorer":"numeric","max_tokens":32},"status":"pending","attempts":[]}"#).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO run_trash VALUES('trash','2026-01-02T00:00:00Z','{}')")
            .execute(&db)
            .await
            .unwrap();
        init(&db).await.unwrap();
        assert!(deleted_at(&db, "trash").await.unwrap().is_some());
        let r = restore(&db, "trash").await.unwrap();
        assert_eq!(r.telemetry, samples);
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.suite_hash, "keep-suite");
        assert!(deleted_at(&db, "trash").await.unwrap().is_none());
    }
}
