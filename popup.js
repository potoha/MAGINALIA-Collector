const heading = document.getElementById("heading");
const status = document.getElementById("status");
const details = document.getElementById("details");
const permissionStatus = document.getElementById("permission-status");
const queueUsage = document.getElementById("queue-usage");
const queueEmpty = document.getElementById("queue-empty");
const queueList = document.getElementById("queue-list");
const outbox = globalThis.CollectorOutbox?.create();

const hostCheckButton = document.getElementById("host-check-button");
const hostCheckStatus = document.getElementById("host-check-status");
const hostCheckShelf = document.getElementById("host-check-shelf");
const hostCheckShelfName = document.getElementById("host-check-shelf-name");
const hostCheckShelfId = document.getElementById("host-check-shelf-id");
const hostCheckFailures = document.getElementById("host-check-failures");
const hostCheckFailureList = document.getElementById("host-check-failure-list");

const HOST_CHECK_GENERIC_FAILURE =
  "接続を確認できませんでした。MAGINALIAの状態を確認して、もう一度お試しください。";

const HOST_CHECK_TRANSPORT_FAILURE =
  "接続を確認できませんでした。ツールバー画面を開き直してから、もう一度お試しください。";

const HOST_CHECK_COPY = {
  "host-not-configured": "接続先がまだ設定されていません。MAGINALIA側で接続先を指定してください。",
  "native-messaging-unavailable":
    "このブラウザーでは接続の仕組みを利用できません。ブラウザーの設定を確認してください。",
  "host-not-registered":
    "MAGINALIA連携プログラムがこのブラウザーに登録されていません。連携プログラムを導入してから確認してください。",
  "host-access-forbidden":
    "MAGINALIA連携プログラムへの接続が許可されませんでした。MAGINALIA側の許可の設定を確認してください。",
  "host-exited":
    "MAGINALIA連携プログラムが途中で終了しました。起動しているか確認して、もう一度お試しください。",
  "host-timeout":
    "MAGINALIA連携プログラムから時間内に応答がありませんでした。起動を確認して、もう一度お試しください。",
  "host-communication-failed":
    "MAGINALIA連携プログラムとやり取りできませんでした。もう一度お試しください。",
  "host-unreachable":
    "MAGINALIA連携プログラムに届きませんでした。起動しているか確認してください。",
  "host-no-response":
    "MAGINALIA連携プログラムから応答が返りませんでした。もう一度お試しください。",
  "invalid-response":
    "MAGINALIA連携プログラムからの応答を読み取れませんでした。連携プログラムの版が合っているか確認してください。",
  "host-response-too-large":
    "MAGINALIA連携プログラムからの応答が大きすぎて読み取れませんでした。版が合っているか確認してください。",
  "host-protocol-error":
    "MAGINALIA連携プログラムとのやり取りの形式が合いませんでした。連携プログラムの版を確認してください。",
  "host-rejected-request":
    "MAGINALIA連携プログラムがこの接続確認を受け付けませんでした。MAGINALIA側の設定を確認してください。",
  "host-configuration-invalid":
    "MAGINALIA連携プログラムの設定内容を読み取れませんでした。設定を確認してください。",
  "shelf-configuration-unavailable":
    "Private Shelfの設定を読み取れませんでした。MAGINALIA側で保存先を確認してください。",
  "shelf-not-configured":
    "Private Shelfがまだ設定されていません。MAGINALIA側で保存先を選んでください。",
  "shelf-identity-unavailable":
    "Private Shelfを見分ける情報を確認できませんでした。MAGINALIA側で保存先を確認してください。",
  "shelf-identity-mismatch":
    "設定されたPrivate Shelfと、応答した保存先が一致しません。MAGINALIA側で保存先を選び直してください。",
  "shelf-unavailable":
    "Private Shelfを利用できませんでした。MAGINALIA側で保存先の状態を確認してください。",
  "unsupported-operation":
    "このMAGINALIA連携プログラムは接続確認に対応していません。連携プログラムの版を確認してください。",
  "host-error": "MAGINALIA連携プログラムの処理で問題が発生しました。もう一度お試しください。"
};

// 応答が互換性のない版だったときは、通らなかった確認項目をこの文言で示す。
const HOST_CHECK_FAILURE_COPY = {
  ...HOST_CHECK_COPY,
  "host-configured": "接続先が設定されていません。MAGINALIA側で接続先を指定してください。",
  health: "MAGINALIA連携プログラムから正常な応答を確認できませんでした。",
  "configured-shelf-operation": "このMAGINALIA連携プログラムは保存先の確認に対応していません。",
  "configured-shelf": "指定されたPrivate Shelfを開けませんでした。",
  "shelf-identity": "指定されたPrivate Shelfを照合できませんでした。"
};

let hostCheckInFlight = false;

heading.textContent = "保留中の引用";
status.textContent = "このブラウザー内の保留データを読み込んでいます。";
details.textContent = "ブラウザー内の保留はPrivate Shelfへの保存完了ではありません。Host未接続のため、送信処理は行いません。";

function formatBytes(bytes) {
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MiB`;
}

function formatCreatedAt(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return "日時を確認できません";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function storageErrorCopy(error) {
  switch (error?.code) {
    case "storage-unavailable":
      return "このブラウザーでは保留領域を利用できません。";
    case "storage-blocked":
      return "保留データを開けませんでした。ほかのCollector画面を閉じてから再度お試しください。";
    case "storage-quota":
      return "ブラウザーの保存領域が不足しています。保留中の引用は削除されていません。";
    default:
      return "保留データを読み込めませんでした。ブラウザーの保存領域を確認してください。";
  }
}

function createQueueItem(item) {
  const article = document.createElement("article");
  article.className = "queue-item";

  const kind = document.createElement("p");
  kind.textContent = item.kind === "capture" ? "画像キャプチャー" : "引用";
  article.append(kind);

  const title = document.createElement("h3");
  title.textContent = item.title || "ページタイトルなし";
  article.append(title);

  if (item.pageUrl) {
    const pageUrl = document.createElement("p");
    pageUrl.textContent = item.pageUrl;
    article.append(pageUrl);
  }

  const createdAt = document.createElement("p");
  createdAt.textContent = `保留日時: ${formatCreatedAt(item.createdAt)}`;
  article.append(createdAt);

  const state = document.createElement("p");
  state.className = "queue-item-state";
  state.textContent = item.kind === "capture"
    ? "ブラウザー内に保留中 · Reviewer未送信"
    : "ブラウザー内に保留中 · Private Shelf未保存";
  article.append(state);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.textContent = "この引用を削除";
  removeButton.addEventListener("click", () => {
    void deleteQueueItem(item, removeButton);
  });
  article.append(removeButton);
  return article;
}

async function deleteQueueItem(item, button) {
  const title = item.title || "ページタイトルなし";
  const confirmed = window.confirm(
    `「${title}」をブラウザー内の保留キューから削除します。削除後は元に戻せません。削除しますか？`
  );
  if (!confirmed) {
    return;
  }

  button.disabled = true;
  try {
    const result = await outbox.deletePending(item.requestId);
    if (!result.deleted) {
      status.textContent = "この引用はすでに保留キューから削除されています。";
    } else {
      status.textContent = "選択した引用を保留キューから削除しました。";
    }
    await loadPending();
  } catch (error) {
    button.disabled = false;
    status.textContent = storageErrorCopy(error);
  }
}

async function loadPending() {
  queueList.replaceChildren();
  queueEmpty.hidden = true;
  queueUsage.textContent = "";

  if (!outbox) {
    status.textContent = "保留領域を利用できません。引用の保存状態を確認してください。";
    return;
  }

  try {
    const result = await outbox.listPending();
    queueUsage.textContent = `保留中 ${result.itemCount} 件（${formatBytes(result.totalBytes)} / 128 MiB）`;
    queueEmpty.hidden = result.items.length > 0;
    if (result.items.length === 0) {
      queueEmpty.textContent = "保留中の引用はありません。";
    }
    for (const item of result.items) {
      queueList.append(createQueueItem(item));
    }
    status.textContent = "ブラウザー内の保留データを確認できます。Private Shelfへの保存は未完了です。";
  } catch (error) {
    status.textContent = storageErrorCopy(error);
    queueEmpty.hidden = false;
    queueEmpty.textContent = "保留データを表示できません。保存領域を確認してください。";
  }
}

function hostCheckCopyForCode(code) {
  if (typeof code === "string" && Object.hasOwn(HOST_CHECK_COPY, code)) {
    return HOST_CHECK_COPY[code];
  }
  return HOST_CHECK_GENERIC_FAILURE;
}

function setHostCheckStatus(text, tone) {
  hostCheckStatus.textContent = text;
  hostCheckStatus.className = tone ? `host-check-summary is-${tone}` : "host-check-summary";
}

function resetHostCheckResult() {
  hostCheckStatus.textContent = "";
  hostCheckStatus.className = "host-check-summary";
  hostCheckShelf.hidden = true;
  hostCheckShelfName.textContent = "";
  hostCheckShelfId.textContent = "";
  hostCheckFailures.hidden = true;
  hostCheckFailureList.replaceChildren();
}

function showHostCheckShelf(shelf) {
  if (!shelf || typeof shelf !== "object") {
    return false;
  }

  const name = typeof shelf.name === "string" ? shelf.name.trim() : "";
  const id = typeof shelf.id === "string" ? shelf.id.trim() : "";
  if (!name && !id) {
    return false;
  }

  hostCheckShelfName.textContent = name || "名前を取得できませんでした";
  hostCheckShelfId.textContent = id || "識別IDを取得できませんでした";
  hostCheckShelf.hidden = false;
  return true;
}

function hostCheckFailureCopy(check) {
  if (typeof check.code === "string" && Object.hasOwn(HOST_CHECK_FAILURE_COPY, check.code)) {
    return HOST_CHECK_FAILURE_COPY[check.code];
  }
  if (typeof check.id === "string" && Object.hasOwn(HOST_CHECK_FAILURE_COPY, check.id)) {
    return HOST_CHECK_FAILURE_COPY[check.id];
  }
  return "";
}

function renderHostCheckFailures(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const seen = new Set();

  for (const check of list) {
    if (!check || typeof check !== "object" || check.status === "pass") {
      continue;
    }
    const message = hostCheckFailureCopy(check) || "この項目を確認できませんでした。";
    if (seen.has(message)) {
      continue;
    }
    seen.add(message);
    const item = document.createElement("li");
    item.textContent = message;
    hostCheckFailureList.append(item);
  }

  if (seen.size === 0) {
    const item = document.createElement("li");
    item.textContent = "確認できなかった項目の内容は受け取れませんでした。MAGINALIA側の状態を確認してください。";
    hostCheckFailureList.append(item);
  }

  hostCheckFailures.hidden = false;
}

function renderHostCheck(response) {
  resetHostCheckResult();

  if (!response || typeof response !== "object") {
    setHostCheckStatus(HOST_CHECK_GENERIC_FAILURE, "error");
    return;
  }

  if (response.ok !== true) {
    setHostCheckStatus(hostCheckCopyForCode(response.code), "error");
    return;
  }

  const report = response.report;
  if (!report || typeof report !== "object") {
    setHostCheckStatus(HOST_CHECK_GENERIC_FAILURE, "error");
    return;
  }

  if (report.status === "compatible") {
    if (showHostCheckShelf(report.shelf)) {
      setHostCheckStatus(
        "接続を確認できました。指定されたPrivate Shelfも確認できました。引用の送信や保存はまだ行っていません。",
        "ok"
      );
    } else {
      setHostCheckStatus(
        "接続は確認できましたが、保存先のPrivate Shelfの情報を受け取れませんでした。引用の送信や保存はまだ行っていません。",
        "warn"
      );
    }
    return;
  }

  if (report.status === "incompatible") {
    renderHostCheckFailures(report.checks);
    setHostCheckStatus(
      "接続はできましたが、このCollectorではまだ使えません。次の項目を確認できませんでした。",
      "warn"
    );
    return;
  }

  if (report.status === "unavailable") {
    setHostCheckStatus(hostCheckCopyForCode(report.code), "error");
    return;
  }

  setHostCheckStatus(HOST_CHECK_GENERIC_FAILURE, "error");
}

function requestHostCheck() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    try {
      chrome.runtime.sendMessage({ type: "collector:host-check" }, (response) => {
        if (chrome.runtime.lastError) {
          finish(null);
          return;
        }
        finish(response ?? null);
      });
    } catch {
      finish(null);
    }
  });
}

async function runHostCheck() {
  if (hostCheckInFlight) {
    return;
  }

  hostCheckInFlight = true;
  hostCheckButton.disabled = true;
  resetHostCheckResult();
  setHostCheckStatus("接続を確認しています…", null);

  try {
    const response = await requestHostCheck();
    if (response === null) {
      resetHostCheckResult();
      setHostCheckStatus(HOST_CHECK_TRANSPORT_FAILURE, "error");
      return;
    }
    renderHostCheck(response);
  } finally {
    hostCheckInFlight = false;
    hostCheckButton.disabled = false;
  }
}

if (chrome.permissions?.contains) {
  chrome.permissions.contains({ permissions: ["contextMenus"] }, (granted) => {
    if (chrome.runtime.lastError) {
      permissionStatus.textContent = "右クリックメニューの状態を確認できません。";
      permissionStatus.hidden = false;
      return;
    }

    if (!granted) {
      permissionStatus.textContent = "右クリックメニューの権限が利用できません。";
      permissionStatus.hidden = false;
    }
  });
}

hostCheckButton.addEventListener("click", () => {
  void runHostCheck();
});

void loadPending();
