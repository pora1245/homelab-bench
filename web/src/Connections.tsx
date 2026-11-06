import { useEffect, useRef, useState } from "react";
import {
  Check,
  Cpu,
  Plug,
  Plus,
  Settings2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api, Field, Help, Obj, time, tips, temperatureOmitted } from "./common";
import { Components } from "./Components";

const initial = {
  name: "",
  kind: "target",
  base_url: "",
  api_format: "chat_completions",
  model: "",
  defaults: {
    temperature: 0,
    max_tokens: 8192,
    concurrency: 1,
    timeout_s: 600,
    reasoning_effort: "",
  },
};
export function Connections({
  connections,
  devices,
  setup,
  refresh,
  onError,
}: {
  connections: Obj[];
  devices: Obj[];
  setup: Obj | null;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [edit, setEdit] = useState<Obj | null>(null),
    [deviceEdit, setDeviceEdit] = useState<Obj | null>(null),
    [secret, setSecret] = useState(""),
    [deviceSecret, setDeviceSecret] = useState(""),
    [clearDeviceKey, setClearDeviceKey] = useState(false),
    [clearKey, setClearKey] = useState(false),
    [busy, setBusy] = useState(false),
    [checks, setChecks] = useState<Obj>({}),
    [dialogError, setDialogError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (dialogError) errorRef.current?.scrollIntoView({block:"nearest"}); }, [dialogError]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    onError("");
    setDialogError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      const message = String(e).replace(/^Error: /, "");
      setDialogError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }
  async function check(kind: string, id: string) {
    await action(async () => {
      const value = await api(`${kind}/${id}/check`, {});
      setChecks((previous) => ({ ...previous, [id]: value }));
    });
  }
  function open(value: Obj) {
    setDialogError("");
    setSecret("");
    setClearKey(false);
    setEdit({
      ...initial,
      ...(!value.id && setup?.preferences.model_location === "local" && setup.preferences.device_collection ? {device_id: devices.find(d => d.mode === "local")?.id || ""} : {}),
      ...value,
      defaults: { ...initial.defaults, ...value.defaults },
    });
  }
  function openDevice(value: Obj) {
    setDeviceSecret(""); setClearDeviceKey(false); setDialogError(""); setDeviceEdit(value);
  }
  const status = (v: Obj | undefined) =>
    v
      ? v.ok
        ? "연결됨"
        : v.status === "stale"
          ? "오래된 표본"
          : "연결 확인 필요"
      : "아직 확인하지 않음";
  return (
    <div className="connections-page">
      <div className="page-title">
        <div>
          <span className="eyebrow">CONNECTIONS</span>
          <h1>연결 관리</h1>
          <p>한 번 저장한 모델과 장비를 다음 시험에서도 선택해 사용합니다.</p>
        </div>
      </div>
      <section>
        <div className="section-heading">
          <h2>
            <Plug size={19} />
            모델 API
          </h2>
          <button className="primary" onClick={() => open(initial)}>
            <Plus size={16} />
            모델 추가
          </button>
        </div>
        <div className="profile-grid">
          {connections.map((profile) => (
            <article className="panel profile-card" key={profile.id}>
              <div className="panel-heading">
                <span className="pill">
                  {profile.kind === "judge" ? "채점용" : "시험용"}
                </span>
                {profile.is_default && (
                  <span className="default-badge">
                    <Star size={13} />
                    기본 연결
                  </span>
                )}
              </div>
              <h3>{profile.name}</h3>
              <p className="profile-model">{profile.model}</p>
              <p className="profile-url">{profile.base_url}</p>
              <div className="profile-meta">
                <span>API 키 {profile.has_key ? "저장됨" : "없음"}</span>
                <span>{profile.api_format === "responses" ? "Responses API" : "Chat Completions"}</span>
                <span>{status(checks[profile.id])}</span>
              </div>
              {checks[profile.id]?.error && (
                <p className="inline-error">{checks[profile.id].error}</p>
              )}
              {checks[profile.id]?.models?.length > 0 && (
                <details>
                  <summary>
                    사용 가능한 모델 {checks[profile.id].models.length}개
                  </summary>
                  <ul className="model-list">
                    {checks[profile.id].models.map((m: any) => (
                      <li key={m.id || m}>{m.id || m}</li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="card-actions">
                <button
                  onClick={() => check("connections", profile.id)}
                  disabled={busy}
                >
                  <Check size={15} />
                  연결 확인
                </button>
                <button
                  aria-label={profile.name + " 수정"}
                  onClick={() => open(profile)}
                >
                  <Settings2 size={15} />
                  수정
                </button>
                {!profile.is_default && (
                  <button
                    onClick={() =>
                      action(async () => {
                        await api(`connections/${profile.id}/default`, {});
                      })
                    }
                    disabled={busy}
                  >
                    기본으로
                  </button>
                )}
                <button
                  className="icon danger"
                  aria-label={profile.name + " 삭제"}
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        `${profile.name} 연결을 삭제할까요? 이전 시험 기록은 보존됩니다.`,
                      )
                    )
                      action(async () => {
                        await api(`connections/${profile.id}/delete`, {});
                      });
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
          {!connections.length && (
            <div className="panel empty-profile">
              <Plug size={28} />
              <h3>시험할 모델을 연결하세요</h3>
              <p>
                API 주소·모델·키를 저장하면 시험마다 다시 입력할 필요가
                없습니다.
              </p>
              <button onClick={() => open(initial)}>첫 모델 연결</button>
            </div>
          )}
        </div>
      </section>
      <section>
        <div className="section-heading">
          <h2>
            <Cpu size={19} />
            모델 실행 장비
            <Help
              text="모델이 실제 실행되는 장비를 선택하세요. 로컬 수집은 벤치 앱 실행기의 자원입니다. 원격 모델은 그 서버에 별도 수집기를 실행해 연결합니다. API 주소만으로 장비 위치를 추측하지 않습니다."
              label="시험 장비 도움말"
            />
          </h2>
          <button
            onClick={() =>
              openDevice({ name: "", mode: "http", url: "", host: "" })
            }
          >
            <Plus size={16} />
            장비 추가
          </button>
        </div>
        <div className="profile-grid">
          {devices.map((device) => (
            <article className="panel profile-card" key={device.id}>
              <div className="panel-heading">
                <span className="pill">
                  {{ local: "벤치 앱 실행 장비", http: "별도 장비 수집기", ssh: "SSH 연결" }[
                    device.mode as string
                  ] || device.mode}
                </span>
                {device.is_default && (
                  <span className="default-badge">
                    <Star size={13} />
                    기본 장비
                  </span>
                )}
              </div>
              <h3>{device.name}</h3>
              <p className="profile-url">
                {device.url || device.host || "로컬 시스템 자원"}
              </p>
              <div className="profile-meta">
                <span>{status(checks[device.id] || device.last_check)}</span>
                {device.mode === "http" && <span>인증 키 {device.has_key ? "저장됨" : "없음"}</span>}
                {checks[device.id]?.checked_at && (
                  <span>{time(checks[device.id].checked_at)}</span>
                )}
              </div>
              {checks[device.id]?.error && (
                <p className="inline-error">{checks[device.id].error}</p>
              )}
              {checks[device.id]?.data && (
                <p className="subtle">
                  {checks[device.id].data.gpus
                    ?.map((g: Obj) => g.name)
                    .join(" · ") || "CPU·메모리 상태 수집됨"}
                </p>
              )}
              <div className="card-actions">
                <button
                  disabled={busy}
                  onClick={() => check("devices", device.id)}
                >
                  <Check size={15} />
                  연결 확인
                </button>
                <button onClick={() => openDevice(device)}>
                  <Settings2 size={15} />
                  수정
                </button>
                {!device.is_default && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await api(`devices/${device.id}/default`, {});
                      })
                    }
                  >
                    기본으로
                  </button>
                )}
                {device.mode !== "local" && (
                  <button
                    className="icon danger"
                    aria-label={device.name + " 삭제"}
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`${device.name} 장비 연결을 삭제할까요?`))
                        action(async () => {
                          await api(`devices/${device.id}/delete`, {});
                        });
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
      <Components platform={setup?.platform || "linux"} />
      {edit && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && setEdit(null)}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-title"
          >
            <div className="modal-heading">
              <h2 id="connection-title">
                {edit.id ? "모델 연결 수정" : "모델 연결 추가"}
              </h2>
              <button
                className="icon"
                aria-label="닫기"
                onClick={() => setEdit(null)}
              >
                <X size={20} />
              </button>
            </div>
            {dialogError && <p className="inline-error" role="alert" ref={errorRef}>{dialogError}</p>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  await api("connections", {
                    ...edit,
                    ...(clearKey
                      ? { api_key: "" }
                      : secret
                        ? { api_key: secret }
                        : {}),
                  });
                  setEdit(null);
                  setSecret("");
                });
              }}
            >
              <div className="form-grid">
                <Field label="연결 이름">
                  <input
                    required
                    value={edit.name}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                    placeholder="예: 서버 DeepSeek"
                  />
                </Field>
                <Field label="용도">
                  <select
                    value={edit.kind}
                    onChange={(e) => setEdit({ ...edit, kind: e.target.value })}
                  >
                    <option value="target">시험할 모델</option>
                    <option value="judge">채점할 모델</option>
                  </select>
                </Field>
                <Field label="API 방식" help="OpenAI의 GPT-6.1 Sol은 Responses를 선택하세요. 로컬 OpenAI 호환 서버는 일반적으로 Chat Completions를 사용합니다.">
                  <select value={edit.api_format || "chat_completions"} onChange={(e) => setEdit({...edit, api_format:e.target.value})}>
                    <option value="chat_completions">Chat Completions</option>
                    <option value="responses">Responses</option>
                  </select>
                </Field>
                <Field
                  label="API 주소"
                  help="OpenAI 호환 API의 기본 주소입니다. 예: http://서버주소:8000/v1"
                >
                  <input
                    type="url"
                    required
                    value={edit.base_url}
                    onChange={(e) =>
                      setEdit({ ...edit, base_url: e.target.value })
                    }
                    placeholder="http://127.0.0.1:8000/v1"
                  />
                </Field>
                <Field label="API 키" help={tips.key}>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={secret}
                    onChange={(e) => {
                      setSecret(e.target.value);
                      setClearKey(false);
                    }}
                    placeholder={
                      edit.has_key
                        ? "저장된 키 유지 · 바꿀 때만 입력"
                        : "필요한 경우 입력"
                    }
                  />
                </Field>
                <Field
                  label="모델 ID"
                  wide
                  help="서버가 제공하는 정확한 모델 ID입니다. 저장 후 연결 확인을 눌러 사용 가능한 모델을 조회할 수 있습니다."
                >
                  <input
                    required
                    value={edit.model}
                    onChange={(e) =>
                      setEdit({ ...edit, model: e.target.value })
                    }
                    placeholder="서버에 등록된 모델 ID"
                  />
                </Field>
                {edit.has_key && (
                  <label className="checkline wide">
                    <input
                      type="checkbox"
                      checked={clearKey}
                      onChange={(e) => setClearKey(e.target.checked)}
                    />
                    저장된 API 키 삭제
                  </label>
                )}
              </div>
              <Field label="모델 실행 장비" help="이 모델을 실제로 실행하는 장비의 수집기를 지정하세요. 저장한 연결만 다음 시험에 자동 적용합니다. 주소가 localhost여도 장비를 추측하지 않습니다.">
                <select value={edit.device_id || ""} onChange={(e) => setEdit({...edit, device_id:e.target.value})}>
                  <option value="">미연결 · 장비 수집 안 함</option>
                  {devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.mode === "local" ? " · 벤치 앱 실행 장비" : ""}</option>)}
                </select>
              </Field>
              <details className="advanced">
                <summary>기본 실행 조건</summary>
                <div className="form-grid">
                  {[
                    ["temperature", "Temperature", 0, 0.1, 2],
                    ["max_tokens", "최대 출력 토큰", 1, 1, 32768],
                    ["concurrency", "동시 요청", 1, 1, 8],
                    ["timeout_s", "문항 제한시간 (초)", 5, 1, 1800],
                  ].map(([key, label, min, step, max]) => (
                    <Field key={key} label={label as string}>
                      <input
                        type="number"
                        min={min}
                        step={step}
                        max={max}
                        disabled={key === "temperature" && temperatureOmitted({...edit,...edit.defaults})}
                        value={edit.defaults[key]}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            defaults: {
                              ...edit.defaults,
                              [key]: +e.target.value,
                            },
                          })
                        }
                      />
                    </Field>
                  ))}
                  <Field
                    label="추론 강도"
                    help="서버가 지원하는 값을 입력합니다. GPT-6.1 Sol은 low·medium·high·xhigh·max를 지원합니다. 비워두면 서버 기본입니다. Responses 추론 요청은 Temperature를 전송하지 않습니다."
                  >
                    <input
                      value={edit.defaults.reasoning_effort}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          defaults: {
                            ...edit.defaults,
                            reasoning_effort: e.target.value,
                          },
                        })
                      }
                      placeholder="서버 기본"
                    />
                  </Field>
                </div>
              </details>
              <details className="advanced">
                <summary>모델·엔진 실행 정보</summary>
                <p className="subtle">확인한 설정을 저장하면 다음 시험의 보고서에 함께 기록됩니다. 비워둔 항목은 미확인으로 표시합니다.</p>
                <div className="form-grid">
                  {[["engine", "엔진"], ["engine_version", "엔진 버전"], ["model_revision", "체크포인트 버전"], ["quantization", "양자화"], ["context_length", "Context length"], ["parallelism", "GPU 병렬 구성"], ["speculative", "MTP / Speculative"], ["cache", "캐시 설정"], ["offload", "Offload 구성"], ["provenance", "정보 확인 근거"]].map(([key, label]) => <Field key={key} label={label}><input value={edit.execution_info?.[key] || ""} onChange={(e) => setEdit({...edit, execution_info: {...edit.execution_info, [key]: e.target.value}})} placeholder="미확인" /></Field>)}
                </div>
              </details>
              <div className="modal-footer">
                <button type="button" onClick={() => setEdit(null)}>
                  취소
                </button>
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? "저장 중" : "연결 저장"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {deviceEdit && (
        <div className="modal-backdrop">
          <section
            className="modal compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby="device-title"
          >
            <div className="modal-heading">
              <h2 id="device-title">장비 연결</h2>
              <button
                className="icon"
                aria-label="닫기"
                onClick={() => setDeviceEdit(null)}
              >
                <X size={20} />
              </button>
            </div>
            {dialogError && <p className="inline-error" role="alert" ref={errorRef}>{dialogError}</p>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  await api("devices", {...deviceEdit, ...(deviceEdit.mode !== "http" ? {} : clearDeviceKey ? {api_key: ""} : deviceSecret ? {api_key: deviceSecret} : {})});
                  setDeviceEdit(null);
                });
              }}
            >
              <div className="form-stack">
                <Field label="장비 이름">
                  <input
                    required
                    value={deviceEdit.name}
                    onChange={(e) =>
                      setDeviceEdit({ ...deviceEdit, name: e.target.value })
                    }
                  />
                </Field>
                <Field label="연결 방식">
                  <select
                    value={deviceEdit.mode}
                    onChange={(e) =>
                      setDeviceEdit({ ...deviceEdit, mode: e.target.value })
                    }
                  >
                    <option value="local">벤치 앱 실행 장비</option>
                    <option value="http">별도 장비 수집기 (HTTP)</option>
                    <option value="ssh">SSH</option>
                  </select>
                </Field>
                {deviceEdit.mode === "http" && (
                  <>
                  <Field
                    label="수집기 URL"
                    help="CPU·GPU·메모리·전력 데이터를 JSON으로 제공하는 수집기 주소를 입력합니다."
                  >
                    <input
                      type="url"
                      required
                      value={deviceEdit.url || ""}
                      onChange={(e) =>
                        setDeviceEdit({ ...deviceEdit, url: e.target.value })
                      }
                      placeholder="http://서버주소:18761/metrics"
                    />
                  </Field>
                  <Field label="수집기 인증 키" help="모델 서버의 agent-token.txt 값을 입력하세요. 모델 API 키와 별개이며 보고서에는 포함하지 않습니다. 수집기 주소를 바꾸면 기존 키가 제거되므로 새 주소에 맞는 키를 함께 입력하세요.">
                    <input type="password" autoComplete="new-password" value={deviceSecret} onChange={e=>setDeviceSecret(e.target.value)} placeholder={deviceEdit.has_key ? "저장된 키 유지" : "수집기 인증 키 입력"}/>
                  </Field>
                  {deviceEdit.has_key && <label className="checkline"><input type="checkbox" checked={clearDeviceKey} onChange={e=>setClearDeviceKey(e.target.checked)}/>저장된 수집기 인증 키 삭제</label>}
                  <p className="subtle">모델 서버에서 수집기를 실행한 뒤 주소와 인증 키를 입력하세요. 연결 관리 아래 ‘장비 수집기 설치 방법’에서 운영체제별 실행 파일을 확인할 수 있습니다.</p>
                  </>
                )}
                {deviceEdit.mode === "ssh" && (
                  <Field
                    label="SSH 대상"
                    help="벤치 앱 실행기에 설정된 SSH 별칭 또는 사용자@호스트를 입력합니다. 기존 키 인증으로 읽기 전용 상태를 수집합니다. 브라우저를 연 장비의 SSH 설정은 사용하지 않습니다."
                  >
                    <input
                      required
                      value={deviceEdit.host || ""}
                      onChange={(e) =>
                        setDeviceEdit({ ...deviceEdit, host: e.target.value })
                      }
                      placeholder="예: hd-server"
                    />
                  </Field>
                )}
                <Field label="수집할 GPU 번호" help="모델이 사용하는 GPU 번호만 쉼표로 구분해 입력하세요. 예: 0 또는 1,2,3,4. 비워두면 모든 GPU를 관측하며 모델이 모두 사용했다고 간주하지 않습니다.">
                  <input defaultValue={(deviceEdit.gpu_indices || []).join(",")} key={deviceEdit.id || "new"} pattern="[0-9, ]*" placeholder="전체 GPU 관측" onChange={(e) => setDeviceEdit({...deviceEdit, gpu_indices: e.target.value.split(",").map(v => v.trim()).filter(Boolean).map(Number)})} />
                </Field>
                <label className="checkline"><input type="checkbox" checked={!!deviceEdit.include_offload} onChange={(e) => setDeviceEdit({...deviceEdit, include_offload:e.target.checked})} />CPU·RAM 또는 저장장치 Offload 사용</label>
                <p className="subtle">선택하면 NUMA 메모리와 저장장치 정보도 수집합니다. CPU·RAM·Swap은 장비 전체 값이며 다른 작업의 사용량도 포함될 수 있습니다.</p>
              </div>
              <div className="modal-footer">
                <button type="button" onClick={() => setDeviceEdit(null)}>
                  취소
                </button>
                <button type="submit" className="primary" disabled={busy}>
                  장비 저장
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
