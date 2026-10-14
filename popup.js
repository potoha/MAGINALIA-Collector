const heading = document.getElementById("heading");
const status = document.getElementById("status");
const details = document.getElementById("details");
const permissionStatus = document.getElementById("permission-status");
const entry = new URLSearchParams(window.location.search).get("entry");

if (entry === "selection") {
  heading.textContent = "本棚に追加";
  status.textContent = "選択テキストの保存機能は未実装です。";
  details.textContent = "選択した文章はこの画面に表示されず、保存もされません。";
} else {
  heading.textContent = "準備中";
  status.textContent = "引用の保存と MAGINALIA との接続はまだ実装されていません。";
  details.textContent = "この画面ではページ内容を保存・送信しません。";
}

if (chrome.permissions?.contains) {
  chrome.permissions.contains({ permissions: ["contextMenus"] }, (granted) => {
    if (chrome.runtime.lastError) {
      permissionStatus.textContent = "右クリックメニューの状態を確認できません。保存は行われません。";
      permissionStatus.hidden = false;
      return;
    }

    if (!granted) {
      permissionStatus.textContent = "右クリックメニューの権限が利用できません。保存は行われません。";
      permissionStatus.hidden = false;
    }
  });
}
