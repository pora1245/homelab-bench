//! Read-only benchmark telemetry. Public samples contain hardware facts, not host identities.
use crate::{settings::Device, types::now};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};

const GPU_BASIC: &str =
    "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.sm";
const GPU_EXTENDED: &str = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.sm,driver_version,pcie.link.gen.current,pcie.link.width.current,clocks.mem,power.limit,clocks_throttle_reasons.active";
const HOST_FIELDS: &[&str] = &[
    "cpu_pct",
    "cpu_model",
    "cpu_physical_cores",
    "cpu_logical_cores",
    "ram_used_bytes",
    "ram_total_bytes",
    "swap_used_bytes",
    "swap_total_bytes",
];
const GPU_FIELDS: &[&str] = &[
    "name",
    "utilization_pct",
    "vram_used_mib",
    "vram_total_mib",
    "temperature_c",
    "power_w",
    "clock_mhz",
    "driver_version",
    "pcie_gen",
    "pcie_width",
    "memory_clock_mhz",
    "power_limit_w",
    "throttle_active",
    "throttle_reasons",
    "clock_event_mask",
];

fn numeric(v: &str) -> Value {
    v.trim()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.)
        .map(|v| json!(v))
        .unwrap_or(Value::Null)
}
fn nonempty(v: &str) -> Value {
    let v = v.trim();
    if v.is_empty() || v.contains("N/A") || v.contains("Not Supported") {
        Value::Null
    } else {
        json!(v)
    }
}
fn number_value(v: &Value) -> Value {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .map(|n| json!(n))
        .or_else(|| v.as_str().map(numeric))
        .unwrap_or(Value::Null)
}
fn unavailable_fields(v: &mut Value, fields: &[&str]) {
    let unknown_clock = v["throttle_reasons"]
        .as_array()
        .is_some_and(|v| v.iter().any(|reason| reason == "unknown_clock_event"));
    if unknown_clock && v["throttle_active"] != true {
        v["throttle_active"] = Value::Null;
    }
    v["unavailable"] = json!({});
    for key in fields {
        if v[*key].is_null() {
            v[*key] = Value::Null;
            v["unavailable"][*key] =
                json!("수집기가 값을 제공하지 않거나 장치에서 지원하지 않습니다");
        }
    }
    if unknown_clock && v["throttle_active"].is_null() {
        v["unavailable"]["throttle_active"] =
            json!("알 수 없는 클럭 이벤트가 있어 스로틀 여부를 확정할 수 없습니다");
    }
}

// NVML bit definitions: https://docs.nvidia.com/deploy/nvml-api/latest/api/group__nvmlClocksEventReasons.html
// Idle and configured clocks are events; they alone are not evidence of thermal/power throttling.
fn throttle(raw: &str) -> (Value, Value) {
    let parsed = u64::from_str_radix(raw.trim().trim_start_matches("0x"), 16).ok();
    let Some(bits) = parsed else {
        return (Value::Null, Value::Null);
    };
    let names = [
        (1, "idle"),
        (2, "application_clocks"),
        (4, "software_power_cap"),
        (8, "hardware_slowdown"),
        (16, "sync_boost"),
        (32, "software_thermal_slowdown"),
        (64, "hardware_thermal_slowdown"),
        (128, "hardware_power_brake"),
        (256, "display_clocks"),
    ];
    let mut reasons = names
        .into_iter()
        .filter(|(bit, _)| bits & bit != 0)
        .map(|(_, name)| name.to_string())
        .collect::<Vec<_>>();
    if bits & !0x1ff != 0 {
        reasons.push("unknown_clock_event".into());
    }
    let limited = bits & (4 | 8 | 32 | 64 | 128) != 0;
    let active = if limited {
        json!(true)
    } else if bits & !0x1ff != 0 {
        Value::Null
    } else {
        json!(false)
    };
    (active, json!(reasons))
}

fn parse_gpus(text: &str) -> Vec<Value> {
    text.lines().filter_map(|line| {
        let x=line.split(',').map(str::trim).collect::<Vec<_>>();
        if x.len()<8{return None}
        let index=x[0].parse::<u32>().ok()?;
        let get=|i:usize|x.get(i).copied().unwrap_or("");
        let (active,reasons)=throttle(get(13));
        let mut v=json!({"index":index,"name":nonempty(get(1)),"utilization_pct":numeric(get(2)),
            "vram_used_mib":numeric(get(3)),"vram_total_mib":numeric(get(4)),"temperature_c":numeric(get(5)),
            "power_w":numeric(get(6)),"clock_mhz":numeric(get(7)),"driver_version":nonempty(get(8)),
            "pcie_gen":numeric(get(9)),"pcie_width":numeric(get(10)),"memory_clock_mhz":numeric(get(11)),
            "power_limit_w":numeric(get(12)),"throttle_active":active,"throttle_reasons":reasons,
            "clock_event_mask":u64::from_str_radix(get(13).trim_start_matches("0x"),16).ok().map(|n|format!("0x{n:016x}"))});
        unavailable_fields(&mut v,GPU_FIELDS);Some(v)
    }).collect()
}

pub fn normalize(input: Value, d: &Device) -> Value {
    let mut out = json!({"timestamp":input["timestamp"],"source":d.mode,
        "host_scope":"CPU·RAM·swap은 장비 전체 관측값입니다",
        "gpu_scope":if d.gpu_indices.is_empty(){"장비 전체 GPU 보드 관측값 · 서버 전체 전력 아님"}else{"선택 GPU 보드 관측값 · 모델 단독 사용량이나 서버 전체 전력 아님"},
        "offload":null});
    for key in HOST_FIELDS {
        out[*key] = if *key == "cpu_model" {
            input[*key].as_str().map(nonempty).unwrap_or(Value::Null)
        } else {
            number_value(&input[*key])
        };
    }
    unavailable_fields(&mut out, HOST_FIELDS);
    let mut all = Vec::new();
    for raw in input["gpus"].as_array().into_iter().flatten() {
        let index = raw["index"]
            .as_u64()
            .or_else(|| raw["index"].as_str().and_then(|v| v.parse().ok()));
        let Some(index) = index else { continue };
        let mut gpu = json!({"index":index});
        for field in GPU_FIELDS {
            gpu[*field] = match *field {
                "name" | "driver_version" | "clock_event_mask" => {
                    raw[*field].as_str().map(nonempty).unwrap_or(Value::Null)
                }
                "throttle_active" => raw[*field]
                    .as_bool()
                    .map(|v| json!(v))
                    .unwrap_or(Value::Null),
                "throttle_reasons" => raw[*field]
                    .as_array()
                    .map(|v| json!(v.iter().filter_map(Value::as_str).collect::<Vec<_>>()))
                    .unwrap_or(Value::Null),
                _ => number_value(&raw[*field]),
            };
        }
        unavailable_fields(&mut gpu, GPU_FIELDS);
        all.push(gpu);
    }
    out["gpu_catalog"]=json!(all.iter().map(|g|json!({"index":g["index"],"name":g["name"],"vram_total_mib":g["vram_total_mib"]})).collect::<Vec<_>>());
    let selected = all
        .into_iter()
        .filter(|g| {
            d.gpu_indices.is_empty()
                || d.gpu_indices
                    .iter()
                    .any(|i| Some(*i as u64) == g["index"].as_u64())
        })
        .collect::<Vec<_>>();
    let observed = selected
        .iter()
        .filter_map(|g| g["index"].as_u64())
        .collect::<Vec<_>>();
    let missing = d
        .gpu_indices
        .iter()
        .filter(|i| !observed.contains(&(**i as u64)))
        .copied()
        .collect::<Vec<_>>();
    out["gpu_selection"] = json!({"mode":if d.gpu_indices.is_empty(){"all"}else{"selected"},"requested_indices":d.gpu_indices,"observed_indices":observed,"missing_indices":missing});
    if selected.is_empty() {
        out["unavailable"]["gpus"] =
            json!("선택 GPU를 찾지 못했거나 NVIDIA 수집 명령이 지원되지 않습니다");
    }
    out["gpus"] = json!(selected);
    if d.include_offload {
        let source = &input["offload"];
        let mut off = json!({"scope":"장비 전체 물리 디스크·NUMA 관측값 · 모델의 실제 오프로딩 대상과 다를 수 있습니다",
            "numa_nodes":null,"storage":null,"disk_read_bytes_per_s":source["disk_read_bytes_per_s"],"read_interval_ms":source["read_interval_ms"]});
        if let Some(nodes) = source["numa_nodes"].as_array() {
            off["numa_nodes"]=json!(nodes.iter().map(|n|json!({"index":n["index"],"ram_total_bytes":n["ram_total_bytes"],"ram_free_bytes":n["ram_free_bytes"]})).collect::<Vec<_>>());
        }
        if let Some(disks) = source["storage"].as_array() {
            off["storage"] = json!(
                disks
                    .iter()
                    .map(|disk| {
                        let mut v = json!({});
                        for key in [
                            "index",
                            "model",
                            "media",
                            "transport",
                            "capacity_bytes",
                            "read_bytes_total",
                            "read_bytes_per_s",
                        ] {
                            v[key] = disk[key].clone();
                        }
                        unavailable_fields(
                            &mut v,
                            &[
                                "model",
                                "capacity_bytes",
                                "read_bytes_total",
                                "read_bytes_per_s",
                            ],
                        );
                        v
                    })
                    .collect::<Vec<_>>()
            );
        }
        unavailable_fields(
            &mut off,
            &[
                "numa_nodes",
                "storage",
                "disk_read_bytes_per_s",
                "read_interval_ms",
            ],
        );
        out["offload"] = off;
    }
    out
}

pub fn linux_script(offload: bool) -> String {
    let disk_before = if offload {
        "echo __DISK_A_TIME__; date +%s%N; echo __DISK_A__; cat /proc/diskstats"
    } else {
        "true"
    };
    let disk_after = if offload {
        "echo __DISK_B_TIME__; date +%s%N; echo __DISK_B__; cat /proc/diskstats"
    } else {
        "true"
    };
    let optional = if offload {
        r#"echo __NUMA__; for bench_node in /sys/devices/system/node/node[0-9]*; do [ -d "$bench_node" ] && awk '/MemTotal:|MemFree:/' "$bench_node/meminfo"; done; echo __STORAGE__; lsblk -bdn -J -o NAME,TYPE,SIZE,MODEL,ROTA,TRAN 2>/dev/null"#
    } else {
        "true"
    };
    format!(
        r#"LC_ALL=C
echo __TIMESTAMP__; date -u +%Y-%m-%dT%H:%M:%SZ
echo __CPU_META__; lscpu -J 2>/dev/null
echo __CPU_A__; head -n 1 /proc/stat
{disk_before}
sleep 0.25
echo __CPU_B__; head -n 1 /proc/stat
{disk_after}
echo __MEM__; awk '/^MemTotal:|^MemAvailable:|^SwapTotal:|^SwapFree:/' /proc/meminfo
echo __GPU__; nvidia-smi --query-gpu={GPU_EXTENDED} --format=csv,noheader,nounits 2>/dev/null || nvidia-smi --query-gpu={GPU_BASIC} --format=csv,noheader,nounits 2>/dev/null
{optional}
echo __END__
"#
    )
}

fn sections(text: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let mut current = String::new();
    for line in text.lines() {
        if line.starts_with("__") && line.ends_with("__") {
            current = line.into();
            map.entry(current.clone()).or_insert_with(String::new);
        } else if !current.is_empty() {
            let value = map.get_mut(&current).unwrap();
            value.push_str(line);
            value.push('\n');
        }
    }
    map
}
fn cpu_ticks(line: &str) -> Option<(u64, u64)> {
    let n = line
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if n.len() < 5 {
        return None;
    }
    Some((n.iter().sum(), n[3] + n[4]))
}
fn memory(text: &str) -> BTreeMap<String, u64> {
    text.lines()
        .filter_map(|line| {
            let mut p = line.split_whitespace();
            let key = p.next()?.trim_end_matches(':');
            let value = p.next()?.parse::<u64>().ok()?;
            Some((key.into(), value.saturating_mul(1024)))
        })
        .collect()
}
fn disk_reads(text: &str) -> BTreeMap<String, u64> {
    text.lines()
        .filter_map(|line| {
            let parts = line.split_whitespace().collect::<Vec<_>>();
            Some((
                parts.get(2)?.to_string(),
                parts.get(5)?.parse::<u64>().ok()?.saturating_mul(512),
            ))
        })
        .collect()
}
fn offload_data(parts: &BTreeMap<String, String>) -> Value {
    let get = |key: &str| parts.get(key).map(String::as_str).unwrap_or("");
    let mut nodes: BTreeMap<u32, Value> = BTreeMap::new();
    for line in get("__NUMA__").lines() {
        let p = line.split_whitespace().collect::<Vec<_>>();
        if p.len() < 5 {
            continue;
        }
        let (Ok(index), Ok(kib)) = (p[1].parse::<u32>(), p[3].parse::<u64>()) else {
            continue;
        };
        let v = nodes
            .entry(index)
            .or_insert(json!({"index":index,"ram_total_bytes":null,"ram_free_bytes":null}));
        match p[2] {
            "MemTotal:" => v["ram_total_bytes"] = json!(kib * 1024),
            "MemFree:" => v["ram_free_bytes"] = json!(kib * 1024),
            _ => {}
        }
    }
    let a = disk_reads(get("__DISK_A__"));
    let b = disk_reads(get("__DISK_B__"));
    let seconds = get("__DISK_A_TIME__")
        .trim()
        .parse::<u64>()
        .ok()
        .zip(get("__DISK_B_TIME__").trim().parse::<u64>().ok())
        .and_then(|(a, b)| b.checked_sub(a))
        .filter(|d| *d > 0)
        .map(|d| d as f64 / 1e9);
    let blocks = serde_json::from_str::<Value>(get("__STORAGE__")).unwrap_or(Value::Null);
    let mut aggregate = 0.;
    let mut n_rates = 0;
    let disks=blocks["blockdevices"].as_array().map(|rows|rows.iter().filter(|v|v["type"]=="disk").enumerate().map(|(index,d)|{
        let name=d["name"].as_str().unwrap_or("");
        let rate=seconds.zip(a.get(name).zip(b.get(name))).and_then(|(s,(a,b))|b.checked_sub(*a).map(|bytes|bytes as f64/s));
        if let Some(rate)=rate {aggregate+=rate;n_rates+=1;}
        let rotational=d["rota"].as_bool().or_else(||d["rota"].as_u64().map(|n|n!=0));
        json!({"index":index,"model":d["model"].as_str().map(str::trim).filter(|s|!s.is_empty()),"media":match rotational{Some(true)=>"HDD",Some(false)=>"SSD",None=>"unknown"},"transport":d["tran"],"capacity_bytes":d["size"].as_u64().or_else(||d["size"].as_str().and_then(|v|v.parse().ok())),"read_bytes_total":b.get(name),"read_bytes_per_s":rate})
    }).collect::<Vec<_>>());
    json!({"numa_nodes":if nodes.is_empty(){None}else{Some(nodes.into_values().collect::<Vec<_>>())},"storage":disks,"disk_read_bytes_per_s":if n_rates>0{Some(aggregate)}else{None},"read_interval_ms":seconds.map(|s|s*1000.)})
}

pub fn parse_linux(text: &str, offload: bool) -> anyhow::Result<Value> {
    let parts = sections(text);
    let get = |key: &str| parts.get(key).map(String::as_str).unwrap_or("");
    anyhow::ensure!(
        !get("__TIMESTAMP__").trim().is_empty(),
        "장비 수집 응답 형식 오류"
    );
    let pct = cpu_ticks(get("__CPU_A__"))
        .zip(cpu_ticks(get("__CPU_B__")))
        .and_then(|(a, b)| {
            let total = b.0.checked_sub(a.0)?;
            let idle = b.1.checked_sub(a.1)?;
            (total > 0 && idle <= total).then_some(100. * (1. - idle as f64 / total as f64))
        });
    let meta = serde_json::from_str::<Value>(get("__CPU_META__")).unwrap_or(Value::Null);
    let cpu = |key: &str| {
        meta["lscpu"]
            .as_array()
            .and_then(|v| v.iter().find(|v| v["field"].as_str() == Some(key)))
            .and_then(|v| v["data"].as_str())
    };
    let num = |key: &str| cpu(key).and_then(|v| v.parse::<u64>().ok());
    let mem = memory(get("__MEM__"));
    Ok(
        json!({"timestamp":get("__TIMESTAMP__").trim(),"cpu_pct":pct,"cpu_model":cpu("Model name:"),"cpu_logical_cores":num("CPU(s):"),
        "cpu_physical_cores":num("Core(s) per socket:").zip(num("Socket(s):")).map(|(a,b)|a*b),
        "ram_total_bytes":mem.get("MemTotal"),"ram_used_bytes":mem.get("MemTotal").zip(mem.get("MemAvailable")).map(|(a,b)|a.saturating_sub(*b)),
        "swap_total_bytes":mem.get("SwapTotal"),"swap_used_bytes":mem.get("SwapTotal").zip(mem.get("SwapFree")).map(|(a,b)|a.saturating_sub(*b)),
        "gpus":parse_gpus(get("__GPU__")),"offload":if offload{offload_data(&parts)}else{Value::Null}}),
    )
}

pub async fn local_sample(offload: bool) -> anyhow::Result<Value> {
    if cfg!(target_os = "linux") {
        let output = tokio::process::Command::new("sh")
            .kill_on_drop(true)
            .args(["-c", &linux_script(offload)])
            .output()
            .await?;
        anyhow::ensure!(output.status.success(), "로컬 장비 조회 실패");
        return parse_linux(&String::from_utf8(output.stdout)?, offload);
    }
    let mut sys = sysinfo::System::new();
    sys.refresh_cpu_all();
    tokio::time::sleep(Duration::from_millis(250)).await;
    sys.refresh_cpu_all();
    sys.refresh_memory();
    let mut gpus = vec![];
    for query in [GPU_EXTENDED, GPU_BASIC] {
        let out = tokio::process::Command::new("nvidia-smi")
            .kill_on_drop(true)
            .args([
                format!("--query-gpu={query}"),
                "--format=csv,noheader,nounits".into(),
            ])
            .output()
            .await;
        if let Ok(out) = out {
            if out.status.success() {
                gpus = parse_gpus(&String::from_utf8_lossy(&out.stdout));
                break;
            }
        }
    }
    Ok(
        json!({"timestamp":now(),"cpu_pct":sys.global_cpu_usage(),"cpu_model":sys.cpus().first().map(|c|c.brand()),"cpu_logical_cores":sys.cpus().len(),"cpu_physical_cores":sys.physical_core_count(),
        "ram_used_bytes":sys.used_memory(),"ram_total_bytes":sys.total_memory(),"swap_used_bytes":sys.used_swap(),"swap_total_bytes":sys.total_swap(),"gpus":gpus,"offload":null}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn device() -> Device {
        serde_json::from_value(
            json!({"name":"fixture","mode":"http","gpu_indices":[0],"include_offload":false}),
        )
        .unwrap()
    }

    #[test]
    fn nvidia_values_and_idle_are_distinct_from_throttling() {
        let gpu=parse_gpus("0, NVIDIA RTX 3060, 3, 1024, 12288, 40, 19.9, 210, 615.71.09, 1, 16, 405, 170, 0x0000000000000001").remove(0);
        assert_eq!(gpu["power_limit_w"], 170.);
        assert_eq!(gpu["pcie_width"], 16.);
        assert_eq!(gpu["throttle_active"], false);
        assert_eq!(gpu["throttle_reasons"], json!(["idle"]));
        let (active, reasons) = throttle("0x0000000000000044");
        assert_eq!(active, true);
        assert_eq!(
            reasons,
            json!(["software_power_cap", "hardware_thermal_slowdown"])
        );
    }
    #[test]
    fn absent_gpu_fields_are_null_with_reasons() {
        let gpu = parse_gpus("0, GPU, 0, 100, 12000, N/A, [Not Supported], 210").remove(0);
        assert!(gpu["power_w"].is_null());
        assert!(gpu["driver_version"].is_null());
        assert!(gpu["unavailable"]["temperature_c"].is_string());
    }
    #[test]
    fn unknown_clock_events_do_not_claim_no_throttling() {
        let (active, reasons) = throttle("0x0000000000000200");
        assert!(active.is_null());
        assert_eq!(reasons, json!(["unknown_clock_event"]));
        assert_eq!(throttle("0x0000000000000204").0, true);
        let d = device();
        let value = normalize(
            json!({"gpus":[{"index":0,"name":"GPU","throttle_active":false,"throttle_reasons":["unknown_clock_event"]}]}),
            &d,
        );
        assert!(value["gpus"][0]["throttle_active"].is_null());
        assert!(value["gpus"][0]["unavailable"]["throttle_active"].is_string());
    }
    #[test]
    fn selected_gpu_and_public_fields_are_whitelisted() {
        let raw = json!({"timestamp":now(),"host":"PRIVATE-HOST","ip":"PRIVATE-IP","cpu_pct":4,"cpu_model":"CPU","gpus":[
            {"index":"0","name":"GPU A","power_w":"20.5","uuid":"PRIVATE-UUID"},
            {"index":1,"name":"GPU B","power_w":100}],"offload":{"storage":[{"serial":"PRIVATE-SERIAL"}]}});
        let value = normalize(raw, &device());
        assert_eq!(value["gpus"].as_array().unwrap().len(), 1);
        assert_eq!(value["gpus"][0]["power_w"], 20.5);
        assert!(value["offload"].is_null());
        assert!(!value.to_string().contains("PRIVATE-"));
        assert_eq!(value["gpu_catalog"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn unavailable_selected_gpu_is_not_replaced_by_another() {
        let mut d = device();
        d.gpu_indices = vec![4];
        let value = normalize(json!({"gpus":[{"index":0,"name":"GPU"}]}), &d);
        assert_eq!(value["gpus"], json!([]));
        assert_eq!(value["gpu_selection"]["missing_indices"], json!([4]));
    }
    #[test]
    fn linux_memory_numa_and_disk_read_interval_are_measured() {
        let raw = "__TIMESTAMP__\n2026-11-06T00:00:00Z\n__CPU_META__\n{\"lscpu\":[{\"field\":\"Model name:\",\"data\":\"CPU model\"},{\"field\":\"CPU(s):\",\"data\":\"8\"},{\"field\":\"Socket(s):\",\"data\":\"1\"},{\"field\":\"Core(s) per socket:\",\"data\":\"4\"}]}\n__CPU_A__\ncpu 10 0 10 80 0 0 0 0\n__CPU_B__\ncpu 20 0 20 160 0 0 0 0\n__MEM__\nMemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 100 kB\nSwapFree: 80 kB\n__GPU__\n__NUMA__\nNode 0 MemTotal: 1000 kB\nNode 0 MemFree: 300 kB\n__DISK_A_TIME__\n1000000000\n__DISK_A__\n259 0 nvme0n1 1 0 100 0\n__DISK_B_TIME__\n1250000000\n__DISK_B__\n259 0 nvme0n1 2 0 300 0\n__STORAGE__\n{\"blockdevices\":[{\"name\":\"nvme0n1\",\"type\":\"disk\",\"size\":1000000,\"model\":\"SSD Model\",\"rota\":false,\"tran\":\"nvme\"}]}\n__END__\n";
        let value = parse_linux(raw, true).unwrap();
        assert_eq!(value["cpu_physical_cores"], 4);
        assert_eq!(value["ram_used_bytes"], 600 * 1024);
        assert_eq!(value["swap_used_bytes"], 20 * 1024);
        assert_eq!(value["offload"]["disk_read_bytes_per_s"], 409600.);
        assert_eq!(value["offload"]["read_interval_ms"], 250.);
        let mut d = device();
        d.include_offload = true;
        let public = normalize(value, &d);
        assert_eq!(public["offload"]["storage"][0]["model"], "SSD Model");
        assert!(!public.to_string().contains("nvme0n1"));
    }
}
