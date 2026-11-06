import { useState } from "react";
import { CheckCircle2, Cpu, Code2, Monitor, Server, X } from "lucide-react";
import { api, Help, Obj } from "./common";

const platformName: Obj = { windows: "Windows", macos: "Mac", linux: "Linux" };
function script(platform: string, kind: string) {
  if (platform === "windows") return `${kind}-Windows.cmd`;
  if (platform === "linux") return `${kind}-Linux.sh`;
  return `${kind}.command`;
}
export function Setup({ value, devices, onSave, onClose }: {
  value: Obj; devices: Obj[];
  onSave: (preferences: Obj, connect: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [preferences, setPreferences] = useState<Obj>({...value.preferences});
  const [serverPlatform, setServerPlatform] = useState("linux");
  const [checks, setChecks] = useState<Obj>({});
  const [checking, setChecking] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const platform = value.platform || "linux";
  const remote = preferences.model_location === "remote";
  const [deviceId, setDeviceId] = useState("");
  const eligible = devices.filter(d => remote ? d.mode !== "local" : d.mode === "local");
  const selectedDevice = eligible.find(d => d.id === deviceId) || (!remote ? eligible[0] : undefined);
  async function check(kind: string) {
    setChecking(kind); setError("");
    try {
      if (kind === "code") {
        const result = await api("readiness?scorers=humaneval,mbpp,livecodebench");
        const values = ["humaneval", "mbpp", "livecodebench"].map(k => result.scorers?.[k]);
        setChecks(p => ({...p, code: {ok: values.every(v => v?.available === true),
          detail: values.every(v => v?.available === true) ? "코드 채점 준비 완료" : "코드 채점 준비 필요",
          errors: [...new Set(values.filter(v => !v?.available).map(v => v?.error || "검사 응답 누락"))].join(" · ")}}));
      } else if (selectedDevice) {
        const result = await api(`devices/${selectedDevice.id}/check`, {});
        setChecks(p => ({...p, device: {...result, detail: result.ok ? "장비 수집 연결 확인" : "장비 연결 확인 필요"}}));
      }
    } catch(e) { setError(String(e).replace(/^Error: /, "")); }
    finally { setChecking(""); }
  }
  async function save(connect: boolean) {
    setSaving(true); setError("");
    try { await onSave({...preferences, completed: true}, connect); }
    catch(e) {setError(String(e).replace(/^Error: /, ""));}
    finally {setSaving(false);}
  }
  return <div className="modal-backdrop"><section className="modal setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <div className="modal-heading"><div><span className="eyebrow">GET STARTED</span><h2 id="setup-title">처음 사용 준비</h2></div><button className="icon" aria-label="준비 화면 닫기" onClick={onClose}><X size={20}/></button></div>
    <p className="subtle">모델이 실행되는 위치에 맞춰 필요한 구성 요소를 준비합니다. 선택은 나중에 연결 관리에서 바꿀 수 있습니다.</p>
    <h3>1. 모델은 어디에서 실행하나요? <Help label="모델 실행 위치 도움말" text="이 PC는 브라우저를 연 기기가 아니라 벤치 앱 실행기가 설치된 장비입니다. 게이트웨이나 터널을 사용한다면 실제 모델이 실행되는 위치를 선택하세요."/></h3>
    <div className="setup-location" role="radiogroup" aria-label="모델 실행 위치">
      {[ ["local", "벤치 앱과 같은 PC", "벤치 앱과 모델이 한 장비에서 실행됩니다.", Monitor], ["remote", "다른 PC·서버", "모델 API로 다른 장비나 클라우드에 연결합니다.", Server] ].map(([key,title,desc,Icon]) => {
        const DisplayIcon = Icon as typeof Monitor;
        return <label className={"setup-choice " + (preferences.model_location === key ? "selected" : "")} key={String(key)}><input type="radio" name="model-location" value={String(key)} checked={preferences.model_location === key} onChange={()=>{setPreferences(p=>({...p, model_location:key}));setDeviceId("");setChecks(p=>({...p,device:null}));}}/><DisplayIcon size={22}/><span><strong>{String(title)}</strong><small>{String(desc)}</small></span></label>;
      })}
    </div>
    {preferences.model_location && <><h3>2. 필요한 기능을 준비하세요</h3><div className="setup-components">
      <article className="setup-component"><div className="setup-component-heading"><Code2 size={21}/><h4>코드 채점기</h4><label className="checkline"><input type="checkbox" checked={!!preferences.code_grading} onChange={e=>setPreferences(p=>({...p,code_grading:e.target.checked}))}/>사용</label></div>
        <p>모델이 작성한 코드를 실행해 정답을 확인합니다.</p><p className="subtle">설치 위치 · 벤치 앱 실행 PC ({platformName[platform] || platform})</p>
        <div className="setup-state">{!preferences.code_grading ? "기본 시험에서 제외 · 나중에 추가 가능" : checks.code?.detail || "설치 상태 미확인"}</div>
        {preferences.code_grading && <><details className="setup-instructions"><summary>준비 방법</summary><ol><li>벤치 앱 번들의 <code>{platform === "linux" ? "Setup-Code-Grader-Linux.sh" : script(platform, "Setup-Code-Grader")}</code>를 실행합니다.</li><li>안내에 따라 Docker를 설치·실행하고 준비 스크립트를 다시 실행합니다.</li><li>아래 ‘상태 확인’으로 공식 채점기 실행을 확인합니다.</li></ol><p className="subtle">현재 코드 채점은 Docker가 필요합니다. 다른 과목과 장비 수집에는 필요하지 않습니다.</p></details><button disabled={!!checking} onClick={()=>check("code")}>{checking === "code" ? "확인 중…" : "상태 확인"}</button>{checks.code?.errors && <p className="inline-error">{checks.code.errors}</p>}</>}
      </article>
      <article className="setup-component"><div className="setup-component-heading"><Cpu size={21}/><h4>장비 수집기</h4><label className="checkline"><input type="checkbox" checked={!!preferences.device_collection} onChange={e=>setPreferences(p=>({...p,device_collection:e.target.checked}))}/>사용</label></div>
        <p>CPU·GPU 사용률, 메모리, 온도와 전력을 기록합니다.</p><p className="subtle">설치 위치 · {remote ? "모델이 실행되는 PC·서버" : "벤치 앱 실행 PC (내장 수집 사용)"}</p>
        <div className="setup-state">{!preferences.device_collection ? "수집 안 함 · API 시험은 가능" : checks.device?.detail || (remote ? "수집기 연결 필요" : "내장 수집 · 상태 미확인")}</div>
        {preferences.device_collection && <><details className="setup-instructions"><summary>준비 방법</summary>{remote ? <><label>모델 서버 운영체제<select value={serverPlatform} onChange={e=>setServerPlatform(e.target.value)}><option value="windows">Windows</option><option value="macos">Mac</option><option value="linux">Linux</option></select></label><ol><li>모델 서버의 운영체제·CPU에 맞는 별도 장비 수집기 번들을 그 서버에 압축 해제합니다.</li><li><code>{script(serverPlatform, "Setup-Device-Collector")}</code>로 모델 서버의 LAN·Tailscale 주소를 지정하고 <code>{script(serverPlatform, "Start-Device-Collector")}</code>로 실행합니다.</li><li>collector-connection.json의 주소와 agent-token.txt의 인증 키를 ‘연결 관리 → 장비 추가’에 입력합니다.</li></ol><p className="subtle">별도 수집기는 Python·Docker가 필요 없습니다. 클라우드 API처럼 장비에 설치할 수 없는 경우 수집을 끄세요.</p></> : <p>추가 설치 없이 앱의 내장 수집기를 사용합니다. 연결 관리에서 모델의 실행 장비로 이 PC를 지정하세요.</p>}<p className="subtle">수집하지 못한 값은 미수집으로 표시합니다. 다른 장비의 수치로 대신 채우지 않습니다.</p></details>
        {remote && <label>확인할 장비<select value={deviceId} onChange={e=>{setDeviceId(e.target.value);setChecks(p=>({...p,device:null}));}}><option value="">등록된 장비 선택</option>{eligible.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
        <button disabled={!!checking || !selectedDevice} onClick={()=>check("device")}>{checking === "device" ? "확인 중…" : "상태 확인"}</button>{checks.device?.error && <p className="inline-error">{checks.device.error}</p>}</>}
      </article>
    </div></>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="setup-note"><CheckCircle2 size={17}/><span>선택을 저장한 뒤 모델 API와 장비를 연결합니다. 시험을 시작할 때 선택한 과목의 채점 준비 상태를 다시 확인합니다.</span></div>
    <div className="modal-footer"><button onClick={onClose} disabled={saving}>나중에</button><button onClick={()=>save(false)} disabled={saving || !preferences.model_location}>선택 저장</button><button className="primary" onClick={()=>save(true)} disabled={saving || !preferences.model_location}>{saving ? "저장 중…" : "저장하고 연결 설정"}</button></div>
  </section></div>;
}
