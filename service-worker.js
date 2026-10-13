const ADD_SELECTION_MENU_ID = "maginalia-collector-add-selection";

function registerSelectionMenu() {
  const menus = chrome.contextMenus;
  if (!menus?.removeAll || !menus?.create) {
    return;
  }

  try {
    menus.removeAll(() => {
      if (chrome.runtime.lastError) {
        console.warn("Collector context menu registration is unavailable.");
        return;
      }

      try {
        menus.create(
          {
            id: ADD_SELECTION_MENU_ID,
            title: "本棚に追加",
            contexts: ["selection"],
            documentUrlPatterns: ["http://*/*", "https://*/*"]
          },
          () => {
            if (chrome.runtime.lastError) {
              console.warn("Collector context menu could not be registered.");
            }
          }
        );
      } catch {
        console.warn("Collector context menu could not be registered.");
      }
    });
  } catch {
    console.warn("Collector context menu registration is unavailable.");
  }
}

function openSelectionEntry() {
  if (!chrome.tabs?.create) {
    return;
  }

  try {
    chrome.tabs.create(
      {
        url: chrome.runtime.getURL("popup.html?entry=selection"),
        active: true
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn("Collector entry page could not be opened.");
        }
      }
    );
  } catch {
    console.warn("Collector entry page could not be opened.");
  }
}

chrome.runtime.onInstalled.addListener(registerSelectionMenu);
chrome.runtime.onStartup.addListener(registerSelectionMenu);

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== ADD_SELECTION_MENU_ID) {
      return;
    }

    if (typeof info.selectionText !== "string" || info.selectionText.trim().length === 0) {
      return;
    }

    openSelectionEntry();
  });
}
