import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Obj, number, time, duration, Help, temperatureOmitted } from "./common";
import { benchmarkLabel, benchmarkHelp, taskBenchmarkLabel, taskBenchmarkKey, isReferenceTask, referenceSubjectLabel } from "./benchmarkLabels";

import { validMetric, metricReason } from "./metricQuality";
import { aggregateThroughput, throughputReason } from "./throughput";
import { MetricCoverage } from "./LiveInsights";
import { assessRun } from "./assessment";

type Format = "overview" | "intelligence" | "performance" | "detailed";
type Theme = "light" | "dark" | "print";
type Section =
  | "metrics"
  | "score"
  | "intelligence"
  | "performance"
  | "hardware"
  | "offload"
  | "conditions"
  | "grading"
  | "details";
type ReportPage = { section: Section; offset: number; title: string };
const formats = {
  overview: "종합 보고서",
  intelligence: "지능 보고서",
  performance: "성능 보고서",
  detailed: "문항별 보고서",
};
const themes = { light: "라이트", dark: "다크", print: "인쇄용" };
const palettes = {
  light: {
    bg: "#f2f5f7",
    card: "#ffffff",
    text: "#19303e",
    muted: "#677b89",
    line: "#dce5ea",
    accent: "#267f73",
    accentBg: "#e3f2ed",
    bad: "#b95736",
  },
  dark: {
    bg: "#101c2a",
    card: "#192b3b",
    text: "#f2f6f8",
    muted: "#a8bdcb",
    line: "#344c60",
    accent: "#6ed7bb",
    accentBg: "#1e403f",
    bad: "#ffb391",
  },
  print: {
    bg: "#ffffff",
    card: "#ffffff",
    text: "#14191c",
    muted: "#526069",
    line: "#b9c3c9",
    accent: "#275d75",
    accentBg: "#edf2f4",
    bad: "#9d3e26",
  },
};
const escape = (value: any) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const reportText = (value: any) =>
  String(value ?? "")
    .replace(/https?:\/\/[^\s)]+/g, "[주소 비공개]")
    .replace(
      /\/(?:Users|home|srv|mnt|Volumes|var|tmp|private|opt|etc)\/[^\s)]+/g,
      "[내부 경로 비공개]",
    )
    .replace(/[A-Za-z]:\\[^\s)]+/g, "[내부 경로 비공개]");
const finite = (value: any): value is number =>
  typeof value === "number" && Number.isFinite(value);
const display = (value: any, unit = "", digits = 1) =>
  finite(value) ? `${number(value, digits)}${unit}` : "미수집";
const known = (value: any) =>
  typeof value === "string" && value.trim() ? value : "미기록";
const observed = (value: any) =>
  typeof value === "string" && value.trim() ? value : "미수집";
const wrap = (value: any, limit: number, max = 2) => {
  const lines: string[] = [];
  let line = "",
    size = 0;
  for (const char of String(value ?? "")) {
    const width = /[^\x00-\x7F]/.test(char) ? 1 : 0.58;
    if (size + width > limit) {
      lines.push(line);
      line = "";
      size = 0;
    }
    line += char;
    size += width;
  }
  if (line) lines.push(line);
  return lines
    .slice(0, max)
    .map((line, index) =>
      index === max - 1 && lines.length > max ? line.slice(0, -1) + "…" : line,
    );
};
function stats(values: any[]) {
  const valid = values.filter(finite);
  if (!valid.length) return { n: 0, avg: null, min: null, max: null };
  return {
    n: valid.length,
    avg: valid.reduce((a, b) => a + b, 0) / valid.length,
    min: valid.reduce((a, b) => Math.min(a, b)),
    max: valid.reduce((a, b) => Math.max(a, b)),
  };
}
function collectHardware(run: Obj) {
  const samples: Obj[] = Array.isArray(run.telemetry) ? run.telemetry : [];
  const usable = samples.filter(
    (sample) =>
      sample.data &&
      typeof sample.data === "object" &&
      (!sample.error || sample.status === "partial") &&
      sample.status !== "stale" &&
      sample.status !== "unavailable",
  );
  const last = usable.at(-1)?.data || {},
    gpus = new Map<string, Obj>();
  for (const sample of usable) {
    for (const gpu of sample.data.gpus || []) {
      const key = String(gpu.index ?? gpu.name ?? "unknown");
      let record = gpus.get(key);
      if (!record) {
        record = { key, values: [], latest: gpu };
        gpus.set(key, record);
      }
      record.values.push(gpu);
      record.latest = { ...record.latest, ...gpu };
    }
  }
  const gpuRows: Obj[] = [...gpus.values()].map((record) => ({
    ...record,
    util: stats(record.values.map((v: Obj) => v.utilization_pct)),
    temp: stats(record.values.map((v: Obj) => v.temperature_c)),
    power: stats(record.values.map((v: Obj) => v.power_w)),
    vram: stats(record.values.map((v: Obj) => v.vram_used_mib)),
    clocks: stats(record.values.map((v: Obj) => v.clock_mhz)),
    throttle: record.values.filter((v: Obj) => v.throttle_active === true)
      .length,
    throttleKnown: record.values.filter(
      (v: Obj) =>
        v.throttle_active === true ||
        (v.throttle_active === false &&
          !(v.throttle_reasons || []).includes("unknown_clock_event")),
    ).length,
    throttleUnknown: record.values.filter(
      (v: Obj) =>
        v.throttle_active !== true &&
        (v.throttle_active !== false ||
          (v.throttle_reasons || []).includes("unknown_clock_event")),
    ).length,
  }));
  return {
    samples,
    usable,
    last,
    gpus: gpuRows,
    cpu: stats(usable.map((v) => v.data.cpu_pct)),
    ram: stats(usable.map((v) => v.data.ram_used_bytes)),
    swap: stats(usable.map((v) => v.data.swap_used_bytes)),
    missingGpuIndices: [
      ...new Set(
        usable.flatMap((v) => v.data.gpu_selection?.missing_indices || []),
      ),
    ],
  };
}
function measuredDecode(item: Obj) {
  if (item.task?.meta?.warmup) return null;
  const attempt = item.attempts?.at(-1);
  return ["done", "error"].includes(item.status) &&
    attempt?.ended_at &&
    attempt.error == null && validMetric(attempt,"decode_tps")
    ? attempt.metrics?.decode_tps
    : null;
}
function validSensorSample(sample: Obj) {
  return (
    sample.data &&
    (!sample.error || sample.status === "partial") &&
    !["stale", "unavailable"].includes(sample.status)
  );
}
function benchmarkResults(run: Obj): [string, Obj][] {
  if (!run.items?.length)
    return Object.entries(run.summary?.subjects || {}).map(([name, value]) => [referenceSubjectLabel(name), { ...(value as Obj), reference: name === "한국어" }]);
  const rows = new Map<string, Obj>();
  for (const item of run.items) {
    if (item.task.scorer === "experience" || item.task.id?.startsWith("experience:")) continue;
    const key = taskBenchmarkKey(item.task) || item.task.subject;
    let row = rows.get(key);
    if (!row) {
      row = { label: taskBenchmarkLabel(item.task), reference: isReferenceTask(item.task), total: 0, scored: 0, points: 0 };
      rows.set(key, row);
    }
    row.total++;
    const value = item.attempts?.at(-1)?.score?.value;
    if (["done", "error"].includes(item.status) && finite(value)) {
      row.scored++;
      row.points += value;
    }
  }
  return [...rows.values()].sort((a, b) => Number(a.reference) - Number(b.reference)).map((row) => [row.label, { ...row, percent: row.scored ? row.points * 100 / row.scored : null }]);
}
function gradingFailures(run: Obj): Obj[] {
  const reasons = new Map<string, Obj>();
  for (const item of run.items || []) {
    const score = item.attempts?.at(-1)?.score;
    if (!score || finite(score.value) || ["pending", "running"].includes(score.state) || (score.state === "measured" && score.extra?.valid_output !== false)) continue;
    const label = taskBenchmarkLabel(item.task);
    const detail = score.detail || "이 기록에는 채점 실패의 상세 사유가 없습니다.";
    const key = `${label}\n${detail}`;
    const reason = reasons.get(key) || { label, detail, count: 0 };
    reason.count++;
    reasons.set(key, reason);
  }
  if (!reasons.size && run.summary?.score_errors > 0)
    return [{ label: "채점 실패", detail: "이 기록에는 문항별 채점 실패 사유가 없습니다. 원본 기록을 확인하세요.", count: run.summary.score_errors }];
  return [...reasons.values()];
}
function gradingPages(run: Obj): ReportPage[] {
  return Array.from({ length: Math.ceil(gradingFailures(run).length / 4) }, (_, i) => ({ section: "grading", offset: i * 4, title: "채점·출력 검증 실패 사유" }));
}
const hardwareCache = new WeakMap<Obj, ReturnType<typeof collectHardware>>();
function hardware(run: Obj) {
  let value = hardwareCache.get(run);
  if (!value) {
    value = collectHardware(run);
    hardwareCache.set(run, value);
  }
  return value;
}
function buildReportPages(run: Obj, format: Format): ReportPage[] {
  if (format === "detailed")
    return [...Array.from(
      { length: Math.max(1, Math.ceil((run.items?.length || 0) / 12)) },
      (_, i) => ({
        section: "details" as Section,
        offset: i * 12,
        title: "문항별 응답 · 채점 · 속도",
      }),
    ), ...gradingPages(run)];
  const quality = Array.from(
    {
      length: Math.max(
        1,
        Math.ceil(benchmarkResults(run).length / 7),
      ),
    },
    (_, i) => ({
      section: "intelligence" as Section,
      offset: i * 7,
      title: "벤치마크별 평가 결과",
    }),
  );
  const device = hardware(run),
    devicePages = Array.from(
      { length: Math.max(1, Math.ceil(device.gpus.length / 4)) },
      (_, i) => ({
        section: "hardware" as Section,
        offset: i * 4,
        title: "시험 장비 · 사양과 실측",
      }),
    );
  const offloadPages: ReportPage[] =
    device.last.offload || run.config?.device?.include_offload
      ? Array.from(
          {
            length: Math.max(
              1,
              Math.ceil((device.last.offload?.numa_nodes?.length || 0) / 3),
              Math.ceil((device.last.offload?.storage?.length || 0) / 4),
            ),
          },
          (_, i) => ({
            section: "offload",
            offset: i,
            title: "Offload 자원 · NUMA 메모리와 저장장치",
          }),
        )
      : [];
  const conditions: ReportPage = {
    section: "conditions",
    offset: 0,
    title: "모델 실행 조건 · 평가 방법",
  };
  const scorePage: ReportPage = {section:"score",offset:0,title:"평가 점수 · API 사용성 기준"};
  if (format === "intelligence") return [scorePage, ...quality, ...gradingPages(run), conditions];
  const performance: ReportPage = {
    section: "performance",
    offset: 0,
    title: "응답 속도 · 지연 시간",
  };
  const integrity:ReportPage[] = run.summary?.metric_quality ? [{section:"metrics",offset:0,title:"계측 검증 · 수집 범위"}] : [];
  if (format === "performance")
    return [scorePage, performance, ...integrity, ...devicePages, ...offloadPages, ...gradingPages(run), conditions];
  return [scorePage, ...quality, performance, ...integrity, ...devicePages, ...offloadPages, ...gradingPages(run), conditions];
}
const pagesCache = new WeakMap<Obj, Map<Format, ReportPage[]>>();
function reportPages(run: Obj, format: Format) {
  let formats = pagesCache.get(run);
  if (!formats) {
    formats = new Map();
    pagesCache.set(run, formats);
  }
  let pages = formats.get(format);
  if (!pages) {
    pages = buildReportPages(run, format);
    formats.set(format, pages);
  }
  return pages;
}
function pageCount(run: Obj, format: Format) {
  return reportPages(run, format).length;
}

export function renderReport(
  run: Obj,
  format: Format,
  theme: Theme,
  page: number,
): string {
  const c = palettes[theme],
    summary = run.summary || {},
    cfg = run.config || {},
    items: Obj[] = run.items || [];
  const totalThroughput = aggregateThroughput(run);
  const pages = reportPages(run, format),
    index = Math.max(0, Math.min(page, pages.length - 1)),
    current = pages[index];
  const text = (
    x: number,
    y: number,
    value: any,
    size = 18,
    color = c.text,
    weight = 400,
    anchor = "start",
  ) =>
    `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escape(reportText(value))}</text>`;
  const block = (
    x: number,
    y: number,
    value: any,
    width: number,
    size = 16,
    max = 2,
    color = c.muted,
  ) =>
    wrap(reportText(value), width / (size * 0.9), max)
      .map((line, i) => text(x, y + i * (size + 6), line, size, color))
      .join("");
  const card = (x: number, y: number, width: number, height: number) =>
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${c.card}" stroke="${c.line}"/>`;
  const rule = (x: number, y: number, width: number) =>
    `<line x1="${x}" y1="${y}" x2="${x + width}" y2="${y}" stroke="${c.line}"/>`;
  const metric = (
    x: number,
    y: number,
    label: string,
    value: any,
    unit: string,
    n: any,
  ) =>
    card(x, y, 246, 102) +
    text(x + 18, y + 26, label, 15, c.muted, 600) +
    text(x + 18, y + 63, number(value), 29, c.text, 700) +
    text(x + 226, y + 63, unit, 13, c.muted, 400, "end") +
    text(
      x + 18,
      y + 86,
      finite(value) ? `${number(n ?? 0, 0)}건 측정` : "미수집",
      13,
      c.muted,
    );
  const trace = (
    x: number,
    y: number,
    title: string,
    unit: string,
    series: { timestamp: number; value: number | null }[],
  ) => {
    const width = 502,
      height = 150,
      valid = series.filter((v) => finite(v.value));
    let result =
      card(x, y, width, height) +
      text(x + 16, y + 25, `${title} (${unit})`, 15, c.text, 600);
    if (!valid.length)
      return result + text(x + 16, y + 77, "실측 미수집", 16, c.muted);
    const values = stats(valid.map((v) => v.value)),
      padding = Math.max(1, ((values.max || 0) - (values.min || 0)) * 0.1);
    const lower = Math.max(0, (values.min || 0) - padding),
      upper = (values.max || 0) + padding;
    const timestamps = series.map((v) => v.timestamp),
      timed = timestamps.every(Number.isFinite);
    const start = timed ? timestamps[0] : 0,
      finish = timed ? timestamps.at(-1)! : series.length - 1;
    const intervals = timestamps
      .slice(1)
      .map((t, i) => t - timestamps[i])
      .filter((v) => v > 0 && Number.isFinite(v))
      .sort((a, b) => a - b);
    const gapLimit = Math.max(
      15000,
      (intervals[Math.floor(intervals.length / 2)] || 5000) * 3,
    );
    const left = x + 49,
      right = x + width - 17,
      top = y + 48,
      bottom = y + 119;
    [upper, (upper + lower) / 2, lower].forEach((value, i) => {
      const yy = top + (i * (bottom - top)) / 2;
      result +=
        rule(left, yy, right - left) +
        text(left - 9, yy + 4, number(value, 1), 10, c.muted, 400, "end");
    });
    let segment: string[] = [],
      previous = NaN;
    const flush = () => {
      if (segment.length > 1)
        result += `<polyline points="${segment.join(" ")}" fill="none" stroke="${c.accent}" stroke-width="2"/>`;
      else if (segment.length === 1) {
        const [cx, cy] = segment[0].split(",");
        result += `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${c.accent}"/>`;
      }
      segment = [];
    };
    series.forEach((point, i) => {
      if (!finite(point.value)) {
        flush();
        previous = NaN;
        return;
      }
      if (timed && finite(previous) && point.timestamp - previous > gapLimit)
        flush();
      const xx =
        left +
        ((timed ? point.timestamp - start : i) / Math.max(1, finish - start)) *
          (right - left);
      const yy =
        bottom -
        ((point.value - lower) / Math.max(1, upper - lower)) * (bottom - top);
      segment.push(`${xx},${yy}`);
      previous = point.timestamp;
    });
    flush();
    const stamp = (value: number) =>
      new Date(value).toLocaleTimeString("ko-KR", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    result +=
      text(left, y + 140, timed ? stamp(start) : "첫 표본", 10, c.muted) +
      text(
        right,
        y + 140,
        timed ? stamp(finish) : "마지막 표본",
        10,
        c.muted,
        400,
        "end",
      );
    return result;
  };
  const profile = cfg.pack_id?.startsWith("timed-") ? benchmarkLabel(cfg.pack_id) + " · 고정 발췌" :
    (
      {
        "10m": "10분", "1h": "1시간", "4h": "4시간", "8h": "8시간",
        quick: "빠른 시험",
        full: "전체 시험",
        standard: "기존 표본 시험",
        "historical-75": "기존 실측 표본",
      } as Obj
    )[cfg.profile] || "사용자 지정 시험";
  let body =
    text(48, 42, run.provenance === "imported_record" ? "HOMELAB BENCH / 가져온 기록 · 실행 미검증" : "HOMELAB BENCH / 홈랩 벤치", 13, c.accent, 700) +
    text(1072, 42, formats[format], 15, c.muted, 600, "end");
  body +=
    block(48, 84, cfg.name || "모델 평가 보고서", 1010, 28, 2, c.text) +
    block(48, 144, cfg.model || "모델 미기록", 1010, 16, 1) +
    text(
      48,
      173,
      `${time(run.created_at)} · ${profile} · ${number(summary.completed, 0)} / ${number(summary.total, 0)}문항 처리${summary.score_errors > 0 ? ` · ${run.status === "completed" ? "답변 수집 완료 · " : ""}채점 실패 ${number(summary.score_errors, 0)}건` : ""}`,
      14,
      c.muted,
    ) +
    rule(48, 191, 1024);
  body += text(48, 224, current.title, 22, c.text, 700);
  if (current.section === "score") {
    const assessment = assessRun(run), ref = assessment.reference;
    const scoreValue = (score: Obj) => score.value != null ? number(score.value,1) : score.lower != null ? `${number(score.lower,1)}–${number(score.upper,1)}` : "미산출";
    ([["종합",assessment.currentScores.overall,"/100"],["지능",assessment.currentScores.intelligence,"/100"],["성능",assessment.currentScores.performance,"점 · 상한 없음"]] as const).forEach(([label,score,unit],i) => {
      const x=48+i*348;
      body += card(x,253,328,125)+text(x+20,281,label,16,c.muted)+text(x+20,321,scoreValue(score),32,c.text,700)+text(x+20,353,unit,13,c.muted);
    });
    body += block(48,411,ref.status === "ready" ? `기준 API: ${ref.model} · ${ref.reasoning_effort} · ${time(ref.measured_at)} · 1,000점` : "프론티어 기준 측정 준비 중",1024,17,2,c.text);
    body += block(48,460,`${assessment.currentScores.intelligence.state === "complete" ? "평가 완료" : "잠정·부분 평가"} · 채점 ${assessment.currentScores.scored}/${assessment.currentScores.selected} · ${assessment.currentScores.evaluatedDomains.join(" · ")}`,1024,15,3,c.muted);
    const e=assessment.performanceEvidence;
    body += text(70,537,"시험 중 측정",14,c.muted)+text(680,537,"이번 시험",14,c.muted,400,"end")+text(1048,537,"Sol c1 기준값",14,c.muted,400,"end")+rule(70,549,978);
    [["단일 Decode (tok/s)",e.concurrentDecodeTps,e.baselineDecode],["TTFT (ms)",e.ttftMedian,e.baselineTtft]].forEach(([label,value,baseline],i)=>{
      const y=583+i*42;
      body+=text(70,y,label,16,c.text)+text(680,y,number(value as number),18,c.text,600,"end")+text(1048,y,number(baseline as number),16,c.text,400,"end");
    });
    body += block(70,663,`단일 유효 ${number(e.pairedCount,0)}건 · 기본 ${e.singleScore == null ? "미측정" : number(e.singleScore,0)+"점"} · 동시 처리 ${e.bonusState === "measured" ? "+"+number(e.concurrencyBonus || 0,0)+"점 (+"+number(e.concurrencyBonusPercent || 0)+"%)" : e.bonusState === "no_gain" ? "가산 없음" : e.bonusState === "pending" ? "확인 중" : "미측정"}`,978,13,1,c.muted);
    body += block(70,689,`${e.bonusReason || "동시 처리 효과 미측정"} · ${assessment.policy}`,978,12,2,c.muted);
    body += block(48,744,"기본 = 1,000 × √((단일 Decode / 기준) × (기준 TTFT / 단일 TTFT)). 같은 표본의 처리량 이득 2배마다 기본의 10%, 최대 30%를 가산합니다. 가산 비중은 베타 정책입니다. 종합은 지능70%·성능30%로 100점까지 표시합니다.",1024,13,3,c.muted);
  } else if (current.section === "intelligence") {
    const allSubjects = benchmarkResults(run);
    const subjects = allSubjects.slice(current.offset, current.offset + 7);
    const scored = allSubjects.reduce(
      (n, [, value]) => n + (value.scored || 0),
      0,
    );
    body +=
      text(1072, 224, "채점된 문항 기준", 14, c.muted, 400, "end") +
      card(48, 247, 1024, 385);
    body +=
      text(70, 278, "평가 목적 · 벤치마크", 14, c.muted, 600) +
      text(880, 278, "점수", 14, c.muted, 600, "end") +
      text(1048, 278, "채점 / 선택 문항", 14, c.muted, 600, "end") +
      rule(70, 293, 978);
    subjects.forEach(([name, value], i) => {
      const y = 331 + i * 43,
        pct = finite(value.percent) ? value.percent : null;
      body +=
        block(70, y, name, 435, 15, 1, c.text) +
        `<rect x="520" y="${y - 11}" width="245" height="11" rx="5" fill="${c.line}"/>` +
        (pct === null
          ? ""
          : `<rect x="520" y="${y - 11}" width="${(245 * Math.max(0, Math.min(100, pct))) / 100}" height="11" rx="5" fill="${c.accent}"/>`) +
        text(
          880,
          y,
          pct === null ? "미채점" : `${number(pct)}%`,
          20,
          pct === null ? c.muted : c.text,
          700,
          "end",
        ) +
        text(
          1048,
          y,
          `${number(value.scored, 0)} / ${number(value.total, 0)}`,
          15,
          c.muted,
          400,
          "end",
        );
    });
    if (!subjects.length)
      body += text(70, 345, summary.measured ? "성능 전용 시험입니다. 지능 평가는 실시하지 않았습니다." : "채점 결과가 아직 없습니다.", 18, c.muted);
    [
      ["채점 완료", `${number(scored, 0)} / ${number(summary.quality_total ?? summary.total, 0)}`],
      ["요청 오류", `${number(summary.errors || 0, 0)}건`],
      ["채점 실패", `${number(summary.score_errors || 0, 0)}건`],
      ["출력 잘림", `${number(summary.truncated || 0, 0)}건`],
    ].forEach(([label, value], i) => {
      const x = 48 + i * 260;
      body +=
        card(x, 650, 244, 88) +
        text(x + 17, 677, label, 14, c.muted) +
        text(x + 17, 713, value, 24, c.text, 700);
    });
    body += block(
      48,
      756,
      (cfg.pack_id === "basic-bench-v2" || cfg.pack_id?.startsWith("timed-")
        ? "시간 기준 고정 발췌이며 공식 원본 전체 점수와 구분합니다. "
        : cfg.profile === "quick"
          ? "고정된 빠른 시험 표본이며 전체 평가 점수와 구분합니다. "
          : "벤치마크별 채점 기준을 사용합니다. ") +
      (allSubjects.some(([, value]) => value.reference)
        ? "자체 정형 지시는 JSON 형식·값 준수 참고 결과이며 일반 한국어 능력이나 종합 능력 점수가 아닙니다."
        : run.items?.some((item: Obj) => taskBenchmarkKey(item.task) === "bbh")
          ? "BBH는 문항 정확도로 표시하는 별도 확장 평가이며 고정 지능·종합 점수에는 포함하지 않습니다."
          : "요청 오류·채점 실패·출력 잘림을 점수와 함께 확인하세요."),
      1024,
      14,
      2,
    );
  } else if (current.section === "grading") {
    const failures = gradingFailures(run);
    body += block(48, 261, "답변과 채점 상태를 구분합니다. 아래 문항은 점수가 산출되지 않았으며 모델 오답이나 0점에 포함하지 않습니다.", 1024, 15, 2);
    failures.slice(current.offset, current.offset + 4).forEach((failure, i) => {
      const y = 305 + i * 110;
      body += card(48, y, 1024, 97) + block(68, y + 24, `${failure.label} · ${failure.count}문항`, 976, 15, 1, c.bad) + block(68, y + 50, failure.detail, 976, 13, 2, c.text);
    });
    body += block(48, 768, "환경 오류는 복구 후 재채점할 수 있습니다. 원본 자료 불완전은 교정된 평가팩이 필요합니다. 상세 사유를 확인하세요.", 1024, 13, 1);
  } else if (current.section === "performance") {
    body +=
      metric(
        48,
        246,
        "Decode · 요청당",
        summary.decode_tps?.median,
        "tok/s",
        summary.decode_tps?.n,
      ) +
      metric(
        308,
        246,
        "TTFT",
        summary.ttft_ms?.median,
        "ms",
        summary.ttft_ms?.n,
      ) +
      metric(
        568,
        246,
        "Prefill",
        summary.prefill_tps?.median,
        "tok/s",
        summary.prefill_tps?.n,
      ) +
      metric(
        828,
        246,
        "Throughput · 추론 포함",
        totalThroughput.tps,
        "tok/s",
        totalThroughput.n,
      );
    body +=
      card(48, 367, 1024, 221) +
      text(70, 397, "문항별 Decode", 19, c.text, 700) +
      text(1048, 397, "tok/s · 문항 순서", 13, c.muted, 400, "end");
    const values = items
      .map((item, i) => ({
        x: i,
        v: measuredDecode(item),
      }))
      .filter((value) => finite(value.v));
    if (values.length) {
      const max = values.reduce((n, v) => Math.max(n, v.v), 1);
      for (let i = 0; i <= 3; i++) {
        const y = 427 + i * 39;
        body +=
          rule(112, y, 928) +
          text(
            98,
            y + 4,
            number((max * (3 - i)) / 3, 0),
            12,
            c.muted,
            400,
            "end",
          );
      }
      let segment: string[] = [];
      const segments: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const value = measuredDecode(items[i]);
        if (finite(value))
          segment.push(
            `${112 + (i / Math.max(1, items.length - 1)) * 928},${544 - (value / max) * 117}`,
          );
        else if (segment.length) {
          segments.push(segment.join(" "));
          segment = [];
        }
      }
      if (segment.length) segments.push(segment.join(" "));
      segments.forEach((points) => {
        if (points.includes(" "))
          body += `<polyline points="${points}" fill="none" stroke="${c.accent}" stroke-width="2.3"/>`;
        else {
          const [x, y] = points.split(",");
          body += `<circle cx="${x}" cy="${y}" r="3" fill="${c.accent}"/>`;
        }
      });
      body +=
        text(112, 568, "1", 12, c.muted) +
        text(
          1040,
          568,
          `${number(items.length, 0)}문항`,
          12,
          c.muted,
          400,
          "end",
        );
    } else body += text(70, 466, "Decode 측정값이 없습니다.", 18, c.muted);
    body +=
      card(48, 606, 1024, 135) +
      text(70, 633, "측정 범위", 17, c.text, 700) +
      text(400, 633, "최소", 13, c.muted, 400, "end") +
      text(585, 633, "중앙값", 13, c.muted, 400, "end") +
      text(770, 633, "최대", 13, c.muted, 400, "end") +
      text(1048, 633, "유효 문항", 13, c.muted, 400, "end");
    [
      ["Decode", "decode_tps", " tok/s"],
      ["TTFT", "ttft_ms", " ms"],
      ["Prefill", "prefill_tps", " tok/s"],
    ].forEach(([label, key, unit], i) => {
      const y = 663 + i * 27,
        v = summary[key];
      body +=
        text(70, y, label, 14, c.text) +
        text(400, y, display(v?.min, unit), 14, c.text, 400, "end") +
        text(585, y, display(v?.median, unit), 14, c.text, 400, "end") +
        text(770, y, display(v?.max, unit), 14, c.text, 400, "end") +
        text(
          1048,
          y,
          finite(v?.median) ? `${v.n || 0}건` : "미수집",
          14,
          c.muted,
          400,
          "end",
        );
    });
    const quality = summary.metric_quality;
    if (quality) {
      const notes = ["decode_tps","ttft_ms","prefill_tps"].map(key=> {
        const v=quality.metrics?.[key] || {};
        return `${({decode_tps:"Decode",ttft_ms:"TTFT",prefill_tps:"Prefill"} as Obj)[key]} 제외 ${v.excluded || 0} · 미수집 ${v.missing || 0}`;
      });
      body += text(70,733,notes.join(" / "),11,c.muted);
    }
    body += text(
      48,
      759,
      `동시 ${totalThroughput.scope.concurrency} · 가시 출력 ${display(totalThroughput.visible_tps, " tok/s")} · 추론 ${display(totalThroughput.reasoning_tps, " tok/s")} · 동일 유효 응답 ${totalThroughput.n}건`,
      12,
      c.muted,
    );
    body += block(
      48,
      781,
      "Throughput = 추론 포함 출력 합계 ÷ 첫 요청 시작~마지막 완료. Prefill·채점 간격·대기·일시정지 포함.",
      1024,
      12,
      1,
    );
  } else if (current.section === "metrics") {
    const q = summary.metric_quality || {}, scope = summary.metric_scope || {};
    body += block(48,265,`동시 ${scope.concurrency || cfg.concurrency} 구간 · 검증 대상 ${q.eligible || 0}건 · ${q.version || ""}`,1024,17,2,c.text);
    let y=332;
    body += text(70,y,"Throughput · 추론 포함",18,c.text,700)+text(1048,y,`유효 ${totalThroughput.n} · 제외 ${totalThroughput.excluded} · 미수집 ${totalThroughput.missing}`,15,c.text,400,"end");
    const totalReasons = Object.entries(totalThroughput.reasons).map(([reason,count])=>`${throughputReason[reason]||reason} ${count}건`).join(" · ");
    body += block(70,y+28,totalReasons || "전체 출력 토큰 기준 · 원본 보존",978,12,2,c.muted); y+=66;
    for (const [key,label] of [["decode_tps","Decode"],["client_visible_decode_tps","가시 출력 Decode"],["ttft_ms","TTFT"],["prefill_tps","Prefill"],["throughput","가시 출력 Throughput"]]) {
      const v=q.metrics?.[key] || {};
      body += text(70,y,label,18,c.text,700)+text(1048,y,`유효 ${v.valid||0} · 제외 ${v.excluded||0} · 미수집 ${v.missing||0}`,15,c.text,400,"end");
      const reasons = Object.entries(v.reasons||{}).map(([reason,count])=>`${metricReason[reason]||reason} ${count}건`).join(" · ");
      body += block(70,y+28,reasons || "제외 없음",978,12,2,c.muted); y+=66;
    }
    body += block(48,760,"원본 측정값은 보존합니다. 수신 구간 100ms 미만의 클라이언트 Decode와 시간·토큰 집계 오류를 제외하며, 실제 지연은 유지합니다.",1024,13,3,c.muted);
  } else if (current.section === "hardware") {
    const h = hardware(run),
      latest = h.last,
      selection = latest.gpu_selection || {},
      requested = cfg.device?.gpu_indices || [];
    const scope =
      selection.mode === "selected" || requested.length
        ? "선택한 GPU의 관측값"
        : "장비에서 관측된 전체 GPU";
    body += text(1072, 224, scope, 13, c.muted, 400, "end");
    body +=
      card(48, 246, 1024, 127) +
      block(
        70,
        275,
        `${cfg.device_name || "장비 미선택"} · ${observed(latest.cpu_model)}`,
        980,
        17,
        1,
        c.text,
      );
    body +=
      text(
        70,
        308,
        `CPU 코어 ${display(latest.cpu_physical_cores, "", 0)} / 스레드 ${display(latest.cpu_logical_cores, "", 0)}`,
        14,
        c.muted,
      ) +
      text(
        600,
        308,
        `RAM 용량 ${display(finite(latest.ram_total_bytes) ? latest.ram_total_bytes / 1024 ** 3 : null, " GiB")}`,
        14,
        c.muted,
      );
    body +=
      text(
        70,
        345,
        `CPU 사용률 평균 / 최고   ${display(h.cpu.avg, "%")} / ${display(h.cpu.max, "%")}`,
        14,
        c.text,
      ) +
      text(
        600,
        345,
        `RAM 사용량 평균 / 최고   ${display(finite(h.ram.avg) ? h.ram.avg / 1024 ** 3 : null, " GiB")} / ${display(finite(h.ram.max) ? h.ram.max / 1024 ** 3 : null, " GiB")}`,
        14,
        c.text,
      );
    const gpuRows = h.gpus.slice(current.offset, current.offset + 4);
    if (gpuRows.length === 1) {
      const record = gpuRows[0],
        gpu = record.latest;
      body +=
        card(48, 392, 1024, 152) +
        block(
          66,
          419,
          `GPU ${gpu.index ?? record.key} · ${gpu.name || "이름 미수집"}`,
          984,
          19,
          1,
          c.text,
        );
      body += block(
        66,
        441,
        `VRAM ${display(finite(gpu.vram_total_mib) ? gpu.vram_total_mib / 1024 : null, " GiB")} · PCIe 관측 ${finite(gpu.pcie_gen) ? `Gen${gpu.pcie_gen}` : "미수집"} ${finite(gpu.pcie_width) ? `×${gpu.pcie_width}` : ""} · Driver ${observed(gpu.driver_version)} · 전력 제한 ${display(gpu.power_limit_w, " W")} · Memory Clock ${display(gpu.memory_clock_mhz, " MHz", 0)}`,
        984,
        12,
        1,
      );
      const leftRows = [
        [
          "사용률 평균 / 최고",
          `${display(record.util.avg, "%")} / ${display(record.util.max, "%")}`,
        ],
        [
          "온도 평균 / 최고",
          `${display(record.temp.avg, "°C")} / ${display(record.temp.max, "°C")}`,
        ],
        [
          "보드 전력 평균 / 최고",
          `${display(record.power.avg, " W")} / ${display(record.power.max, " W")}`,
        ],
      ];
      const rightRows = [
        [
          "VRAM 사용 최고",
          display(
            finite(record.vram.max) ? record.vram.max / 1024 : null,
            " GiB",
          ),
        ],
        [
          "GPU Clock 평균 / 최고",
          `${display(record.clocks.avg, " MHz", 0)} / ${display(record.clocks.max, " MHz", 0)}`,
        ],
        [
          "제한 동작 / 판정 표본",
          record.throttleKnown
            ? `${record.throttle} / ${record.throttleKnown} · 미확인 ${record.throttleUnknown}`
            : `미확인 ${record.throttleUnknown}표본`,
        ],
      ];
      [leftRows, rightRows].forEach((rows, column) =>
        rows.forEach(([label, value], i) => {
          const x = column ? 586 : 66,
            yy = 470 + i * 26;
          body +=
            text(x, yy, label, 13, c.muted) +
            text(column ? 1052 : 532, yy, value, 15, c.text, 600, "end");
        }),
      );
      const series = (field: string) =>
        h.samples.map((sample) => {
          const row = validSensorSample(sample)
            ? (sample.data.gpus || []).find(
                (g: Obj) =>
                  String(g.index ?? g.name ?? "unknown") === record.key,
              )
            : null;
          return {
            timestamp: Date.parse(sample.received_at || sample.data?.timestamp),
            value: finite(row?.[field]) ? (row[field] as number) : null,
          };
        });
      body +=
        trace(48, 562, "GPU 온도", "°C", series("temperature_c")) +
        trace(570, 562, "GPU 보드 전력", "W", series("power_w"));
    } else
      gpuRows.forEach((record, i) => {
        const x = 48 + (i % 2) * 520,
          y = 392 + Math.floor(i / 2) * 168,
          gpu = record.latest;
        body +=
          card(x, y, 504, 152) +
          block(
            x + 16,
            y + 24,
            `GPU ${gpu.index ?? record.key} · ${gpu.name || "이름 미수집"}`,
            472,
            16,
            1,
            c.text,
          ) +
          text(
            x + 16,
            y + 44,
            `VRAM ${display(finite(gpu.vram_total_mib) ? gpu.vram_total_mib / 1024 : null, " GiB")} · PCIe 관측 ${finite(gpu.pcie_gen) ? `Gen${gpu.pcie_gen}` : "미수집"} ${finite(gpu.pcie_width) ? `×${gpu.pcie_width}` : ""}`,
            12,
            c.muted,
          ) +
          text(
            x + 16,
            y + 62,
            `Driver ${observed(gpu.driver_version)} · 전력 제한 ${display(gpu.power_limit_w, " W")}`,
            11,
            c.muted,
          );
        const rows = [
          [
            "사용률 평균 / 최고",
            `${display(record.util.avg, "%")} / ${display(record.util.max, "%")}`,
          ],
          [
            "온도 평균 / 최고",
            `${display(record.temp.avg, "°C")} / ${display(record.temp.max, "°C")}`,
          ],
          [
            "보드 전력 평균 / 최고",
            `${display(record.power.avg, " W")} / ${display(record.power.max, " W")}`,
          ],
          [
            "VRAM 사용 최고",
            display(
              finite(record.vram.max) ? record.vram.max / 1024 : null,
              " GiB",
            ),
          ],
        ];
        rows.forEach(([label, value], j) => {
          const yy = y + 82 + j * 18;
          body +=
            text(x + 16, yy, label, 13, c.muted) +
            text(x + 486, yy, value, 14, c.text, 500, "end");
        });
      });
    if (!gpuRows.length)
      body +=
        card(48, 392, 1024, 270) +
        text(70, 435, "GPU 실측 미수집", 22, c.muted, 600) +
        block(
          70,
          471,
          "이 실행에 저장된 GPU 온도·전력·사용률 표본이 없습니다.",
          970,
          16,
          2,
        );
    const first = h.usable[0]?.received_at,
      last = h.usable.at(-1)?.received_at;
    body += text(
      48,
      739,
      `유효 표본 ${h.usable.length} / ${h.samples.length}개 · ${first ? time(first) : "시작 미수집"} ~ ${last ? time(last) : "종료 미수집"} · 평균은 표본 산술평균`,
      13,
      c.muted,
    );
    body += text(
      48,
      h.missingGpuIndices.length ? 760 : 766,
      "CPU·RAM은 장비 전체, 전력은 GPU 보드 기준입니다. 수집 대상만으로 모델이 사용한 GPU를 확정하지 않습니다.",
      13,
      c.muted,
    );
    if (h.missingGpuIndices.length)
      body += text(
        48,
        781,
        `일부 표본에서 GPU ${h.missingGpuIndices.join(", ")} 미수집 · 관측된 GPU 값은 보존했습니다.`,
        12,
        c.bad,
      );
  } else if (current.section === "offload") {
    const h = hardware(run),
      offload = h.last.offload || {},
      nodes: Obj[] = offload.numa_nodes || [],
      disks: Obj[] = offload.storage || [];
    body +=
      card(48, 246, 1024, 170) +
      text(70, 276, "NUMA 메모리 · 마지막 관측", 18, c.text, 700);
    nodes
      .slice(current.offset * 3, current.offset * 3 + 3)
      .forEach((node, i) => {
        const x = 70 + i * 327;
        body +=
          text(x, 311, `Node ${node.index}`, 17, c.text, 600) +
          text(
            x,
            340,
            `총량 ${display(finite(node.ram_total_bytes) ? node.ram_total_bytes / 1024 ** 3 : null, " GiB")}`,
            14,
            c.muted,
          ) +
          text(
            x,
            366,
            `Free (빈 페이지) ${display(finite(node.ram_free_bytes) ? node.ram_free_bytes / 1024 ** 3 : null, " GiB")}`,
            14,
            c.muted,
          );
      });
    if (!nodes.length) body += text(70, 323, "NUMA 메모리 미수집", 17, c.muted);
    body += text(
      70,
      397,
      `NUMA별 MemFree 관측값 · Swap 사용 최고 ${display(finite(h.swap.max) ? h.swap.max / 1024 ** 3 : null, " GiB")} · 장비 전체`,
      13,
      c.muted,
    );
    body +=
      card(48, 435, 1024, 266) +
      text(70, 466, "저장장치 · 읽기 관측", 18, c.text, 700);
    disks
      .slice(current.offset * 4, current.offset * 4 + 4)
      .forEach((disk, i) => {
        const y = 503 + i * 44;
        const readings = h.usable.flatMap((v) =>
          (v.data.offload?.storage || [])
            .filter((d: Obj) => d.index === disk.index)
            .map((d: Obj) => d.read_bytes_per_s),
        );
        const read = stats(readings);
        body +=
          block(
            70,
            y,
            `${observed(disk.model)} · ${["SSD", "HDD"].includes(disk.media) ? disk.media : "유형 미수집"} · ${observed(disk.transport)}`,
            600,
            14,
            1,
            c.text,
          ) +
          text(
            1048,
            y,
            `${display(finite(read.avg) ? read.avg / 1024 ** 2 : null, " MiB/s")} 평균`,
            14,
            c.text,
            500,
            "end",
          ) +
          text(
            70,
            y + 21,
            `용량 ${display(finite(disk.capacity_bytes) ? disk.capacity_bytes / 1024 ** 3 : null, " GiB")} · 최고 ${display(finite(read.max) ? read.max / 1024 ** 2 : null, " MiB/s")}`,
            12,
            c.muted,
          );
      });
    if (!disks.length)
      body += text(70, 515, "저장장치 읽기속도 미수집", 17, c.muted);
    body += block(
      48,
      737,
      "NUMA·디스크 수치는 장비 전체의 관측값입니다. 모델 전용 메모리·Offload 전송량으로 해석하지 않습니다.",
      1024,
      14,
      2,
    );
  } else if (current.section === "conditions") {
    const info = cfg.execution_info || {},
      device = hardware(run),
      rows: [string, string][] = [
        ["모델 ID", known(cfg.model)],
        [
          "엔진 / 버전",
          `${known(info.engine)} / ${known(info.engine_version)}`,
        ],
        [
          "체크포인트 / 양자화",
          `${known(info.model_revision)} / ${known(info.quantization)}`,
        ],
        [
          "Context / 병렬 구성",
          `${known(info.context_length)} / ${known(info.parallelism)}`,
        ],
        [
          "Speculative / Cache",
          `${known(info.speculative)} / ${known(info.cache)}`,
        ],
        ["Offload", known(info.offload)],
        [
          "샘플링 / 출력 한도",
          `Temperature ${temperatureOmitted(cfg) ? "공급자 기본 (미전송)" : number(cfg.temperature)} · 최대 ${number(cfg.max_tokens, 0)} tokens · 추론 강도 ${cfg.reasoning_effort || "서버 기본"}`,
        ],
        [
          "동시 요청 / 제한시간",
          `${number(cfg.concurrency, 0)}개 · 문항당 ${number(cfg.timeout_s, 0)}초 · 실행 ${duration(summary.active_ms || run.active_ms || 0)}`,
        ],
        [
          "평가팩 / 범위",
          `${benchmarkLabel(cfg.pack_id)} · v${known(run.pack_version)} · ${profile} · ${number(summary.total, 0)}문항`,
        ],
        ["채점 모델", cfg.judge?.model ? cfg.judge.model : "규칙·실행 채점"],
        ["API 시간 측정", "벤치 실행기 → 모델 API · 브라우저 표시 지연 제외"],
        ["장비 수집 위치", cfg.device ? ({local:"벤치 앱 실행 장비 · 명시 선택",http:"별도 수집기가 실행되는 장비",ssh:"선택한 SSH 대상 장비"}[cfg.device.mode as string] || "선택한 장비") : cfg.telemetry_url ? "지정된 장비 수집기" : "장비 수집 안 함"],
        ["실행 정보 출처", known(info.provenance)],
      ];
    body += card(48, 246, 1024, 409);
    rows.forEach(([label, value], i) => {
      const y = 274 + i * 29;
      body +=
        text(70, y, label, 14, c.muted) +
        block(305, y, value, 745, 14, 1, c.text);
      if (i < rows.length - 1) body += rule(70, y + 13, 978);
    });
    body += block(
      48,
      683,
      cfg.note
        ? `메모: ${cfg.note}`
        : "모델 실행 정보의 빈 항목은 미기록입니다. 실행 정보는 기록된 설정을 사용합니다.",
      1024,
      14,
      2,
    );
    const gpuNotes = device.gpus.slice(0, 4).map((v) => {
      const gpu = v.latest;
      const throttle = v.throttleKnown
        ? `${v.throttle}/${v.throttleKnown}표본 · 미확인 ${v.throttleUnknown}`
        : `미확인 ${v.throttleUnknown}표본`;
      return `GPU ${gpu.index ?? v.key}: Driver ${observed(gpu.driver_version)}, 제한 ${display(gpu.power_limit_w, " W")}, 제한 동작 ${throttle}`;
    });
    body += block(
      48,
      735,
      gpuNotes.length
        ? gpuNotes.join(" · ")
        : "GPU Driver·전력 제한·제한 동작 이력 미수집",
      1024,
      12,
      2,
    );
  } else {
    body +=
      text(
        1072,
        224,
        `${current.offset + 1}–${Math.min(current.offset + 12, items.length)} / ${number(items.length, 0)}문항`,
        14,
        c.muted,
        400,
        "end",
      ) +
      `<rect x="48" y="249" width="1024" height="36" rx="5" fill="${c.accentBg}"/>`;
    [
      [62, "문항"],
      [397, "과목"],
      [636, "채점"],
      [828, "TTFT (ms)"],
      [970, "Decode (tok/s)"],
    ].forEach(
      ([x, label]) => (body += text(x as number, 273, label, 14, c.text, 600)),
    );
    items.slice(current.offset, current.offset + 12).forEach((item, i) => {
      const y = 319 + i * 34,
        attempt = item.attempts?.at(-1),
        score = attempt?.score;
      body +=
        block(62, y, item.task.id, 310, 14, 1, c.text) +
        block(397, y - 5, taskBenchmarkLabel(item.task), 224, 11, 2) +
        text(
          636,
          y,
          score?.value === 1
            ? "정답"
            : score?.value === 0
              ? "오답"
              : finite(score?.value)
                ? `${number(score.value * 100)}%`
                : score?.state === "measured"
                  ? score.extra?.valid_output === false ? "검증 실패" : "측정 완료"
                : score && !finite(score.value) && !["pending", "running", "measured"].includes(score.state)
                  ? "채점 실패"
                : item.status === "error"
                  ? "요청 오류"
                  : "미채점",
          14,
          score?.value === 0 ? c.bad : c.text,
        ) +
        text(
          925,
          y,
          number(attempt && validMetric(attempt,"ttft_ms") ? attempt.metrics?.ttft_ms : null),
          14,
          c.text,
          400,
          "end",
        ) +
        text(
          1060,
          y,
          number(attempt && validMetric(attempt,"decode_tps") ? attempt.metrics?.decode_tps : null),
          14,
          c.text,
          400,
          "end",
        ) +
        rule(48, y + 12, 1024);
    });
    body += block(
      48,
      767,
      "문제·답변·정답·채점 근거 원문은 시험 화면과 JSON 기록에서 확인할 수 있습니다.",
      1024,
      14,
      1,
    );
  }
  body +=
    rule(48, 794, 1024) +
    block(
      48,
      817,
      `${benchmarkLabel(cfg.pack_id)} · ${String(run.suite_hash || "해시 미기록").slice(0, 12)} · ${current.title}`,
      880,
      12,
      1,
    ) +
    text(1072, 817, `${index + 1} / ${pages.length}`, 13, c.muted, 600, "end");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="840" viewBox="0 0 1120 840" role="img" aria-label="${escape(formats[format] + " · " + current.title)}" font-family="-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif"><rect width="1120" height="840" fill="${c.bg}"/>${body}</svg>`;
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function savedChoice<T extends string>(key: string, choices: Record<T, string>, fallback: T): T {
  try {
    const value = localStorage.getItem(`bench-report-${key}`);
    return value && Object.hasOwn(choices, value) ? value as T : fallback;
  } catch { return fallback; }
}
function savedPage(): number {
  try {
    const value = Number(localStorage.getItem("bench-report-page"));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch { return 0; }
}
function rememberChoice(key: string, value: string) {
  try { localStorage.setItem(`bench-report-${key}`, value); } catch { /* Browsing without local storage remains supported. */ }
}
export function Report({
  run: sourceRun,
  onError,
}: {
  run: Obj;
  onError: (message: string) => void;
}) {
  const [history, setHistory] = useState<{id:string; rows:Obj[]; count:number}|null>(null);
  const historyRef = useRef(history);
  const [historyError, setHistoryError] = useState("");
  const [historyRetry, setHistoryRetry] = useState(0);
  historyRef.current = history;
  const totalTelemetry = sourceRun.telemetry_count ?? sourceRun.telemetry?.length ?? 0;
  useEffect(() => {
    if (!sourceRun.telemetry_truncated) return;
    const controller = new AbortController();
    const old = historyRef.current?.id === sourceRun.id ? historyRef.current : null;
    const after = old?.count ?? 0;
    setHistoryError("");
    fetch(`/api/runs/${encodeURIComponent(sourceRun.id)}/telemetry?after=${after}`, {signal:controller.signal})
      .then(async response => {if(!response.ok) throw Error("장비 이력을 불러오지 못했습니다.");return response.json();})
      .then(value => {
        if(controller.signal.aborted) return;
        if(value.after !== after || !Array.isArray(value.telemetry) || value.telemetry.length + after !== value.telemetry_count) throw Error("장비 이력 수가 일치하지 않습니다.");
        setHistory({id:sourceRun.id, rows:[...(old?.rows ?? []),...value.telemetry], count:value.telemetry_count});
      }).catch(error=>{if(!controller.signal.aborted)setHistoryError(String(error).replace(/^Error: /,""));});
    return ()=>controller.abort();
  }, [sourceRun.id, sourceRun.status, sourceRun.telemetry_truncated, Math.floor(totalTelemetry / 30), historyRetry]);
  const run = useMemo(() => {
    if (!sourceRun.telemetry_truncated) return sourceRun;
    if (!history || history.id !== sourceRun.id) return {...sourceRun,telemetry:[]};
    const tail = sourceRun.telemetry || [], delta = totalTelemetry - history.count;
    const rows = delta >= 0 && delta <= tail.length ? [...history.rows, ...tail.slice(tail.length-delta)] : history.rows;
    return {...sourceRun,telemetry:rows,telemetry_count:rows.length,telemetry_truncated:false};
  }, [sourceRun, history]);
  const historyLoading = sourceRun.telemetry_truncated && (!history || history.id !== sourceRun.id || totalTelemetry - history.count > (sourceRun.telemetry?.length ?? 0));
  const [format, setFormat] = useState<Format>(() => savedChoice("format", formats, "overview")),
    [theme, setTheme] = useState<Theme>(() => savedChoice("theme", themes, "light")),
    [page, setPage] = useState(savedPage),
    [save, setSave] = useState(false),
    [busy, setBusy] = useState(false);
  const [savedFile, setSavedFile] = useState<{
    url: string;
    name: string;
    runId: string;
  } | null>(null);
  const currentRun = useRef(run.id), mounted = useRef(true), exportGeneration = useRef(0);
  currentRun.current = run.id;
  const pages = reportPages(run, format),
    count = pageCount(run, format),
    actualPage = Math.max(0, Math.min(page, count - 1));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; exportGeneration.current++; };
  }, []);
  useEffect(() => { rememberChoice("format", format); }, [format]);
  useEffect(() => { rememberChoice("theme", theme); }, [theme]);
  useEffect(() => {
    setPage(actualPage);
    rememberChoice("page", String(actualPage));
  }, [actualPage]);
  useEffect(() => {
    exportGeneration.current++;
    setSavedFile(null);
    setSave(false);
    setBusy(false);
  }, [run.id]);
  const svg = useMemo(
    () => renderReport(run, format, theme, actualPage),
    [run, format, theme, actualPage],
  );
  async function saveImage(blob: Blob, name: string, runId: string, generation: number) {
    const response = await fetch("/api/artifacts", {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
    });
    if (!response.ok) {
      download(blob, name);
      return;
    }
    const value = await response.json();
    if (mounted.current && currentRun.current === runId && exportGeneration.current === generation)
      setSavedFile({ url: value.url, name, runId });
    const link = document.createElement("a");
    link.href = value.url;
    link.download = name;
    link.click();
  }
  async function exportReport(type: string) {
    const runId = run.id, generation = ++exportGeneration.current;
    setBusy(true);
    onError("");
    try {
      const packName = benchmarkLabel(run.config?.pack_id).replace(/[\\/:*?"<>|]/g, "-");
      const name = `homelab-bench-${packName}-${runId.slice(0, 8)}-${format}-${theme}-${actualPage + 1}`;
      // Open while the click still has user activation; report assembly may take time.
      const printWindow = type === "pdf" ? window.open("", "_blank") : null;
      if (type === "pdf" && !printWindow)
        throw Error(
          "인쇄 창이 차단됐습니다. 팝업을 허용한 뒤 다시 눌러 주세요.",
        );
      if (type === "json") {
        window.location.href = `/api/export/${encodeURIComponent(run.id)}?format=json`;
        return;
      }
      if (type === "svg") {
        await saveImage(
          new Blob([svg], { type: "image/svg+xml" }),
          name + ".svg",
          runId,
          generation,
        );
        return;
      }
      if (type === "png") {
        const image = new Image(),
          source = URL.createObjectURL(
            new Blob([svg], { type: "image/svg+xml" }),
          );
        try {
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () =>
              reject(Error("이미지를 만들지 못했습니다. SVG로 저장해 주세요."));
            image.src = source;
          });
          const canvas = document.createElement("canvas");
          canvas.width = 2240;
          canvas.height = 1680;
          canvas.getContext("2d")!.drawImage(image, 0, 0, 2240, 1680);
          const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (v) => (v ? resolve(v) : reject(Error("PNG 저장 실패"))),
              "image/png",
            ),
          );
          await saveImage(blob, name + ".png", runId, generation);
        } finally {
          URL.revokeObjectURL(source);
        }
        return;
      }
      const pages = Array.from(
        { length: count },
        (_, i) => `<section>${renderReport(run, format, theme, i)}</section>`,
      ).join("");
      const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${escape(reportText(run.config.name))} 보고서</title><style>body{margin:0;background:#eceff2}section{width:1120px;margin:24px auto;break-after:page}svg{display:block;width:100%;height:auto}@page{size:landscape;margin:0}@media print{body{background:white}section{width:100vw;margin:0;break-inside:avoid}section:last-child{break-after:auto}svg{width:100%;height:100vh}}</style>${pages}</html>`;
      if (type === "html")
        await saveImage(
          new Blob([html], { type: "text/html;charset=utf-8" }),
          name + ".html",
          runId,
          generation,
        );
      else if (printWindow) {
        printWindow.document.write(html);
        printWindow.document.close();
        await printWindow.document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        printWindow.print();
      }
    } catch (e) {
      if (mounted.current && currentRun.current === runId && exportGeneration.current === generation)
        onError(String(e).replace(/^Error: /, ""));
    } finally {
      if (mounted.current && currentRun.current === runId && exportGeneration.current === generation) {
        setBusy(false);
        setSave(false);
      }
    }
  }
  if (historyLoading) return <section className="report-view" aria-busy={!historyError}>
    <p>{historyError || "보고서 장비 이력을 불러오는 중…"}</p>
    {historyError && <button onClick={()=>setHistoryRetry(n=>n+1)}>다시 불러오기</button>}
  </section>;
  return (
    <section className="report-view">
      <div className="report-metric-audit"><MetricCoverage run={run} /></div>
      <div className="report-toolbar">
        <div className="report-selectors">
          <label>
            보고서 양식
            <select
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as Format);
                setPage(0);
              }}
            >
              {Object.entries(formats).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            테마
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as Theme)}
            >
              {Object.entries(themes).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="report-tools">
          <Help
            text="화면과 같은 보고서를 저장합니다. PNG·SVG는 현재 페이지, HTML·PDF는 전체 페이지입니다. PDF는 인쇄 창에서 PDF로 저장을 선택하세요. 원본 기록 JSON은 개인 보관용이며 API 주소·내부 경로·원시 응답이 포함될 수 있습니다."
            label="보고서 저장 도움말"
          />
          <div className="save-menu">
            <button
              className="primary"
              disabled={busy}
              aria-expanded={save}
              onClick={() => setSave(!save)}
            >
              <Download size={16} />
              {busy ? "저장 중" : "저장"}
            </button>
            {save && (
              <div className="save-options">
                {[
                  ["png", "PNG 이미지 · 현재 페이지"],
                  ["svg", "SVG 이미지 · 현재 페이지"],
                  ["html", "HTML · 전체 페이지"],
                  ["pdf", "PDF · 전체 페이지"],
                  ["json", "원본 기록 JSON · 개인 보관용"],
                ].map(([k, v]) => (
                  <button key={k} onClick={() => exportReport(k)}>
                    {v}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="subtle">
        {benchmarkLabel(run.config?.pack_id)}{" "}
        <Help text={benchmarkHelp(run.config?.pack_id)} label="보고서 평가팩 도움말" />
        {pages[actualPage]?.section === "score" && <Help label="성능 점수 측정 기준" text="기본점수는 같은 실행 설정의 단일 요청 이력으로 계산하며 동시작업 이후에도 유지합니다. 가산점은 같은 문항의 단일·동시 처리량과 완료시간이 모두 10% 이상 개선되고 오류가 늘지 않은 경우에만 적용합니다. 설정한 동시 요청 수 자체에는 가산하지 않습니다. 기존 단일 표본 출처와 동시 처리 근거는 원시 결과에 보존합니다." />}
      </p>
      {format !== "detailed" && (
        <nav className="report-outline" aria-label="보고서 항목">
          {pages
            .filter(
              (value, i) =>
                pages.findIndex((p) => p.section === value.section) === i,
            )
            .map((value) => (
              <button
                key={value.section}
                className={
                  pages[actualPage].section === value.section ? "selected" : ""
                }
                onClick={() =>
                  setPage(pages.findIndex((p) => p.section === value.section))
                }
              >
                {
                  {
                    score: "점수",
                    metrics: "계측 검증",
                    intelligence: "지능 평가",
                    performance: "성능",
                    hardware: "장비",
                    offload: "Offload",
                    conditions: "실행 조건",
                    grading: "채점·검증 실패",
                    details: "문항별",
                  }[value.section]
                }
              </button>
            ))}
        </nav>
      )}
      {savedFile && savedFile.runId === run.id && (
        <p className="saved-artifact">
          저장한 파일{" "}
          <a href={savedFile.url} target="_blank" rel="noreferrer">
            {savedFile.name}
          </a>
        </p>
      )}
      <div
        className="report-paper"
        tabIndex={0}
        aria-label="보고서 페이지 · 작은 화면에서는 좌우로 움직여 볼 수 있습니다"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="report-pagination">
        <button
          aria-label="이전 보고서 페이지"
          disabled={!actualPage}
          onClick={() => setPage(actualPage - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <span>
          {actualPage + 1} / {count} 페이지
        </span>
        <button
          aria-label="다음 보고서 페이지"
          disabled={actualPage + 1 >= count}
          onClick={() => setPage(actualPage + 1)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </section>
  );
}
