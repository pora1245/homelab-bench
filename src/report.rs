use crate::types::*;
use serde_json::{Value, json};
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
pub fn compare(a: &Run, b: &Run) -> Value {
    let mut differences = vec![];
    if a.config.judge != b.config.judge {
        differences.push("채점 모델 설정")
    }
    if a.suite_hash != b.suite_hash {
        differences.push("문항·프롬프트·채점 조건")
    }
    if a.protocol_version != b.protocol_version {
        differences.push("실행기 버전")
    }
    if a.config.temperature != b.config.temperature {
        differences.push("temperature")
    }
    if a.config.max_tokens != b.config.max_tokens {
        differences.push("출력 한도")
    }
    if a.config.reasoning_effort != b.config.reasoning_effort {
        differences.push("추론 설정")
    }
    if a.config.concurrency != b.config.concurrency {
        differences.push("동시 요청 수")
    }
    let mut regress = vec![];
    let mut improve = vec![];
    let mut paired = 0;
    for ai in &a.items {
        if let Some(bi) = b
            .items
            .iter()
            .find(|x| x.task.id == ai.task.id && digest(&x.task) == digest(&ai.task))
        {
            if let (Some(sa), Some(sb)) = (
                ai.attempts.last().and_then(|x| x.score.as_ref()),
                bi.attempts.last().and_then(|x| x.score.as_ref()),
            ) {
                if sa.scorer_version == sb.scorer_version {
                    if let (Some(va), Some(vb)) = (sa.value, sb.value) {
                        paired += 1;
                        if va > vb {
                            regress.push(&ai.task.id)
                        }
                        if va < vb {
                            improve.push(&ai.task.id)
                        }
                    }
                }
            }
        }
    }
    let sa = a.summary();
    let sb = b.summary();
    let mut subject_delta = serde_json::Map::new();
    if paired
        < a.items
            .iter()
            .filter(|i| {
                i.attempts
                    .last()
                    .and_then(|a| a.score.as_ref())
                    .is_some_and(|s| s.value.is_some())
            })
            .count()
        && a.suite_hash == b.suite_hash
    {
        differences.push("채점 버전·채점 완료 문항 차이")
    }
    if differences.is_empty() && a.status == "completed" && b.status == "completed" {
        for (k, x) in sa["subjects"].as_object().unwrap() {
            if let (Some(pa), Some(pb)) =
                (x["percent"].as_f64(), sb["subjects"][k]["percent"].as_f64())
            {
                if x["scored"] == sb["subjects"][k]["scored"] && x["scored"] == x["total"] {
                    subject_delta.insert(k.clone(), json!(pb - pa));
                }
            }
        }
    }
    let delta = |key: &str| {
        sa[key]["median"]
            .as_f64()
            .zip(sb[key]["median"].as_f64())
            .filter(|(a, _)| *a > 0.0)
            .map(|(a, b)| (b / a - 1.0) * 100.0)
    };
    let speed = if differences.is_empty() && sa["decode_sources"] == sb["decode_sources"] {
        json!({"decode_pct":delta("decode_tps"),"prefill_pct":delta("prefill_tps"),"ttft_pct":delta("ttft_ms")})
    } else {
        Value::Null
    };
    json!({"baseline":a.config.name,"candidate":b.config.name,"differences":differences,"paired":paired,"correct_to_wrong":regress,"wrong_to_correct":improve,"subject_delta_pp":subject_delta,"performance_delta":speed,"a":sa,"b":sb})
}
fn temperature_label(r: &Run) -> String {
    let sent = r
        .items
        .iter()
        .flat_map(|i| i.attempts.iter())
        .filter_map(|a| {
            a.raw
                .iter()
                .find(|v| v["kind"] == "request")
                .map(|v| v["body"].get("temperature").and_then(Value::as_f64))
        })
        .collect::<Vec<_>>();
    if !sent.is_empty() && sent.iter().all(Option::is_none) {
        return "공급자 기본 (미전송)".into();
    }
    if !sent.is_empty() && sent.iter().all(|v| *v == sent[0]) {
        if let Some(v) = sent[0] {
            return format!("{v} (실제 전송)");
        }
    }
    if !sent.is_empty() {
        return "문항별 전송값 상이 · 원시 요청 확인".into();
    }
    format!("실제 전송값 미기록 · 실행 설정 {}", r.config.temperature)
}
fn item_label(i: &Item) -> String {
    let a = i.attempts.last();
    let label = if i.verdict() == "interrupted" {
        "중단"
    } else if a.is_some_and(|a| a.error.is_some()) {
        "요청 오류"
    } else if a.is_some_and(|a| a.finish_reason.as_deref() == Some("length")) {
        "출력 잘림"
    } else {
        match i.verdict() {
            "measured" => "측정 완료",
            "measurement_invalid" => "출력 점검 실패",
            "correct" => "정답",
            "incorrect" => "오답",
            "partial" => "부분 점수",
            "generating" => "답변 생성 중",
            "grading_pending" => "채점 대기",
            "request_error" => "요청 오류",
            "interrupted" => "중단",
            "not_started" => "시작 전",
            _ => "미채점",
        }
    };
    if i.task.meta["warmup"] == true {
        format!("예열 · {label} · 성능 집계 제외")
    } else {
        label.into()
    }
}
pub fn html(r: &Run) -> String {
    let s = r.summary();
    let mut rows = String::new();
    for (subject, v) in s["subjects"].as_object().unwrap() {
        let measured = v["measured"].as_u64().unwrap_or(0);
        let invalid = v["measurement_errors"].as_u64().unwrap_or(0);
        let warmup = r
            .items
            .iter()
            .filter(|i| i.task.subject == *subject && i.task.meta["warmup"] == true)
            .count();
        let score = v["percent"].as_f64().map(|x| format!("{x:.1}%"));
        let status = if measured + invalid > 0 {
            format!(
                "{}측정 완료 {measured} · 출력 점검 실패 {invalid}{}",
                score.map(|x| format!("{x} · ")).unwrap_or_default(),
                if warmup > 0 {
                    format!(" · 예열 {warmup}건 포함(성능 집계 제외)")
                } else {
                    String::new()
                }
            )
        } else {
            score.unwrap_or("미채점".into())
        };
        let processed = v["scored"].as_u64().unwrap_or(0) + measured + invalid;
        rows.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td>{}/{}</td></tr>",
            esc(subject),
            esc(&status),
            processed,
            v["total"]
        ));
    }
    let mut items = String::new();
    let fmt = |v: &Value| {
        v.as_f64()
            .map(|n| format!("{n:.1}"))
            .unwrap_or_else(|| "미수집".into())
    };
    items.push_str(&format!("<section><p>TTFT 중앙값 {} ms · 디코딩 중앙값 {} tok/s · 프리필 중앙값 {} tok/s</p><p>디코딩 계측 출처 {} · 출력 처리량 {} tok/s(프리필·대기 포함)</p><p>출력 한도 {} · 추론 설정 {} · 채점 미완료 {}</p><p>표본 해시 {}</p><p>출처 {} · {}</p></section>",fmt(&s["ttft_ms"]["median"]),fmt(&s["decode_tps"]["median"]),fmt(&s["prefill_tps"]["median"]),esc(&s["decode_sources"].to_string()),fmt(&s["output_throughput_tps"]),r.config.max_tokens,esc(&r.config.reasoning_effort),s["score_errors"],esc(&r.suite_hash),esc(&r.provenance),esc(&r.config.note)));
    items.push_str(&format!("<section><p>가시 출력 속도 중앙값 {} tok/s · 예열 {}건은 성능 집계에서 제외</p><p>성능 측정 완료 {} · 출력 점검 실패 {} · 품질 평가 문항 {}</p><p class=\"muted\">API 기준 성능점수와 종합 보고서는 앱의 보고서 화면에서 확인하세요.</p></section>",fmt(&s["client_visible_decode_tps"]["median"]),s["warmup_total"],s["measured"],s["measurement_errors"],s["quality_total"]));
    items.push_str("<details><summary>계측 수집·제외 내역</summary><table><thead><tr><th>지표</th><th>유효</th><th>제외</th><th>미수집</th><th>제외 사유</th></tr></thead><tbody>");
    for (key, label) in [
        ("ttft_ms", "TTFT"),
        ("decode_tps", "Decode"),
        ("client_visible_decode_tps", "가시 출력 Decode"),
        ("prefill_tps", "Prefill"),
        ("throughput", "Throughput"),
    ] {
        let v = &s["metric_quality"]["metrics"][key];
        items.push_str(&format!(
            "<tr><td>{label}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            v["valid"],
            v["excluded"],
            v["missing"],
            esc(&v["reasons"].to_string())
        ));
    }
    items.push_str("</tbody></table><p>metric-integrity-v1 · 계측 오류만 집계에서 제외하며 원본과 실제 지연은 보존합니다. 100ms 미만의 가시 출력 구간은 전송 버퍼와 디코딩을 구분할 수 없어 클라이언트 속도 추정에서 제외합니다.</p></details>");
    for i in &r.items {
        if let Some(a) = i.attempts.last() {
            items.push_str(&format!("<details><summary>{} · {} · {}</summary><h4>문제</h4><pre>{}</pre><h4>답변</h4><pre>{}</pre><h4>채점 근거</h4><pre>{}</pre></details>",esc(&i.task.subject),esc(&i.task.id),esc(&item_label(i)),esc(&i.task.prompt),esc(&a.output),esc(&a.score.as_ref().map(|s|s.detail.clone()).unwrap_or_else(||"미채점".into()))));
        }
    }
    format!(
        r#"<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{title} · LLM Bench</title><style>body{{font:16px/1.65 system-ui;background:#f5f6f8;color:#152237;margin:0}}main{{max-width:960px;padding:45px;margin:auto}}h1{{font-size:38px}}table{{width:100%;border-collapse:collapse;background:white}}td,th{{padding:14px;text-align:left;border-bottom:1px solid #dfe5ed}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 system-ui}}details{{background:white;padding:20px;margin:12px 0;border-radius:12px}}.muted{{color:#607086}}button{{padding:12px 18px}}@media print{{button{{display:none}}body{{background:white}}main{{padding:10px}}}}</style><main><p class="muted">LLM BENCH · 원시 실행 보고서</p><h1>{title}</h1><p>{model} · {date}</p><p>프로필 {profile} · 동시 요청 {concurrency} · Temperature {temp}</p><table><thead><tr><th>과목</th><th>점수 / 측정 상태</th><th>채점·점검/전체 문항</th></tr></thead><tbody>{rows}</tbody></table><p>완료 {completed}/{total} · API 오류 {errors} · 출력 한도 도달 {truncated}</p><p class="muted">선택 표본의 결과입니다. 데이터팩 {pack} · 실행기 {protocol}</p><button onclick="window.print()">인쇄 / PDF 저장</button><h2>문항별 기록</h2>{items}</main></html>"#,
        title = esc(&r.config.name),
        model = esc(&r.config.model),
        date = esc(&r.created_at),
        profile = esc(&r.config.profile),
        concurrency = r.config.concurrency,
        temp = esc(&temperature_label(r)),
        rows = rows,
        completed = s["completed"],
        total = s["total"],
        errors = s["errors"],
        truncated = s["truncated"],
        pack = esc(&r.pack_version),
        protocol = esc(&r.protocol_version),
        items = items
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_html_distinguishes_actual_settings_measurements_and_failures() {
        let mut r: Run = serde_json::from_value(json!({"id":"fixture","created_at":now(),"config":{
            "name":"<script>private</script>","base_url":"http://fixture.invalid","model":"gpt-6.1-sol",
            "api_format":"responses","pack_id":"api-experience-v1","profile":"quick","temperature":0,
            "max_tokens":4096,"concurrency":1,"timeout_s":10,"reasoning_effort":"low"},
            "status":"completed","suite_hash":"fixture","protocol_version":"fixture","pack_version":"fixture",
            "provenance":"fixture","telemetry":[],"active_ms":1000,"error":null,"items":[]})).unwrap();
        for (n, valid, warmup) in [(0, true, true), (1, true, false), (2, false, false)] {
            r.items.push(serde_json::from_value(json!({"task":{"id":format!("experience:fixture:{n}"),"subject":"응답 경험",
                "prompt":"<img src=x onerror=alert(1)>","answer":null,"scorer":"experience","max_tokens":4096,"meta":{"warmup":warmup}},
                "status":"done","attempts":[{"started_at":now(),"ended_at":now(),"output":"<script>answer</script>","reasoning":"",
                "finish_reason":"stop","error":null,"metrics":Metrics::default(),"score":{"value":null,"state":"measured","detail":"shape check","scorer_version":"fixture","extra":{"valid_output":valid}},
                "raw":[{"kind":"request","body":{"model":"gpt-6.1-sol","stream":true}}]}]})).unwrap());
        }
        let html = html(&r);
        assert!(html.contains("Temperature 공급자 기본 (미전송)"));
        assert!(html.contains("측정 완료 2 · 출력 점검 실패 1"));
        assert!(html.contains("예열 · 측정 완료 · 성능 집계 제외"));
        assert!(html.contains("예열 1건은 성능 집계에서 제외"));
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img src=x"));
        assert!(html.contains("&lt;script&gt;answer&lt;/script&gt;"));
        assert_eq!(temperature_label(&r), "공급자 기본 (미전송)");
        for i in &mut r.items {
            i.attempts[0].raw[0]["body"]["temperature"] = json!(0.3);
        }
        assert_eq!(temperature_label(&r), "0.3 (실제 전송)");
        r.items[1].attempts[0].finish_reason = Some("length".into());
        assert_eq!(item_label(&r.items[1]), "출력 잘림");
        r.items[1].attempts[0].error = Some("HTTP error".into());
        assert_eq!(item_label(&r.items[1]), "요청 오류");
    }
}
