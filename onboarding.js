// First-run status page. It asks the Service Worker for the read-only Host check
// and shows three things: whether the Host answers, the configured Private Shelf
// by display name only, and guidance for the states the user can fix. It never
// lists, picks or switches Shelves and never sends a quote.
const overallStatus = document.getElementById("overall-status");
const hostStatus = document.getElementById("host-status");
const shelfStatus = document.getElementById("shelf-status");
const recheckButton = document.getElementById("recheck");
const GUIDANCE_IDS = [
  "guide-host-missing",
  "guide-shelf-unconfigured",
  "guide-identity-mismatch",
  "guide-other",
  "ready-guidance"
];

const HOST_UNAVAILABLE_COPY = {
  "host-not-registered": ["未登録です。このパソコンにMAGINALIA連携プログラムが登録されていません。", "guide-host-missing"],
  "host-access-forbidden": ["接続が許可されていません。連携プログラムがこの拡張機能を許可していません。", "guide-host-missing"],
  "host-not-configured": ["接続先を確認できません。", "guide-host-missing"],
  "native-messaging-unavailable": ["このブラウザーでは連携プログラムとの接続を利用できません。", "guide-other"],
  "host-timeout": ["時間内に応答がありませんでした。", "guide-other"],
  "host-exited": ["連携プログラムが途中で終了しました。", "guide-other"],
  "host-configuration-invalid": ["連携プログラムの設定を確認できません。入れ直してください。", "guide-host-missing"]
};

const SHELF_PROBLEM_COPY = {
  "shelf-not-configured": ["未設定です。MAGINALIAで保存先がまだ設定されていません。", "guide-shelf-unconfigured"],
  "shelf-configuration-unavailable": ["保存先の設定を読み取れません。", "guide-shelf-unconfigured"],
  "shelf-identity-mismatch": ["識別子が一致しません。設定された本棚と見つかった本棚が異なります。", "guide-identity-mismatch"],
  "shelf-identity-unavailable": ["本棚の識別子を確認できません。", "guide-identity-mismatch"],
  "shelf-unavailable": ["保存先の本棚を開けません。本棚のフォルダーがあるか確認してください。", "guide-other"]
};

let checkInFlight = false;

function setStatus(element, text, tone) {
  const base = element === overallStatus ? "status" : "step-status";
  element.textContent = text;
  element.className = tone ? `${base} is-${tone}` : base;
}

function showGuidance(id) {
  for (const guidanceId of GUIDANCE_IDS) {
    document.getElementById(guidanceId).hidden = guidanceId !== id;
  }
}

function requestHostCheck() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "collector:host-check" }, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

function canSave(report) {
  return report.host?.writesEnabled === true
    && Array.isArray(report.host?.operations)
    && report.host.operations.includes("save_web_quote")
    && report.shelf?.type === "private"
    && report.shelf?.writesEnabled === true;
}

function renderUnknown() {
  setStatus(hostStatus, "状態を確認できませんでした。", "error");
  setStatus(shelfStatus, "連携プログラムを確認できないため、まだ確認できません。", null);
  setStatus(overallStatus, "準備状況を確認できませんでした。", "error");
  showGuidance("guide-other");
}

function render(response) {
  const report = response?.ok === true ? response.report : null;
  if (!report || typeof report !== "object") {
    renderUnknown();
    return;
  }

  if (report.status === "unavailable") {
    const [text, guidance] = HOST_UNAVAILABLE_COPY[report.code] ?? ["連携プログラムに接続できませんでした。", "guide-other"];
    setStatus(hostStatus, text, "error");
    setStatus(shelfStatus, "連携プログラムに接続できないため、まだ確認できません。", null);
    setStatus(overallStatus, "まだ本棚に保存できません。下の案内を確認してください。", "error");
    showGuidance(guidance);
    return;
  }

  if (report.status === "incompatible") {
    setStatus(hostStatus, "接続できました。", "ok");
    const shelfProblem = SHELF_PROBLEM_COPY[report.code];
    if (shelfProblem) {
      setStatus(shelfStatus, shelfProblem[0], "error");
      showGuidance(shelfProblem[1]);
    } else {
      setStatus(shelfStatus, "連携プログラムの版がこの拡張機能と合わないため、確認できません。", "error");
      showGuidance("guide-other");
    }
    setStatus(overallStatus, "まだ本棚に保存できません。下の案内を確認してください。", "error");
    return;
  }

  if (report.status === "compatible") {
    setStatus(hostStatus, "接続できました。", "ok");
    const name = typeof report.shelf?.name === "string" && report.shelf.name.trim() ? report.shelf.name.trim() : "";
    if (!name) {
      setStatus(shelfStatus, "保存先の本棚の名前を受け取れませんでした。", "warn");
      setStatus(overallStatus, "準備状況を確認できませんでした。", "warn");
      showGuidance("guide-other");
      return;
    }
    if (!canSave(report)) {
      setStatus(shelfStatus, `「${name}」が設定されていますが、いまは保存を受け付けていません。`, "warn");
      setStatus(overallStatus, "まだ本棚に保存できません。下の案内を確認してください。", "warn");
      showGuidance("guide-shelf-unconfigured");
      return;
    }
    setStatus(shelfStatus, `「${name}」に保存します。`, "ok");
    setStatus(overallStatus, "準備ができました。", "ok");
    showGuidance("ready-guidance");
    return;
  }

  renderUnknown();
}

async function runCheck() {
  if (checkInFlight) return;
  checkInFlight = true;
  recheckButton.disabled = true;
  setStatus(overallStatus, "確認しています…", null);
  try {
    render(await requestHostCheck());
  } finally {
    checkInFlight = false;
    recheckButton.disabled = false;
  }
}

recheckButton.addEventListener("click", () => {
  void runCheck();
});

void runCheck();
