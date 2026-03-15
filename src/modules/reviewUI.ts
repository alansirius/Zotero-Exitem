import { config } from "../../package.json";
import { extractLiteratureReview, getReviewErrorMessage } from "./reviewAI";
import type { ReviewExtractionProgress } from "./reviewAI";
import {
  closeReviewManagerWindow,
  openReviewManagerWindow,
} from "./reviewManager";
import {
  assignReviewRecordsFolder,
  createReviewFolder,
  ensureDefaultReviewFolder,
  initReviewStore,
  listReviewFolders,
  trackReviewEvent,
  upsertReviewRecord,
} from "./reviewStore";
import { ReviewFolderRow } from "./reviewTypes";

const reviewContextMenuID = `${config.addonRef}-itemmenu-ai-extract-review`;
const reviewToolbarButtonID = `${config.addonRef}-review-manager-button`;
const reviewStylesheetID = `${config.addonRef}-review-manager-style`;
const singleExtractionDefaultFolderName = "我的记录";
const repairRetryDelays = [250, 1000, 3000, 6000];
const boundItemMenuPopups = new WeakSet<EventTarget>();
const boundContextMenuRepairWindows = new WeakSet<Window>();
const boundToolbarRepairWindows = new WeakSet<Window>();

export async function initializeReviewFeature() {
  try {
    await initReviewStore();
  } catch (e) {
    ztoolkit.log(
      "Review store init failed; continue registering UI for compatibility",
      e,
    );
  }
  registerReviewContextMenu();
}

export function registerReviewContextMenu(
  win?: _ZoteroTypes.MainWindow | Window,
) {
  if (win) {
    bindReviewContextMenuRepair(win as Window);
    ensureReviewContextMenuInWindow(win as Window);
    return;
  }

  const wins = getMainWindowsCompat();
  let insertedAny = false;
  for (const mainWin of wins) {
    const windowObj = mainWin as unknown as Window;
    bindReviewContextMenuRepair(windowObj);
    insertedAny = ensureReviewContextMenuInWindow(windowObj) || insertedAny;
  }

  if (insertedAny) return;

  try {
    const globalDoc = ztoolkit.getGlobal("document");
    if (!globalDoc?.querySelector) {
      ztoolkit.log(
        "Review context menu registration deferred: main window document unavailable",
      );
      return;
    }
    const registered = ztoolkit.Menu.register(
      "item",
      buildReviewContextMenuOptions(),
    );
    if (registered === false) {
      ztoolkit.log(
        "Review context menu registration skipped: item popup not found",
      );
    }
  } catch (e) {
    ztoolkit.log("Review context menu registration failed", e);
  }
}

export function registerReviewToolbarButton(win: _ZoteroTypes.MainWindow) {
  registerReviewStylesheet(win as unknown as Window);
  bindReviewToolbarRepair(win as unknown as Window);

  const doc = win.document;
  const id = reviewToolbarButtonID;
  if (doc.getElementById(id)) return;

  const target = findToolbarContainer(doc);
  if (!target) {
    ztoolkit.log(
      "Review toolbar container not found yet; toolbar button will retry",
    );
    return;
  }

  let button: HTMLElement | XULElement;
  const isXUL =
    target.namespaceURI && !String(target.namespaceURI).includes("xhtml");
  if (isXUL && (doc as any).createXULElement) {
    button = (doc as any).createXULElement("toolbarbutton");
    button.setAttribute("id", id);
    button.setAttribute("label", "");
    button.setAttribute(
      "image",
      `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    );
    button.setAttribute("tooltiptext", "打开文献综述管理");
    button.setAttribute("class", "toolbarbutton-1 zotero-tb-button");
    button.setAttribute(
      "style",
      `list-style-image: url(chrome://${config.addonRef}/content/icons/favicon@0.5x.png);`,
    );
    button.addEventListener("command", () => {
      void openReviewManagerWindow(win);
    });
  } else {
    const htmlButton = doc.createElement("button");
    htmlButton.id = id;
    htmlButton.type = "button";
    htmlButton.textContent = "";
    htmlButton.title = "打开文献综述管理";
    htmlButton.setAttribute("aria-label", "打开文献综述管理");
    Object.assign(htmlButton.style, {
      marginLeft: "6px",
      width: "26px",
      height: "26px",
      padding: "0",
      border: "1px solid #cbd5e1",
      borderRadius: "4px",
      backgroundColor: "#ffffff",
      backgroundImage: `url(chrome://${config.addonRef}/content/icons/favicon@0.5x.png)`,
      backgroundRepeat: "no-repeat",
      backgroundPosition: "center",
      backgroundSize: "16px 16px",
      cursor: "pointer",
      fontSize: "0",
    });
    htmlButton.addEventListener("click", () => {
      void openReviewManagerWindow(win);
    });
    button = htmlButton;
  }

  target.appendChild(button);
}

export function registerReviewStylesheet(win: Window) {
  const doc = win.document;
  if (!doc || doc.getElementById(reviewStylesheetID)) return;
  const link = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "link",
  ) as HTMLLinkElement;
  link.id = reviewStylesheetID;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
  doc.documentElement?.appendChild(link);
}

export function unregisterReviewToolbarButton(win: Window) {
  try {
    win.document?.getElementById(reviewToolbarButtonID)?.remove();
  } catch {
    // ignore
  }
  try {
    win.document?.getElementById(reviewStylesheetID)?.remove();
  } catch {
    // ignore
  }
}

export function cleanupReviewFeatureUI() {
  try {
    if (addon?.data?.dialogs?.reviewResult) {
      addon.data.dialogs.reviewResult.window?.close();
      delete addon.data.dialogs.reviewResult;
    }
  } catch {
    // ignore
  }
  closeReviewManagerWindow();
}

export async function handleExtractFromSelection() {
  const items = getSelectedRegularItems();
  if (!items.length) {
    showToast("请先选中至少一篇文献条目", "warning");
    return;
  }
  if (items.length > 5) {
    showToast("单次提炼文献数量不超过5篇，请减少选择数量", "warning");
    return;
  }

  await initReviewStore();
  await trackReviewEvent("ai_extraction_click", {
    timestamp: new Date().toISOString(),
    article_count: items.length,
  }).catch((e) => ztoolkit.log(e));

  const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: "正在提炼文献内容...",
      type: "default",
      progress: 0,
    })
    .show();

  if (items.length === 1) {
    const item = items[0];
    try {
      const targetFolder = await ensureSingleExtractionFolder();
      progress.changeLine({
        text: `正在提炼: ${truncate(item.getDisplayTitle(), 40)}`,
        progress: 0,
      });
      const onProgress = createSingleExtractionProgressUpdater(progress, item);
      const draft = await extractLiteratureReview(item, { onProgress });
      progress.changeLine({
        text: "提炼完成，正在保存结果...",
        progress: 98,
      });
      const savedRow = await upsertReviewRecord(draft, {
        folderID: targetFolder.id,
      });
      await assignReviewRecordsFolder([savedRow.id], null);
      await trackReviewEvent("ai_extraction_success", {
        timestamp: new Date().toISOString(),
        article_id: item.id,
        model_type: `${draft.aiProvider}:${draft.aiModel}`,
      }).catch((e) => ztoolkit.log(e));
      progress.changeLine({
        text: "提炼成功",
        type: "success",
        progress: 100,
      });
      progress.startCloseTimer(2000);
    } catch (e) {
      const message = getReviewErrorMessage(e);
      await trackReviewEvent("ai_extraction_fail", {
        timestamp: new Date().toISOString(),
        article_id: item.id,
        fail_reason: message,
      }).catch((err) => ztoolkit.log(err));
      progress.changeLine({
        text: `提炼失败: ${message}`,
        type: "error",
        progress: 100,
      });
      progress.startCloseTimer(5000);
      showAlert(message);
    }
    return;
  }

  const results: Array<{
    itemID: number;
    title: string;
    ok: boolean;
    error?: string;
  }> = [];
  const batchTargetFolder = await resolveBatchSaveFolder();
  let completed = 0;

  progress.changeLine({
    text: `批量提炼将保存到：${batchTargetFolder.name}`,
    progress: 0,
  });

  for (const item of items) {
    completed += 1;
    const rangeStart = Math.floor(((completed - 1) / items.length) * 100);
    const progressValue = rangeStart;
    progress.changeLine({
      text: `(${completed}/${items.length}) 正在提炼: ${truncate(item.getDisplayTitle(), 34)}`,
      progress: progressValue,
    });

    try {
      const onProgress = createBatchExtractionProgressUpdater(progress, {
        item,
        index: completed,
        total: items.length,
      });
      const draft = await extractLiteratureReview(item, { onProgress });
      await upsertReviewRecord(draft, { folderID: batchTargetFolder.id });
      await trackReviewEvent("ai_extraction_success", {
        timestamp: new Date().toISOString(),
        article_id: item.id,
        model_type: `${draft.aiProvider}:${draft.aiModel}`,
      }).catch((e) => ztoolkit.log(e));
      results.push({ itemID: Number(item.id), title: draft.title, ok: true });
    } catch (e) {
      const msg = getReviewErrorMessage(e);
      await trackReviewEvent("ai_extraction_fail", {
        timestamp: new Date().toISOString(),
        article_id: item.id,
        fail_reason: msg,
      }).catch((err) => ztoolkit.log(err));
      results.push({
        itemID: Number(item.id),
        title: item.getDisplayTitle(),
        ok: false,
        error: msg,
      });
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.length - successCount;
  progress.changeLine({
    text: `批量提炼完成：成功 ${successCount}，失败 ${failCount}`,
    type: failCount ? "default" : "success",
    progress: 100,
  });
  progress.startCloseTimer(4000);

  showAlert(
    [
      `批量提炼完成：成功 ${successCount} 篇，失败 ${failCount} 篇。`,
      successCount ? `成功结果已保存到文件夹：${batchTargetFolder.name}` : "",
      failCount
        ? "失败明细：\n" +
          results
            .filter((r) => !r.ok)
            .map((r) => `- ${truncate(r.title, 40)}: ${r.error}`)
            .join("\n")
        : "结果已保存，已为你打开文献综述页面。",
    ].join("\n\n"),
  );

  if (successCount > 0) {
    await openReviewManagerWindow();
  }
}

async function ensureSingleExtractionFolder() {
  await initReviewStore();
  const folders = await listReviewFolders().catch(
    () => [] as ReviewFolderRow[],
  );
  const existing = folders.find(
    (folder) => folder.name === singleExtractionDefaultFolderName,
  );
  if (existing) return existing;
  return createReviewFolder(singleExtractionDefaultFolderName);
}

function getSelectedRegularItems() {
  const pane = (ztoolkit.getGlobal("ZoteroPane") ||
    (getPrimaryMainWindowCompat() as any)?.ZoteroPane) as any;
  const items = (pane?.getSelectedItems?.() || []) as Zotero.Item[];
  return items.filter((item) => {
    try {
      return item.isRegularItem();
    } catch {
      return Boolean(item?.id);
    }
  });
}

function findToolbarContainer(doc: Document) {
  const ids = [
    "zotero-toolbar",
    "zotero-tb-toolbar",
    "zotero-items-toolbar",
    "zotero-collections-toolbar",
    "zotero-pane-toolbar",
    "zotero-tb-sync",
  ];

  for (const id of ids) {
    const el = doc.getElementById(id);
    if (!el) continue;
    if (id === "zotero-tb-sync") {
      return el.parentElement || null;
    }
    return el;
  }

  return (
    doc.querySelector(
      "#zotero-pane toolbar, #zotero-pane [id*='toolbar'], toolbar",
    ) ||
    doc.querySelector("header") ||
    null
  );
}

async function resolveBatchSaveFolder() {
  await initReviewStore();
  const folders = await listReviewFolders().catch(
    () => [] as ReviewFolderRow[],
  );
  const preferredID = getRememberedLastSaveFolderID();
  const matched = preferredID
    ? folders.find((folder) => folder.id === preferredID) || null
    : null;
  if (matched) return matched;
  const fallback =
    folders.find((folder) => folder.name === "未分类") ||
    (await ensureDefaultReviewFolder());
  return fallback;
}

function getRememberedLastSaveFolderID() {
  try {
    const value = Zotero.Prefs.get(
      `${config.prefsPrefix}.lastSaveFolderID`,
      true,
    );
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

function rememberLastSaveFolderID(folderID: number | null) {
  try {
    if (folderID && Number.isFinite(folderID) && folderID > 0) {
      Zotero.Prefs.set(
        `${config.prefsPrefix}.lastSaveFolderID`,
        Math.floor(folderID),
        true,
      );
      return;
    }
    Zotero.Prefs.clear(`${config.prefsPrefix}.lastSaveFolderID`, true);
  } catch {
    // ignore
  }
}

function showToast(
  text: string,
  type: "success" | "warning" | "error" | "default" = "default",
) {
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text,
      type: type === "warning" ? "default" : type,
      progress: 100,
    })
    .show();
}

function showAlert(text: string) {
  const alertFn = ztoolkit.getGlobal("alert");
  if (typeof alertFn === "function") {
    alertFn(text);
    return;
  }
  try {
    (getPrimaryMainWindowCompat() as any)?.alert(text);
  } catch {
    ztoolkit.log(text);
  }
}

function truncate(text: string, max = 40) {
  const str = String(text || "");
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

function buildReviewContextMenuOptions() {
  return {
    tag: "menuitem" as const,
    id: reviewContextMenuID,
    label: "AI提炼文献内容",
    commandListener: () => {
      void handleExtractFromSelection();
    },
    icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
  };
}

function ensureReviewContextMenuInWindow(win: Window) {
  try {
    const popup = findReviewContextMenuPopup(win.document);
    if (!popup) return false;
    return ensureReviewContextMenuInPopup(popup);
  } catch (e) {
    ztoolkit.log("ensure review context menu failed", e);
    return false;
  }
}

function ensureReviewContextMenuInPopup(popup: XUL.MenuPopup) {
  try {
    bindReviewItemMenuPopup(popup);
    if (popup.querySelector(`#${reviewContextMenuID}`)) {
      return true;
    }
    const registered = ztoolkit.Menu.register(
      popup,
      buildReviewContextMenuOptions(),
    );
    return registered !== false;
  } catch (e) {
    ztoolkit.log("ensure review context menu in popup failed", e);
    return false;
  }
}

function bindReviewItemMenuPopup(popup: XUL.MenuPopup) {
  if (boundItemMenuPopups.has(popup)) return;
  const onPopupShowing = () => {
    try {
      if (!popup.isConnected) return;
      if (!popup.querySelector(`#${reviewContextMenuID}`)) {
        ztoolkit.Menu.register(popup, buildReviewContextMenuOptions());
      }
    } catch (e) {
      ztoolkit.log("repair review context menu failed", e);
    }
  };
  popup.addEventListener("popupshowing", onPopupShowing);
  boundItemMenuPopups.add(popup);
}

function findReviewContextMenuPopup(doc: Document) {
  const direct = doc.getElementById("zotero-itemmenu") as XUL.MenuPopup | null;
  if (direct) return direct;

  const popups = doc.querySelectorAll("menupopup");
  for (const popup of popups) {
    if (isLikelyItemMenuPopup(popup)) {
      return popup as XUL.MenuPopup;
    }
  }
  return null;
}

function isLikelyItemMenuPopup(el: Element) {
  if (!el || el.tagName?.toLowerCase() !== "menupopup") return false;
  const id = String((el as HTMLElement).id || "").toLowerCase();
  if (id === "zotero-itemmenu") return true;
  return id.includes("itemmenu");
}

function bindReviewContextMenuRepair(win: Window) {
  if (boundContextMenuRepairWindows.has(win)) return;
  boundContextMenuRepairWindows.add(win);

  try {
    win.document?.addEventListener(
      "popupshowing",
      (event: Event) => {
        const popup = event.target as Element | null;
        if (!popup || !isLikelyItemMenuPopup(popup)) return;
        void ensureReviewContextMenuInPopup(popup as unknown as XUL.MenuPopup);
      },
      true,
    );
  } catch (e) {
    ztoolkit.log("bind review context menu repair failed", e);
  }

  for (const delay of repairRetryDelays) {
    scheduleWindowTask(win, delay, () => {
      void ensureReviewContextMenuInWindow(win);
    });
  }
}

function bindReviewToolbarRepair(win: Window) {
  if (boundToolbarRepairWindows.has(win)) return;
  boundToolbarRepairWindows.add(win);

  for (const delay of repairRetryDelays) {
    scheduleWindowTask(win, delay, () => {
      const doc = win.document;
      if (!doc || doc.getElementById(reviewToolbarButtonID)) return;
      registerReviewToolbarButton(win as unknown as _ZoteroTypes.MainWindow);
    });
  }

  try {
    const doc = win.document;
    const root = doc?.documentElement;
    const observerClass = (win as any).MutationObserver;
    if (!root || typeof observerClass !== "function") return;
    let queued = false;
    const observer = new observerClass(() => {
      if (queued) return;
      queued = true;
      scheduleWindowTask(win, 60, () => {
        queued = false;
        if (!doc.getElementById(reviewToolbarButtonID)) {
          registerReviewToolbarButton(
            win as unknown as _ZoteroTypes.MainWindow,
          );
        }
      });
    });
    observer.observe(root, { childList: true, subtree: true });
  } catch (e) {
    ztoolkit.log("bind review toolbar repair failed", e);
  }
}

function scheduleWindowTask(win: Window, delayMS: number, task: () => void) {
  try {
    win.setTimeout(() => {
      if ((win as any).closed) return;
      task();
    }, delayMS);
  } catch {
    // ignore
  }
}

function getMainWindowsCompat() {
  const getMainWindows = (Zotero as any)?.getMainWindows;
  if (typeof getMainWindows === "function") {
    const wins = getMainWindows.call(Zotero);
    if (Array.isArray(wins)) return wins as _ZoteroTypes.MainWindow[];
  }
  const getMainWindow = (Zotero as any)?.getMainWindow;
  if (typeof getMainWindow === "function") {
    const win = getMainWindow.call(Zotero);
    return win ? ([win] as _ZoteroTypes.MainWindow[]) : [];
  }

  try {
    const wm = (globalThis as any)?.Services?.wm;
    if (wm?.getEnumerator) {
      const wins: _ZoteroTypes.MainWindow[] = [];
      for (const type of ["zotero:main", "navigator:browser"]) {
        const enumerator = wm.getEnumerator(type);
        while (enumerator?.hasMoreElements?.()) {
          const win = enumerator.getNext();
          if ((win as any)?.document) {
            wins.push(win as _ZoteroTypes.MainWindow);
          }
        }
        if (wins.length) return wins;
      }
    }
  } catch (e) {
    ztoolkit.log("getMainWindowsCompat fallback failed", e);
  }

  return [] as _ZoteroTypes.MainWindow[];
}

function getPrimaryMainWindowCompat() {
  return getMainWindowsCompat()[0] || null;
}

function createSingleExtractionProgressUpdater(
  progressWindow: any,
  item: Zotero.Item,
) {
  const title = truncate(item.getDisplayTitle(), 30);
  let lastProgress = -1;
  let lastStage = "";
  return (update: ReviewExtractionProgress) => {
    const nextProgress = Math.max(0, Math.min(96, Math.floor(update.progress)));
    const nextStage = String(update.stage || "").trim() || "处理中";
    if (nextProgress === lastProgress && nextStage === lastStage) return;
    lastProgress = nextProgress;
    lastStage = nextStage;
    try {
      progressWindow.changeLine({
        text: `正在提炼（${nextProgress}%）: ${title} · ${nextStage}`,
        progress: nextProgress,
      });
    } catch {
      // ignore if progress window closed
    }
  };
}

function createBatchExtractionProgressUpdater(
  progressWindow: any,
  options: { item: Zotero.Item; index: number; total: number },
) {
  const title = truncate(options.item.getDisplayTitle(), 24);
  let lastGlobalProgress = -1;
  let lastStage = "";
  return (update: ReviewExtractionProgress) => {
    const itemProgress = Math.max(
      0,
      Math.min(100, Math.floor(update.progress)),
    );
    const ratioStart = (options.index - 1) / options.total;
    const ratioCurrent =
      (options.index - 1 + itemProgress / 100) / options.total;
    const globalProgress = Math.max(
      0,
      Math.min(
        99,
        Math.floor(ratioStart * 100 + (ratioCurrent - ratioStart) * 100),
      ),
    );
    const nextStage = String(update.stage || "").trim() || "处理中";
    if (globalProgress === lastGlobalProgress && nextStage === lastStage)
      return;
    lastGlobalProgress = globalProgress;
    lastStage = nextStage;
    try {
      progressWindow.changeLine({
        text: `(${options.index}/${options.total}) ${title} · ${nextStage}`,
        progress: globalProgress,
      });
    } catch {
      // ignore if progress window closed
    }
  };
}
