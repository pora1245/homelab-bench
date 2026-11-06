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
