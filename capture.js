const heading = document.getElementById("heading");
const saveStatus = document.getElementById("save-status");
const entry = document.getElementById("capture-entry");
const errorPanel = document.getElementById("capture-error");
const errorHeading = document.getElementById("error-heading");
const errorMessage = document.getElementById("error-message");
const notices = document.getElementById("review-notices");
const noticeList = document.getElementById("review-notices-list");
const cancelButton = document.getElementById("cancel");
const errorCloseButton = document.getElementById("error-close");
const holdButton = document.getElementById("hold-in-browser");
const shelfSaveButton = document.getElementById("save-to-shelf");
const shelfStatus = document.getElementById("shelf-status");
const recoveryNotice = document.getElementById("outbox-recovery-notice");
const outbox = globalThis.CollectorOutbox?.create();
let activeRequestId = null;
let sourcePayload = null;
let isSaving = false;
let isQueued = false;
let isSendingToShelf = false;
let isSavedToShelf = false;
let closeApproved = false;

const params = new URLSearchParams(window.location.search);
const requestId = params.get("requestId");
const errorReason = params.get("error");
const recoveryMode = params.get("from") === "outbox";
const REQUEST_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const PENDING_QUOTE_STRING_FIELDS = [
  "originalQuote", "quote", "title", "siteName", "pageUrl", "author", "publishedAt",
  "canonicalUrl", "frameUrl", "acquiredAt", "metadataStatus", "comment"
];

const ERROR_COPY = {
  "selection-missing": "選択範囲を取得できませんでした。Webページで文章を選び直してください。",
  "editable-selection": "入力欄で選択された文字は引用画面に取り込みません。通常の本文を選択してください。",
  "page-unavailable": "対象ページのURLを確認できませんでした。HTTPまたはHTTPSのページでやり直してください。",
  "transfer-unavailable": "引用の一時受け渡しを開始できませんでした。選択内容は保存されていません。もう一度選択してください。",
  "open-failed": "確認画面を開けませんでした。選択内容は保存されていません。",
  "invalid-request-id": "保留中の引用の識別情報を確認できませんでした。保留データは削除されていません。",
  "outbox-unavailable": "保留領域を読み込めませんでした。保留データは削除されていません。保存領域を確認してください。",
  "pending-quote-unavailable": "保留中の引用が見つからないか、内容を確認できません。保留データは削除されていません。"
};

const PENDING_KEPT = "引用はこのブラウザーに保留したままです。";

// Cause-specific copy for a failed save. None of these may read as success.
const SAVE_FAILURE_COPY = {
  "host-not-registered":
    "MAGINALIA連携プログラムがこのパソコンに登録されていません。導入ガイドに沿って連携プログラムを導入してから、もう一度保存してください。",
  "host-not-configured":
    "MAGINALIA連携プログラムの接続先を確認できませんでした。導入ガイドに沿って連携プログラムを導入し直してください。",
  "host-access-forbidden":
    "MAGINALIA連携プログラムがこの拡張機能からの接続を許可していません。導入ガイドの手順で拡張機能と連携プログラムを確認してください。",
  "host-configuration-invalid":
    "MAGINALIA連携プログラムの設定を確認できませんでした。連携プログラムを導入し直してください。",
  "shelf-not-configured":
    "保存先の本棚がまだ設定されていません。MAGINALIAで「Collector の保存先」を設定してから、もう一度保存してください。",
  "shelf-configuration-unavailable":
    "保存先の設定を読み取れませんでした。MAGINALIAで「Collector の保存先」を確認してから、もう一度保存してください。",
  "shelf-identity-mismatch":
    "設定された本棚と、見つかった本棚の識別子が一致しません。MAGINALIAで「Collector の保存先」を確認し直してください。",
  "shelf-identity-unavailable":
    "本棚の識別子を確認できませんでした。MAGINALIAで「Collector の保存先」を確認してください。",
  "shelf-unavailable":
    "保存先の本棚を開けませんでした。本棚のフォルダーがあるか、MAGINALIAで確認してください。",
  "shelf-write-busy":
    "本棚をほかの処理が使用中のため、保存できませんでした。少し待ってから、もう一度保存してください。",
  "host-timeout":
    "MAGINALIA連携プログラムから時間内に応答がありませんでした。本棚に保存されたかどうかは確認できていません。もう一度保存しても、同じ引用が二重に保存されることはありません。",
  "host-save-failed":
    "本棚への書き込みを完了できませんでした。もう一度保存してください。繰り返し失敗する場合は、MAGINALIAで本棚の状態を確認してください。",
  "host-save-disabled":
    "MAGINALIA連携プログラムが、いまは本棚への保存を受け付けていません。MAGINALIAで「Collector の保存先」を確認してください。",
  "unsupported-operation":
    "MAGINALIA連携プログラムが、いまは本棚への保存を受け付けていません。連携プログラムの版と、MAGINALIAの「Collector の保存先」を確認してください。",
  "invalid-response":
    "MAGINALIA連携プログラムの応答を確認できなかったため、保存できたとは判断していません。連携プログラムの版を確認してください。",
  "host-protocol-error":
    "MAGINALIA連携プログラムとのやり取りの形式が合いませんでした。連携プログラムの版を確認してください。",
  "host-response-too-large":
    "MAGINALIA連携プログラムの応答を読み取れませんでした。連携プログラムの版を確認してください。",
  "host-rejected-request":
    "MAGINALIA連携プログラムがこの引用を受け付けませんでした。",
  "host-exited":
    "MAGINALIA連携プログラムが途中で終了しました。もう一度保存してください。",
  "host-communication-failed":
    "MAGINALIA連携プログラムとやり取りできませんでした。もう一度保存してください。",
  "host-unreachable":
    "MAGINALIA連携プログラムに届きませんでした。もう一度保存してください。",
  "host-no-response":
    "MAGINALIA連携プログラムから応答がありませんでした。もう一度保存してください。",
  "native-messaging-unavailable":
    "このブラウザーでは、MAGINALIA連携プログラムとの接続を利用できません。",
  "invalid-request":
    "保留中の引用の内容を確認できなかったため、送信していません。",
  "pending-quote-unavailable":
    "保留中の引用を読み込めなかったため、送信していません。",
  "outbox-unavailable":
    "ブラウザー内の保留領域を読み込めなかったため、送信していません。",
  "save-in-progress":
    "この引用はすでに保存処理中です。完了するまでお待ちください。"
};

const SAVE_FAILURE_GENERIC = "本棚に保存できませんでした。";

function saveFailureCopy(code) {
  const message = typeof code === "string" && Object.hasOwn(SAVE_FAILURE_COPY, code)
    ? SAVE_FAILURE_COPY[code]
    : SAVE_FAILURE_GENERIC;
  return `${message}${PENDING_KEPT}`;
}

function setValue(id, value) {
  const field = document.getElementById(id);
  field.value = typeof value === "string" ? value : "";
}

function addNotice(message) {
  const item = document.createElement("li");
  item.textContent = message;
  noticeList.append(item);
}

function showError(reason) {
  entry.hidden = true;
  recoveryNotice.hidden = true;
  errorPanel.hidden = false;
  heading.textContent = recoveryMode ? "保留中の引用を確認できません" : "引用を確認できません";
  errorHeading.textContent = recoveryMode ? "保留中の引用を開けませんでした" : "引用を開けませんでした";
  errorMessage.textContent =
    ERROR_COPY[reason] || (recoveryMode
      ? ERROR_COPY["pending-quote-unavailable"]
      : "引用データを受け取れませんでした。Webページで選択し直してください。");
  saveStatus.textContent = recoveryMode
    ? "この画面では保存・送信を行いません。保留データは削除されていません。"
    : "この画面では引用の保存・送信は行われません。";
}

function formatAcquisitionTime(value) {
  if (typeof value !== "string" || !/^\d{12}$/.test(value)) {
    return "取得日時を確認できませんでした";
  }
  return (
    value.slice(0, 4) + "-" + value.slice(4, 6) + "-" + value.slice(6, 8) +
    " " + value.slice(8, 10) + ":" + value.slice(10, 12) + "（ローカル時刻）"
  );
}

function isValidAcquisitionTime(value) {
  if (typeof value !== "string" || !/^\d{12}$/.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecoverablePendingQuote(item, expectedRequestId) {
  const payload = item?.payload;
  if (!item || item.requestId !== expectedRequestId || item.kind !== "quote"
    || item.localStatus !== "pending" || item.recipient !== "private-shelf"
    || item.recipientStatus !== "not-sent" || !payload || typeof payload !== "object"
    || Array.isArray(payload)) {
    return false;
  }

  if (!PENDING_QUOTE_STRING_FIELDS.every((field) => typeof payload[field] === "string")
    || payload.quote.trim().length === 0 || payload.originalQuote.trim().length === 0
    || !isHttpUrl(payload.pageUrl) || !isValidAcquisitionTime(payload.acquiredAt)
    || typeof payload.isFrameSelection !== "boolean"
    || (payload.selectionMatches !== null && typeof payload.selectionMatches !== "boolean")
    || !["available", "access-limited", "unavailable", "page-changed"].includes(payload.metadataStatus)) {
    return false;
  }

  return true;
}

function setRecoveredFieldsReadOnly() {
  for (const id of ["page-title", "site-name", "page-url", "author", "published-at", "quote", "comment"]) {
    document.getElementById(id).readOnly = true;
  }
}

async function restorePendingQuote(requestId) {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    showError("invalid-request-id");
    return;
  }
  if (!outbox) {
    showError("outbox-unavailable");
    return;
  }

  let item;
  try {
    item = await outbox.getPending(requestId);
  } catch {
    showError("outbox-unavailable");
    return;
  }
  if (!isRecoverablePendingQuote(item, requestId)) {
    showError("pending-quote-unavailable");
    return;
  }

  activeRequestId = requestId;
  isQueued = true;
  setRecoveredFieldsReadOnly();
  holdButton.hidden = true;
  cancelButton.textContent = "閉じる";
  recoveryNotice.hidden = false;
  heading.textContent = "保留中の引用を確認";
  saveStatus.textContent = "保留中の引用を読み込みました。開いただけでは送信されません。";
  renderCapture(item.payload);
}

function renderCapture(payload) {
  sourcePayload = payload;
  entry.hidden = false;
  errorPanel.hidden = true;
  setValue("page-title", payload.title);
  setValue("site-name", payload.siteName);
  setValue("page-url", payload.pageUrl);
  setValue("author", payload.author);
  setValue("published-at", payload.publishedAt);
  setValue("quote", payload.quote);
  setValue("comment", payload.comment);
  document.getElementById("acquired-at").textContent =
    formatAcquisitionTime(payload.acquiredAt);

  if (payload.canonicalUrl) {
    document.getElementById("canonical-field").hidden = false;
    document.getElementById("canonical-url").textContent = payload.canonicalUrl;
  }

  if (payload.isFrameSelection) {
    const frameField = document.getElementById("frame-url-field");
    frameField.hidden = false;
    document.getElementById("frame-url").textContent =
      payload.frameUrl || "選択元フレームのURLを取得できませんでした";
    addNotice("文章はページ内のフレームで選択されました。閲覧ページと引用の出典が一致するか確認してください。");
  }

  if (payload.metadataStatus === "access-limited") {
    addNotice("ページへの一時アクセスが認められず、ページ属性の一部を取得できませんでした。表示内容を確認してください。");
  } else if (payload.metadataStatus === "unavailable") {
    addNotice("ページ属性を自動取得できませんでした。出典情報を確認してください。");
  } else if (payload.metadataStatus === "page-changed") {
    addNotice("取得中にページURLが変わったため、ページ属性を採用しませんでした。出典情報を確認してください。");
  }

  if (payload.selectionMatches === false) {
    addNotice("ページ内の選択範囲を照合できませんでした。引用本文を確認してください。");
  }

  if (noticeList.childElementCount > 0) {
    notices.hidden = false;
  }
  void checkShelfAvailability();
}

function requestExtensionMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response ?? null);
      });
    } catch { resolve(null); }
  });
}

// Shows whether the Host can currently save to the configured Private Shelf. This
// check writes nothing. The save button stays usable either way: a click always
// holds the quote in the browser first, and the Service Worker asks the Host
// again before sending, so nothing is sent unless the Host reports
// save_web_quote for the configured Shelf.
async function checkShelfAvailability() {
  const response = await requestExtensionMessage({ type: "collector:host-check" });
  if (isSendingToShelf || isSavedToShelf) return;
  const report = response?.ok === true ? response.report : null;
  if (!report) {
    shelfStatus.textContent = "MAGINALIAとの接続を確認できませんでした。「本棚に保存」を押すと、もう一度確認します。";
    return;
  }
  const canSave = report.status === "compatible"
    && report.host?.writesEnabled === true
    && Array.isArray(report.host?.operations)
    && report.host.operations.includes("save_web_quote")
    && report.shelf?.type === "private"
    && report.shelf?.writesEnabled === true;
  if (canSave) {
    const name = typeof report.shelf.name === "string" ? report.shelf.name : "";
    shelfStatus.textContent = `MAGINALIAの本棚「${name}」に保存できます。`;
    return;
  }
  const code = report.status === "compatible" ? "host-save-disabled" : report.code;
  const message = typeof code === "string" && Object.hasOwn(SAVE_FAILURE_COPY, code)
    ? SAVE_FAILURE_COPY[code]
    : "MAGINALIAとの接続を確認できませんでした。";
  shelfStatus.textContent = `いまは本棚に保存できません。${message}このブラウザーに保留して、後で保存することもできます。`;
}

function isDurableReceipt(receipt) {
  return Boolean(receipt)
    && (receipt.state === "committed" || receipt.state === "already-committed")
    && receipt.requestId === activeRequestId;
}

function showShelfSaveFailure(code) {
  shelfSaveButton.textContent = "もう一度保存";
  shelfSaveButton.disabled = false;
  saveStatus.textContent = saveFailureCopy(code);
}

// One explicit click sends one save request for this request ID. A resend is
// another explicit click; the Host answers it idempotently.
async function saveToShelf() {
  if (isSendingToShelf || isSavedToShelf || isSaving || !activeRequestId || !sourcePayload) return;
  if (!isQueued) {
    await saveToBrowserQueue();
    if (!isQueued) return;
  }

  isSendingToShelf = true;
  shelfSaveButton.disabled = true;
  shelfSaveButton.textContent = "保存中…";
  holdButton.disabled = true;
  cancelButton.disabled = true;
  saveStatus.textContent = "本棚に保存しています。画面を閉じずにお待ちください。";
  try {
    const response = await requestExtensionMessage({
      type: "collector:save-pending-quote",
      requestId: activeRequestId
    });
    if (response?.ok !== true) {
      showShelfSaveFailure(response?.code);
      return;
    }
    if (!isDurableReceipt(response.receipt)) {
      showShelfSaveFailure("invalid-response");
      return;
    }
    if (response.result === "saved" && response.queueCleared === true) {
      isSavedToShelf = true;
      shelfSaveButton.textContent = "保存しました";
      shelfSaveButton.disabled = true;
      holdButton.hidden = true;
      const name = typeof response.shelf?.name === "string" ? response.shelf.name : "";
      saveStatus.textContent = name ? `保存しました。本棚「${name}」に引用を追加しました。` : "保存しました。";
      shelfStatus.textContent = "この引用は本棚に保存済みです。";
      return;
    }
    if (response.result === "saved-but-local-pending") {
      shelfSaveButton.textContent = "もう一度保存";
      shelfSaveButton.disabled = false;
      saveStatus.textContent = "本棚には保存済みですが、この端末の保留が残っています。"
        + "もう一度保存を押すと、二重に保存せずに保留を片付けます。ツールバー画面から保留を削除することもできます。";
      return;
    }
    showShelfSaveFailure("invalid-response");
  } finally {
    isSendingToShelf = false;
    cancelButton.disabled = false;
    cancelButton.textContent = "閉じる";
  }
}

function outboxErrorCopy(error) {
  switch (error?.code) {
    case "item-too-large":
      return "この引用は上限の16 MiBを超えるため保留できません。内容を短くして再度お試しください。入力内容はこの画面に残っています。";
    case "queue-full":
      return "保留キューの上限128 MiBに達しているため保存できません。保留中の引用を確認してください。入力内容はこの画面に残っています。";
    case "storage-quota":
      return "ブラウザーの保存領域が不足しているため保留できませんでした。既存の保留データは保持されています。入力内容はこの画面に残っています。";
    case "storage-unavailable":
      return "ブラウザー内の保留領域を利用できません。入力内容はこの画面に残っています。";
    case "storage-blocked":
      return "保留領域を開けませんでした。ほかのCollector画面を閉じてから再度お試しください。入力内容はこの画面に残っています。";
    case "invalid-request-id":
      return "この引用の識別情報を確認できず、保留できませんでした。入力内容はこの画面に残っています。";
    default:
      return "ブラウザー内に保留できませんでした。保存領域を確認して再度お試しください。入力内容はこの画面に残っています。";
  }
}

async function saveToBrowserQueue() {
  if (isSaving || isQueued) {
    return;
  }
  if (!outbox || !activeRequestId || !sourcePayload) {
    saveStatus.textContent = "保留領域を利用できません。入力内容はこの画面に残っています。";
    return;
  }

  const quote = document.getElementById("quote").value;
  if (quote.trim().length === 0) {
    saveStatus.textContent = "引用本文を入力してから保留してください。";
    document.getElementById("quote").focus();
    return;
  }

  const title = document.getElementById("page-title").value;
  const pageUrl = document.getElementById("page-url").value;
  const payload = {
    originalQuote: typeof sourcePayload.quote === "string" ? sourcePayload.quote : "",
    quote,
    title,
    siteName: document.getElementById("site-name").value,
    pageUrl,
    author: document.getElementById("author").value,
    publishedAt: document.getElementById("published-at").value,
    canonicalUrl: typeof sourcePayload.canonicalUrl === "string" ? sourcePayload.canonicalUrl : "",
    frameUrl: typeof sourcePayload.frameUrl === "string" ? sourcePayload.frameUrl : "",
    isFrameSelection: sourcePayload.isFrameSelection === true,
    selectionMatches: typeof sourcePayload.selectionMatches === "boolean" ? sourcePayload.selectionMatches : null,
    metadataStatus: typeof sourcePayload.metadataStatus === "string" ? sourcePayload.metadataStatus : "unavailable",
    acquiredAt: typeof sourcePayload.acquiredAt === "string" ? sourcePayload.acquiredAt : "",
    comment: document.getElementById("comment").value
  };

  isSaving = true;
  holdButton.disabled = true;
  cancelButton.disabled = true;
  saveStatus.textContent = "このブラウザー内に保留しています。画面を閉じずにお待ちください。";
  try {
    const result = await outbox.addPending({
      requestId: activeRequestId,
      payload,
      title,
      pageUrl
    });
    isQueued = true;
    entry.querySelectorAll("fieldset").forEach((fieldset) => {
      fieldset.disabled = true;
    });
    holdButton.textContent = result.alreadyQueued ? "保留済み" : "ブラウザー内に保留済み";
    cancelButton.textContent = "閉じる";
    saveStatus.textContent = result.alreadyQueued
      ? "この引用はすでにブラウザー内に保留されています。本棚にはまだ保存されていません。"
      : "ブラウザー内に保留しました。本棚にはまだ保存されていません。";
  } catch (error) {
    saveStatus.textContent = outboxErrorCopy(error);
    holdButton.disabled = false;
  } finally {
    isSaving = false;
    cancelButton.disabled = false;
  }
}

async function closeCapturePage(button) {
  closeApproved = true;
  button.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "collector:close-capture" });
  } catch {
    // The page was opened in a dedicated tab; the browser may close it directly.
  }
  window.close();
}

window.addEventListener("beforeunload", (event) => {
  if (sourcePayload && (!isQueued || isSendingToShelf) && !closeApproved) {
    event.preventDefault();
    event.returnValue = "";
  }
});

if (errorReason) {
  showError(errorReason);
} else if (recoveryMode) {
  void restorePendingQuote(requestId);
} else if (!requestId) {
  showError("selection-missing");
} else {
  activeRequestId = requestId;
  chrome.runtime.sendMessage(
    { type: "collector:consume-capture", requestId },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok || !response.payload) {
        showError("transfer-unavailable");
        return;
      }
      renderCapture(response.payload);
    }
  );
}

cancelButton.addEventListener("click", () => {
  if (!isQueued && !window.confirm("この画面でまだ保留していない引用と編集内容を破棄して閉じます。よろしいですか？")) {
    return;
  }
  void closeCapturePage(cancelButton);
});
holdButton.addEventListener("click", () => {
  void saveToBrowserQueue();
});
shelfSaveButton.addEventListener("click", () => {
  void saveToShelf();
});
errorCloseButton.addEventListener("click", () => {
  void closeCapturePage(errorCloseButton);
});
