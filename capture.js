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
const saveButton = document.getElementById("add-to-shelf");
const testHostSaveButton = document.getElementById("test-host-save");
const outbox = globalThis.CollectorOutbox?.create();
let activeRequestId = null;
let sourcePayload = null;
let isSaving = false;
let isQueued = false;
let isSendingToTestHost = false;
let closeApproved = false;

const ERROR_COPY = {
  "selection-missing": "選択範囲を取得できませんでした。Webページで文章を選び直してください。",
  "editable-selection": "入力欄で選択された文字は引用画面に取り込みません。通常の本文を選択してください。",
  "page-unavailable": "対象ページのURLを確認できませんでした。HTTPまたはHTTPSのページでやり直してください。",
  "transfer-unavailable": "引用の一時受け渡しを開始できませんでした。選択内容は保存されていません。もう一度選択してください。",
  "open-failed": "確認画面を開けませんでした。選択内容は保存されていません。"
};

const TEST_SAVE_COPY = {
  "host-not-configured": "MAGINALIA側のテスト接続設定がありません。引用はブラウザー内に保留したままです。",
  "host-not-registered": "テストHostが登録されていません。引用はブラウザー内に保留したままです。",
  "host-access-forbidden": "このテスト拡張機能はHostから許可されていません。引用はブラウザー内に保留したままです。",
  "host-save-disabled": "Hostのテスト専用保存が有効ではありません。引用はブラウザー内に保留したままです。",
  "shelf-identity-mismatch": "設定ShelfのUUIDが一致しません。引用はブラウザー内に保留したままです。",
  "shelf-not-configured": "MAGINALIA側にShelfが設定されていません。引用はブラウザー内に保留したままです。",
  "idempotency-verification-failed": "同じ依頼IDの再送結果を確認できませんでした。引用はブラウザー内に保留したままです。",
  "host-save-failed": "Shelfへの耐久保存receiptを確認できませんでした。引用はブラウザー内に保留したままです。"
};

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
  errorPanel.hidden = false;
  heading.textContent = "引用を確認できません";
  errorHeading.textContent = "引用を開けませんでした";
  errorMessage.textContent =
    ERROR_COPY[reason] || "引用データを受け取れませんでした。Webページで選択し直してください。";
  saveStatus.textContent = "この画面では引用の保存・送信は行われません。";
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
  void checkTestHostWriteMode();
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

async function checkTestHostWriteMode() {
  const manifest = chrome.runtime?.getManifest?.();
  if (!Array.isArray(manifest?.permissions) || !manifest.permissions.includes("nativeMessaging")) return;
  const response = await requestExtensionMessage({ type: "collector:host-check" });
  const report = response?.ok === true ? response.report : null;
  const testOnlyEnabled = report?.status === "compatible"
    && report.host?.writesEnabled === true
    && Array.isArray(report.host?.operations)
    && report.host.operations.includes("save_web_quote")
    && report.shelf?.type === "private"
    && report.shelf?.writesEnabled === true;
  testHostSaveButton.hidden = !testOnlyEnabled;
}

async function savePendingQuoteToTestHost() {
  if (isSendingToTestHost || !activeRequestId || !sourcePayload) return;
  if (!isQueued) {
    await saveToBrowserQueue();
    if (!isQueued) return;
  }

  isSendingToTestHost = true;
  testHostSaveButton.disabled = true;
  saveStatus.textContent = "隔離テストHostへ送信中です。耐久receiptと同じIDの再送結果を確認しています。";
  try {
    const response = await requestExtensionMessage({
      type: "collector:test-save-pending-quote",
      requestId: activeRequestId
    });
    if (response?.ok !== true || !response.receipt || !response.duplicateReceipt) {
      const code = typeof response?.code === "string" ? response.code : "host-save-failed";
      saveStatus.textContent = TEST_SAVE_COPY[code] || TEST_SAVE_COPY["host-save-failed"];
      return;
    }
    testHostSaveButton.textContent = "Shelf v0.4へ保存済み（再送済み・重複なし）";
    testHostSaveButton.disabled = true;
    saveButton.textContent = "Private Shelfへ保存済み";
    saveStatus.textContent = response.queueCleared === true
      ? `Private Shelfの耐久receiptを確認しました（${response.receipt.state} → ${response.duplicateReceipt.state}）。同じ依頼IDの再送は既存レコードを返し、重複作成しませんでした。`
      : `Private Shelfの耐久receiptを確認しました（${response.receipt.state} → ${response.duplicateReceipt.state}）。ブラウザーの保留データも残っています。再送は同じ依頼IDで安全に確認できます。`;
  } finally {
    isSendingToTestHost = false;
    if (!testHostSaveButton.disabled || !testHostSaveButton.textContent.includes("保存済み")) {
      testHostSaveButton.disabled = false;
    }
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
  saveButton.disabled = true;
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
    saveButton.textContent = result.alreadyQueued ? "保留済み" : "ブラウザー内に保留済み";
    cancelButton.textContent = "閉じる";
    saveStatus.textContent = result.alreadyQueued
      ? "この引用はすでにブラウザー内に保留されています。Private Shelfにはまだ保存されていません。Host未接続のため送信処理は行っていません。"
      : "ブラウザー内に保留しました。Private Shelfにはまだ保存されていません。Host未接続のため送信処理は行っていません。";
  } catch (error) {
    saveStatus.textContent = outboxErrorCopy(error);
    saveButton.disabled = false;
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
  if (sourcePayload && !isQueued && !closeApproved) {
    event.preventDefault();
    event.returnValue = "";
  }
});

const params = new URLSearchParams(window.location.search);
const requestId = params.get("requestId");
const errorReason = params.get("error");

if (errorReason) {
  showError(errorReason);
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
saveButton.addEventListener("click", () => {
  void saveToBrowserQueue();
});
testHostSaveButton.addEventListener("click", () => {
  void savePendingQuoteToTestHost();
});
errorCloseButton.addEventListener("click", () => {
  void closeCapturePage(errorCloseButton);
});
