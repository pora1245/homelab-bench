//! Fixed excerpts of the reviewed local datasets; no private model answers.
use crate::types::{Pack, Task};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

pub fn load(root: &Path) -> Result<Vec<Pack>> {
    let path = root.join("datasets/timed-packs/manifest-v1.json");
    if !path.exists() { return Ok(Vec::new()); }
    let manifest: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let mut tasks: BTreeMap<String, Task> = BTreeMap::new();
    for source in manifest["source_files"].as_array().context("시간팩 출처 목록 누락")? {
        let relative = source["file"].as_str().context("시간팩 파일 경로 누락")?;
        let parts: Vec<_> = Path::new(relative).components().collect();
        if parts.len()!=2 || !relative.starts_with("datasets/") || relative.contains("..") || relative.contains('\\') {
            bail!("시간팩 출처 경로가 올바르지 않습니다");
        }
        let bytes = std::fs::read(root.join(relative)).with_context(|| format!("시간팩 원본 미설치: {relative}"))?;
        if format!("{:x}",Sha256::digest(&bytes)) != source["sha256"].as_str().unwrap_or("") {
            bail!("시간팩 원본 해시 불일치: {relative}");
        }
        let p: Pack = serde_json::from_slice(&bytes)?;
        if Some(p.id.as_str()) != source["id"].as_str() || Some(p.version.as_str()) != source["version"].as_str() {
            bail!("시간팩 원본 버전 불일치: {relative}");
        }
        for task in p.tasks {
            if tasks.insert(task.id.clone(),task).is_some() { bail!("시간팩 원본 문항 ID 중복"); }
        }
    }
    let mut result = Vec::new();
    let mut previous = HashSet::new();
    for entry in manifest["packs"].as_array().context("시간팩 목록 누락")? {
        let mut seen = HashSet::new();
        let mut selected = Vec::new();
        for id in entry["task_ids"].as_array().context("시간팩 문항 목록 누락")? {
            let id=id.as_str().context("시간팩 문항 ID 오류")?;
            if !seen.insert(id.to_owned()) { bail!("시간팩 문항 중복: {id}"); }
            selected.push(tasks.get(id).ok_or_else(||anyhow!("시간팩 원문 누락: {id}"))?.clone());
        }
        if selected.is_empty() || !previous.is_subset(&seen) { bail!("시간팩 중첩 관계 오류"); }
        previous = seen;
        let mut sources=entry["sources"].clone();
        sources["quick_ids"]=entry["task_ids"].clone();
        result.push(Pack {id:entry["id"].as_str().context("시간팩 ID 누락")?.into(),
            name:entry["name"].as_str().context("시간팩 이름 누락")?.into(),
            version:entry["version"].as_str().context("시간팩 버전 누락")?.into(),sources,tasks:selected});
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_packs_load_reviewed_sources_and_are_nested() {
        let packs=load(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        assert_eq!(packs.iter().map(|p|p.tasks.len()).collect::<Vec<_>>(),vec![54,259,995,1959]);
        let mut previous=HashSet::new();
        for p in packs {
            let ids=p.tasks.iter().map(|t|t.id.clone()).collect::<HashSet<_>>();
            assert_eq!(ids.len(),p.tasks.len());assert!(previous.is_subset(&ids));previous=ids;
            assert_eq!(p.tasks.iter().map(|t|t.scorer.as_str()).collect::<HashSet<_>>().len(),7);
            assert!(p.sources["planned_seconds"].as_f64().unwrap()<=p.sources["reference_seconds"].as_f64().unwrap());
            assert!(p.tasks.iter().all(|t|t.scorer!="experience" && !t.prompt.is_empty()));
        }
    }
    #[test]
    fn changed_source_is_rejected_before_loading_questions() {
        let root=std::env::temp_dir().join(format!("bench-timed-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("datasets/timed-packs")).unwrap();
        std::fs::write(root.join("datasets/changed.json"),b"{}").unwrap();
        std::fs::write(root.join("datasets/timed-packs/manifest-v1.json"),
            serde_json::to_vec(&serde_json::json!({"source_files":[{"file":"datasets/changed.json","sha256":"wrong"}],"packs":[]})).unwrap()).unwrap();
        assert!(load(&root).err().unwrap().to_string().contains("해시 불일치"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
