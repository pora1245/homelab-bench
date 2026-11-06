import { useState } from "react";
import { Check, Code2, Cpu } from "lucide-react";
import { api, Obj } from "./common";

const names = { windows: "Windows", macos: "Mac", linux: "Linux" };
function script(platform: string, kind: string) {
  if (platform === "windows") return `${kind}-Windows.cmd`;
  if (platform === "linux") return `${kind}-Linux.sh`;
  return `${kind}.command`;
}

/** Optional component help stays in Connections; installation choices belong to the installer. */
export function Components({ platform }: { platform: string }) {
  const [code, setCode] = useState<Obj | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [serverPlatform, setServerPlatform] = useState("linux");
  async function checkCode() {
    setChecking(true);
    setCode(null);
    setError("");
    try {
      const result = await api("readiness?scorers=humaneval,mbpp,livecodebench");
      const values = ["humaneval", "mbpp", "livecodebench"].map(key => result.scorers?.[key]);
      if (values.some(value => typeof value?.available !== "boolean")) throw new Error("채점 상태 응답이 누락됐습니다. 다시 확인해 주세요.");
      setCode({
        ready: values.every(value => value.available),
        detail: [...new Set(values.filter(value => !value.available).map(value => [value.error, value.remedy].filter(Boolean).join(" · ")))].join("\n"),
      });
    } catch (e) { setError(String(e).replace(/^Error: /, "")); }
    finally { setChecking(false); }
  }
  return <section className="component-maintenance" aria-labelledby="component-title">
    <div className="section-heading"><h2 id="component-title">구성 요소</h2></div>
    <p className="subtle">필요한 기능을 나중에 추가하거나 상태를 다시 확인할 수 있습니다.</p>
    <article className="panel component-row">
      <div className="component-row-heading"><h3><Code2 size={18} />코드 채점기</h3><button onClick={checkCode} disabled={checking}><Check size={15} />{checking ? "확인 중…" : "상태 확인"}</button></div>
      <p>모델이 작성한 코드를 실행해 정답을 확인합니다. 벤치 앱이 실행되는 장비에 준비합니다.</p>
      <p className={"component-status " + (error ? "failed" : code?.ready ? "ready" : code ? "not-ready" : "")} role="status">{checking ? "채점 환경 확인 중" : error ? "채점 환경 확인 실패" : code ? code.ready ? "코드 채점 준비 완료" : "코드 채점 준비 필요" : "설치 상태 미확인"}</p>
      {(error || code?.detail) && <p className="inline-error component-detail">{error || code?.detail}</p>}
      <details className="component-help"><summary>코드 채점기 설치 방법</summary><ol><li>벤치 앱 실행 장비에 Docker를 설치하고 실행합니다.</li><li>배포 폴더의 <code>{script(platform, "Setup-Code-Grader")}</code>를 실행합니다. GitHub 소스에서는 <code>packaging/</code> 폴더에 있습니다.</li><li>‘상태 확인’으로 준비를 확인한 뒤 새 시험에서 코딩 과목을 선택합니다.</li></ol><p>현재 코드 채점에는 Docker가 필요합니다. 다른 과목과 장비 수집은 Docker 없이 사용할 수 있습니다.</p></details>
    </article>
    <article className="panel component-row">
      <div className="component-row-heading"><h3><Cpu size={18} />장비 수집기</h3></div>
      <p>모델 실행 장비의 사용률·온도·전력을 기록합니다. 위 장비 목록에서 각 연결의 상태를 확인할 수 있습니다.</p>
      <details className="component-help"><summary>장비 수집기 설치 방법</summary>
        <p>모델이 벤치 앱과 같은 PC에서 실행된다면 내장 수집기를 사용할 수 있습니다. 모델 연결의 실행 장비에 ‘벤치 앱 실행 장비’를 지정하세요.</p>
        <label>모델 서버 운영체제<select value={serverPlatform} onChange={e=>setServerPlatform(e.target.value)}>{Object.entries(names).map(([value, label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <ol><li>모델 서버의 운영체제·CPU에 맞는 수집기 실행 파일을 준비합니다.</li><li><code>{script(serverPlatform, "Setup-Device-Collector")}</code>로 접속 주소를 설정하고 <code>{script(serverPlatform, "Start-Device-Collector")}</code>로 실행합니다. GitHub 소스에서는 <code>packaging/</code> 폴더에 있습니다.</li><li>‘장비 추가’에서 <code>collector-connection.json</code>의 주소와 <code>agent-token.txt</code>의 인증 키를 저장한 뒤 ‘연결 확인’을 누릅니다.</li><li>모델 연결을 수정해 해당 장비를 선택합니다.</li></ol>
        <p>별도 수집기에는 Python·Docker가 필요 없습니다. 장비에 설치할 수 없는 클라우드 API는 장비 수집 없이 시험할 수 있습니다.</p>
      </details>
    </article>
  </section>;
}
