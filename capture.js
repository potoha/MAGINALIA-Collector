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

const ERROR_COPY = {
  "selection-missing": "選択範囲を取得できませんでした。Webページで文章を選び直してください。",
  "editable-selection": "入力欄で選択された文字は引用画面に取り込みません。通常の本文を選択してください。",
  "page-unavailable": "対象ページのURLを確認できませんでした。HTTPまたはHTTPSのページでやり直してください。",
  "transfer-unavailable": "引用の一時受け渡しを開始できませんでした。選択内容は保存されていません。もう一度選択してください。",
  "open-failed": "確認画面を開けませんでした。選択内容は保存されていません。"
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
}

async function closeCapturePage(button) {
  button.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "collector:close-capture" });
  } catch {
    // The page was opened in a dedicated tab; the browser may close it directly.
  }
  window.close();
}

const params = new URLSearchParams(window.location.search);
const requestId = params.get("requestId");
const errorReason = params.get("error");

if (errorReason) {
  showError(errorReason);
} else if (!requestId) {
  showError("selection-missing");
} else {
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
  void closeCapturePage(cancelButton);
});
errorCloseButton.addEventListener("click", () => {
  void closeCapturePage(errorCloseButton);
});
