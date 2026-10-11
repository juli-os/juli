// 公开投影桩：与私仓同形，双侧 typecheck 兜底防漂移。
// 私仓本文件是手机端门牌页 HTML（中文版，iOS App 指路）；公开投影无 App
// 发布语境，桩为英文版（桌面浏览器指路）。
export const MOBILE_GATE_HTML = `
    <div class="mgate">
      <div class="mgate-card">
        <h1>Desktop browser required</h1>
        <p>The juli cockpit is currently desktop-only — please open this address on a desktop browser.</p>
        <p class="mgate-sub">Chat intake, run timeline, approval gates and terminals all work there.</p>
      </div>
    </div>`;
