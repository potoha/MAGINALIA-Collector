const heading = document.getElementById("heading");
const status = document.getElementById("status");
const details = document.getElementById("details");
const permissionStatus = document.getElementById("permission-status");
const queueUsage = document.getElementById("queue-usage");
const queueEmpty = document.getElementById("queue-empty");
const queueList = document.getElementById("queue-list");
const outbox = globalThis.CollectorOutbox?.create();

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

void loadPending();
