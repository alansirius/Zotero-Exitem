import { config } from "../../package.json";
import { createNativeNoteForReviewRecord } from "./reviewNote";
import { getReviewErrorMessage, synthesizeFolderReview } from "./reviewAI";
import type {
  ReviewExtractionProgress,
  ReviewPromptFieldKey,
} from "./reviewAI";
import {
  assignReviewRecordsFolder,
  countReviewRecords,
  createFolderSummaryRecord,
  createReviewFolder,
  deleteReviewFolder,
  deleteReviewRecords,
  exportReviewRecordsAsCSV,
  getReviewRecordByID,
  listReviewFolders,
  listReviewRecords,
  mergeReviewFolders,
  renameReviewFolder,
  removeReviewRecordsFromFolder,
  trackReviewEvent,
  updateLiteratureReviewRecord,
  updateReviewRecordRawResponse,
} from "./reviewStore";
import { ReviewFolderRow, ReviewRecordRow } from "./reviewTypes";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const REVIEW_MANAGER_ROOT_ID = `${config.addonRef}-review-manager-root`;
const REVIEW_TAB_TITLE = "文献综述管理";
const REVIEW_TAB_PAGE_URL = `chrome://${config.addonRef}/content/reviewManager.xhtml`;
export const REVIEW_TAB_ICON_KEY = `${config.addonRef}-review-manager-tab`;
const REVIEW_DIALOG_DEFAULT_WIDTH = 1200;
const REVIEW_DIALOG_DEFAULT_HEIGHT = 860;
const DEFAULT_TABLE_MIN_WIDTH = 960;
const COMPACT_TABLE_MIN_WIDTH = 560;
const TABLE_TRUNCATE_BASE_WIDTH = 280;
const TABLE_TRUNCATE_MIN_FACTOR = 1.05;
const TABLE_TRUNCATE_MAX_FACTOR = 3.6;
const TABLE_TRUNCATE_MIN_SENTENCE_LENGTH = 26;
const TABLE_TRUNCATE_BOUNDARY_WINDOW = 28;
const FIXED_LITERATURE_TABLE_FIELDS: ReviewPromptFieldKey[] = [
  "title",
  "authors",
  "journal",
  "publicationDate",
  "abstract",
  "researchBackground",
  "literatureReview",
  "researchMethods",
  "researchConclusions",
  "keyFindings",
  "classificationTags",
];

interface ManagerState {
  viewMode: ReviewRecordRow["recordType"];
  search: string;
  sortKey: "updatedAt" | "title" | "publicationDate" | "journal";
  sortDir: "asc" | "desc";
  totalRows: number;
  folderFilterID: number | null;
  moveTargetFolderID: number | null;
  selectedFolderIDs: Set<number>;
  selectedRecordIDs: Set<number>;
  selectionAnchorRecordID: number | null;
  pendingFocusFolderKey: string | null;
  folders: ReviewFolderRow[];
  rows: ReviewRecordRow[];
}

interface ManagerRefs {
  root: HTMLDivElement;
  statusText: HTMLDivElement;
  folderList: HTMLDivElement;
  viewLiteratureBtn: HTMLButtonElement;
  viewSummaryBtn: HTMLButtonElement;
  searchInput: HTMLInputElement;
  sortKeyBtn: HTMLButtonElement;
  sortDirBtn: HTMLButtonElement;
  filterStatusText: HTMLSpanElement;
  table: HTMLTableElement;
  tableHeadRow: HTMLTableRowElement;
  tableBody: HTMLTableSectionElement;
  preview: HTMLTextAreaElement;
  selectionText: HTMLSpanElement;
  btnCreateFolder: HTMLButtonElement;
  btnRenameFolder: HTMLButtonElement;
  btnDeleteFolder: HTMLButtonElement;
  btnMergeFolder: HTMLButtonElement;
  btnFolderSummary: HTMLButtonElement;
  btnMoveSelected: HTMLButtonElement;
  btnRemoveSelected: HTMLButtonElement;
  btnDeleteSelected: HTMLButtonElement;
  btnSelectAll: HTMLButtonElement;
  btnClearSelection: HTMLButtonElement;
  btnPreviewRaw: HTMLButtonElement;
  btnCreateNote: HTMLButtonElement;
  btnExport: HTMLButtonElement;
}

interface ManagerContext {
  mode: "tab" | "dialog";
  helper: any;
  state: ManagerState;
  tabID?: string;
  refs?: ManagerRefs;
}

interface TableColumnSpec {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
  maxWidth?: number;
  renderCell: (
    ctx: ManagerContext,
    row: ReviewRecordRow,
    rowIndex: number,
  ) => string | Node;
}

let managerContext: ManagerContext | null = null;
let managerOpenPromise: Promise<void> | null = null;

export async function openReviewManagerWindow(preferredWin?: Window) {
  if (managerContext) {
    if (managerOpenPromise) {
      await managerOpenPromise.catch(() => undefined);
      if (managerContext && isManagerContextAlive(managerContext)) {
        focusManagerContext(managerContext);
        await refreshManagerData(managerContext);
        renderManager(managerContext);
      }
      return;
    }
    if (isManagerContextAlive(managerContext)) {
      focusManagerContext(managerContext);
      await refreshManagerData(managerContext);
      renderManager(managerContext);
      return;
    }
  }

  const ctx: ManagerContext = {
    mode: "tab",
    helper: null,
    state: {
      viewMode: "literature",
      search: "",
      sortKey: "updatedAt",
      sortDir: "desc",
      totalRows: 0,
      folderFilterID: null,
      moveTargetFolderID: null,
      selectedFolderIDs: new Set<number>(),
      selectedRecordIDs: new Set<number>(),
      selectionAnchorRecordID: null,
      pendingFocusFolderKey: null,
      folders: [],
      rows: [],
    },
  };
  managerContext = ctx;
  const openTask = (async () => {
    const win = getTargetMainWindow(preferredWin);
    const openedInTab = win ? await openReviewManagerInTab(ctx, win) : false;
    if (!openedInTab) {
      await openReviewManagerInDialog(ctx);
    }
  })();
  managerOpenPromise = openTask;

  try {
    await openTask;
  } finally {
    if (managerOpenPromise === openTask) {
      managerOpenPromise = null;
    }
  }
  if (managerContext !== ctx || !isManagerContextAlive(ctx)) {
    return;
  }

  void trackReviewEvent("table_view_click", {
    timestamp: new Date().toISOString(),
  }).catch((e) => ztoolkit.log(e));
  void trackReviewEvent("plugin_open", {
    timestamp: new Date().toISOString(),
    source: "review-manager",
  }).catch((e) => ztoolkit.log(e));
}

export function closeReviewManagerWindow() {
  const ctx = managerContext;
  managerContext = null;
  if (!ctx) return;

  try {
    if (ctx.mode === "tab" && ctx.tabID) {
      const tabs = getTabsAPI(getManagerMainWindow(ctx));
      tabs?.close(ctx.tabID);
      return;
    }
    ctx.helper?.window?.close?.();
  } catch {
    // ignore
  }
}

function isManagerContextAlive(ctx: ManagerContext) {
  if (ctx.mode === "tab") {
    const frame = ctx.helper?.frame as
      | (XULElement & { isConnected?: boolean; contentWindow?: Window | null })
      | undefined;
    if (frame) {
      return Boolean(frame.isConnected && frame.contentWindow);
    }
    if (!ctx.tabID) return false;
    const tabs = getTabsAPI(getManagerMainWindow(ctx));
    if (!tabs) return false;
    try {
      if (typeof tabs._getTab === "function") {
        tabs._getTab(ctx.tabID);
        return true;
      }
      return Boolean(ctx.helper?.window && !ctx.helper.window.closed);
    } catch {
      return false;
    }
  }
  return Boolean(ctx.helper?.window && !ctx.helper.window.closed);
}

function focusManagerContext(ctx: ManagerContext) {
  if (ctx.mode === "tab" && ctx.tabID) {
    const win = getManagerMainWindow(ctx) as any;
    try {
      win?.focus?.();
      win?.Zotero_Tabs?.select?.(ctx.tabID);
      return;
    } catch (e) {
      ztoolkit.log("Failed to select review tab", e);
    }
  }
  try {
    ctx.helper?.window?.focus?.();
  } catch {
    // ignore
  }
}

function getTargetMainWindow(preferredWin?: Window) {
  const preferred = preferredWin as any;
  if (preferred?.document) {
    return preferred as Window;
  }
  return (getMainWindowsCompat()[0] as unknown as Window) || null;
}

function getTabsAPI(win: any) {
  return (win as any)?.Zotero_Tabs || null;
}

function getManagerMainWindow(ctx: ManagerContext) {
  return (
    (ctx.helper?.mainWindow as Window | null) ||
    (ctx.helper?.window as Window | null) ||
    null
  );
}

async function openReviewManagerInTab(ctx: ManagerContext, win: Window) {
  const tabs = getTabsAPI(win);
  if (!tabs?.add) {
    return false;
  }

  let openedTabID: string | null = null;
  try {
    const { id, container } = tabs.add({
      type: "library",
      title: REVIEW_TAB_TITLE,
      data: {
        icon: REVIEW_TAB_ICON_KEY,
      },
      select: true,
      onClose: () => {
        if (managerContext === ctx) {
          managerContext = null;
        }
      },
    });
    if (!container) {
      throw new Error("review manager tab container unavailable");
    }

    ctx.mode = "tab";
    ctx.tabID = id;
    openedTabID = id;
    ctx.helper = { mainWindow: win, window: win };
    await prepareTabContainer(ctx, win.document, container as Element);
    await refreshAndRender(ctx);
    return true;
  } catch (e) {
    if (openedTabID) {
      try {
        tabs?.close?.(openedTabID);
      } catch {
        // ignore
      }
    }
    ztoolkit.log("Failed to open review manager in tab", e);
    return false;
  }
}

async function prepareTabContainer(
  ctx: ManagerContext,
  doc: Document,
  container: Element,
) {
  const host = container as HTMLElement;
  if (host?.style) {
    host.style.width = "100%";
    host.style.maxWidth = "100%";
    host.style.height = "100%";
    host.style.maxHeight = "100%";
    host.style.overflow = "hidden";
    host.style.minWidth = "0";
    host.style.minHeight = "0";
    host.style.boxSizing = "border-box";
  }
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  const frame = createXULElement(doc, "iframe") as XULElement & {
    contentWindow?: Window | null;
    contentDocument?: Document | null;
  };
  frame.setAttribute("flex", "1");
  frame.setAttribute("src", REVIEW_TAB_PAGE_URL);
  frame.setAttribute("transparent", "true");
  (frame as unknown as HTMLElement).style.border = "0";
  (frame as unknown as HTMLElement).style.width = "100%";
  (frame as unknown as HTMLElement).style.height = "100%";
  const frameReady = waitForFrameReady(frame);
  container.appendChild(frame);

  const frameWin = await frameReady;
  ctx.helper = {
    mainWindow: getManagerMainWindow(ctx) || doc.defaultView,
    window: frameWin,
    frame,
  };
  mountManagerUI(ctx);
}

function openReviewManagerInDialog(ctx: ManagerContext) {
  return new Promise<void>((resolve) => {
    let resolved = false;
    const finishOpen = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    ctx.mode = "dialog";
    const dialogData: Record<string, any> = {
      loadCallback: () => {
        const mount = () => {
          if (!ctx.helper?.window) {
            setTimeout(mount, 0);
            return;
          }
          try {
            setupReviewManagerDialogWindow(ctx.helper.window as Window);
            mountManagerUI(ctx);
            void refreshAndRender(ctx).finally(() => finishOpen());
          } catch (e) {
            ztoolkit.log("Failed to mount review manager dialog", e);
            finishOpen();
          }
        };
        mount();
      },
      unloadCallback: () => {
        if (addon?.data?.dialogs) {
          delete addon.data.dialogs.reviewManager;
        }
        if (managerContext === ctx) {
          managerContext = null;
        }
      },
    };

    const helper = new ztoolkit.Dialog(1, 1)
      .addCell(0, 0, {
        tag: "div",
        namespace: "html",
        id: REVIEW_MANAGER_ROOT_ID,
        styles: {
          width: `${REVIEW_DIALOG_DEFAULT_WIDTH - 48}px`,
          minWidth: `${REVIEW_DIALOG_DEFAULT_WIDTH - 48}px`,
          maxWidth: `${REVIEW_DIALOG_DEFAULT_WIDTH - 48}px`,
          height: `${REVIEW_DIALOG_DEFAULT_HEIGHT - 120}px`,
          minHeight: `${REVIEW_DIALOG_DEFAULT_HEIGHT - 120}px`,
          maxHeight: `${REVIEW_DIALOG_DEFAULT_HEIGHT - 120}px`,
          overflow: "hidden",
          boxSizing: "border-box",
        },
      })
      .addButton("关闭", "close")
      .setDialogData(dialogData)
      .open("文献综述");
    ctx.helper = helper;

    addon.data.dialogs = addon.data.dialogs || {};
    addon.data.dialogs.reviewManager = helper;

    if (dialogData.unloadLock?.promise) {
      void dialogData.unloadLock.promise.catch(() => undefined);
    }
    const mainWin = getTargetMainWindow();
    if (mainWin) {
      scheduleWindowTask(mainWin, 200, finishOpen);
    } else {
      setTimeout(finishOpen, 200);
    }
  });
}

function setupReviewManagerDialogWindow(win: Window) {
  try {
    const root = win.document.documentElement;
    root?.setAttribute("width", String(REVIEW_DIALOG_DEFAULT_WIDTH));
    root?.setAttribute("height", String(REVIEW_DIALOG_DEFAULT_HEIGHT));
    root?.setAttribute("minwidth", String(REVIEW_DIALOG_DEFAULT_WIDTH));
    root?.setAttribute("minheight", String(REVIEW_DIALOG_DEFAULT_HEIGHT));
    root?.setAttribute("maxwidth", String(REVIEW_DIALOG_DEFAULT_WIDTH));
    root?.setAttribute("maxheight", String(REVIEW_DIALOG_DEFAULT_HEIGHT));
    root?.setAttribute("resizable", "false");
    root?.setAttribute("sizetocontent", "false");
    const body = win.document.body as HTMLElement | null;
    if (body?.style) {
      body.style.width = "100%";
      body.style.maxWidth = "100%";
      body.style.minWidth = "0";
      body.style.height = "100%";
      body.style.maxHeight = "100%";
      body.style.overflow = "hidden";
      body.style.boxSizing = "border-box";
      body.style.margin = "0";
    }
    win.resizeTo(REVIEW_DIALOG_DEFAULT_WIDTH, REVIEW_DIALOG_DEFAULT_HEIGHT);
  } catch {
    // ignore
  }
}

async function refreshAndRender(ctx: ManagerContext) {
  await refreshManagerData(ctx);
  renderManager(ctx);
}

async function refreshManagerData(ctx: ManagerContext) {
  const { state } = ctx;
  state.folders = await listReviewFolders();
  state.totalRows = await countReviewRecords({
    recordType: state.viewMode,
    search: state.search,
    folderID: state.folderFilterID,
  });
  state.rows = await listReviewRecords({
    recordType: state.viewMode,
    search: state.search,
    folderID: state.folderFilterID,
    sortKey: state.sortKey,
    sortDir: state.sortDir,
  });

  const validRecordIDs = new Set(state.rows.map((row) => row.id));
  if (
    state.selectionAnchorRecordID != null &&
    !validRecordIDs.has(state.selectionAnchorRecordID)
  ) {
    state.selectionAnchorRecordID = null;
  }

  const validFolderIDs = new Set(state.folders.map((folder) => folder.id));
  state.selectedFolderIDs = new Set(
    Array.from(state.selectedFolderIDs).filter((id) => validFolderIDs.has(id)),
  );
  if (
    state.moveTargetFolderID != null &&
    !validFolderIDs.has(state.moveTargetFolderID)
  ) {
    state.moveTargetFolderID = null;
  }

  if (
    state.folderFilterID != null &&
    !state.folders.some((folder) => folder.id === state.folderFilterID)
  ) {
    state.folderFilterID = null;
  }
}

function mountManagerUI(ctx: ManagerContext) {
  const win = ctx.helper.window as Window;
  const doc = win.document;
  const root = doc.getElementById(
    REVIEW_MANAGER_ROOT_ID,
  ) as HTMLDivElement | null;
  if (!root) {
    throw new Error("review manager root not found");
  }

  root.innerHTML = "";
  if (ctx.mode === "dialog") {
    const contentWidth = Math.max(760, REVIEW_DIALOG_DEFAULT_WIDTH - 48);
    const contentHeight = Math.max(560, REVIEW_DIALOG_DEFAULT_HEIGHT - 120);
    root.style.width = `${contentWidth}px`;
    root.style.minWidth = `${contentWidth}px`;
    root.style.maxWidth = `${contentWidth}px`;
    root.style.height = `${contentHeight}px`;
    root.style.minHeight = `${contentHeight}px`;
    root.style.maxHeight = `${contentHeight}px`;
    root.style.overflow = "hidden";
  } else {
    root.style.width = "100%";
    root.style.maxWidth = "100%";
    root.style.height = "100%";
    root.style.maxHeight = "100%";
    root.style.minWidth = "";
    root.style.minHeight = "";
    root.style.maxWidth = "100%";
    root.style.maxHeight = "100%";
    root.style.overflow = "hidden";
  }
  root.style.boxSizing = "border-box";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "10px";
  root.style.padding = "12px";
  root.style.overflow = "hidden";
  root.style.position = "relative";
  root.style.fontFamily =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  root.style.background = "#f8fafc";

  const titleRow = createEl(doc, "div", {
    style: {
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      justifyContent: "space-between",
      gap: "8px",
      padding: "8px 10px",
      border: "1px solid #e2e8f0",
      borderRadius: "8px",
      background: "#ffffff",
    },
  });

  const titleText = createEl(doc, "div", {
    text: "文献综述管理",
    style: {
      fontSize: "14px",
      fontWeight: "600",
      color: "#1f2937",
    },
  });

  const filterStatusText = createEl(doc, "span", {
    text: "筛选：全部文件夹",
    style: {
      fontSize: "12px",
      color: "#334155",
      whiteSpace: "nowrap",
      background: "#eef2ff",
      border: "1px solid #dbeafe",
      borderRadius: "999px",
      padding: "2px 10px",
    },
  }) as HTMLSpanElement;
  const selectionText = createEl(doc, "span", {
    text: "未选择",
    style: {
      fontSize: "12px",
      color: "#334155",
      background: "#f1f5f9",
      border: "1px solid #e2e8f0",
      borderRadius: "999px",
      padding: "2px 10px",
      whiteSpace: "nowrap",
    },
  }) as HTMLSpanElement;

  const statusText = createEl(doc, "div", {
    text: "加载中...",
    style: {
      fontSize: "12px",
      color: "#475569",
      background: "#f1f5f9",
      border: "1px solid #e2e8f0",
      borderRadius: "999px",
      padding: "2px 10px",
      whiteSpace: "nowrap",
      minWidth: "0",
      maxWidth: "100%",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
  });
  const titleMetaWrap = createEl(doc, "div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      flexWrap: "wrap",
      gap: "8px",
      marginLeft: "auto",
    },
  });
  titleMetaWrap.append(filterStatusText, selectionText, statusText);
  titleRow.append(titleText, titleMetaWrap);

  const toolbar = createEl(doc, "div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: "8px",
      alignItems: "center",
      border: "1px solid #e2e8f0",
      borderRadius: "8px",
      background: "#ffffff",
      padding: "8px",
    },
  });

  const searchInput = createEl(doc, "input", {
    attrs: {
      type: "search",
      placeholder: "搜索标题/作者/期刊/标签/提炼内容...",
    },
    style: {
      flex: "1 1 320px",
      minWidth: "240px",
      height: "28px",
      border: "1px solid #cbd5e1",
      borderRadius: "6px",
      padding: "0 10px",
      fontSize: "12px",
      boxSizing: "border-box",
      background: "#f8fafc",
    },
  }) as HTMLInputElement;

  const viewLiteratureBtn = createButton(doc, "文献记录");
  const viewSummaryBtn = createButton(doc, "合并综述");
  const sortKeyBtn = createButton(doc, "排序：更新时间");
  const sortDirBtn = createButton(doc, "降序");
  toolbar.append(searchInput, sortKeyBtn, sortDirBtn);

  const actionBar = createEl(doc, "div", {
    style: {
      display: "flex",
      gap: "8px",
      flexWrap: "wrap",
      alignItems: "center",
      border: "1px solid #e2e8f0",
      borderRadius: "8px",
      background: "#ffffff",
      padding: "8px",
    },
  });

  const btnCreateFolder = createButton(doc, "新建文件夹");
  const btnRenameFolder = createButton(doc, "重命名文件夹");
  const btnDeleteFolder = createButton(doc, "删除文件夹");
  const btnMergeFolder = createButton(doc, "合并文件夹");
  const btnFolderSummary = createButton(doc, "合并综述");
  const btnMoveSelected = createButton(doc, "加入文件夹");
  const btnRemoveSelected = createButton(doc, "移出文件夹");
  const btnDeleteSelected = createButton(doc, "删除记录");
  const btnSelectAll = createButton(doc, "全选");
  const btnClearSelection = createButton(doc, "清空选择");
  const btnPreviewRaw = createButton(doc, "编辑记录");
  const btnCreateNote = createButton(doc, "生成笔记");
  const btnExport = createButton(doc, "导出表格");
  const actionDividerA = createEl(doc, "span", {
    style: {
      width: "1px",
      height: "20px",
      background: "#e2e8f0",
      margin: "0 2px",
    },
  });
  const actionDividerB = createEl(doc, "span", {
    style: {
      width: "1px",
      height: "20px",
      background: "#e2e8f0",
      margin: "0 2px",
    },
  });
  actionBar.append(
    btnCreateFolder,
    btnRenameFolder,
    btnDeleteFolder,
    btnMergeFolder,
    btnFolderSummary,
    actionDividerA,
    btnMoveSelected,
    btnRemoveSelected,
    btnDeleteSelected,
    btnPreviewRaw,
    actionDividerB,
    btnSelectAll,
    btnClearSelection,
    btnExport,
    btnCreateNote,
  );

  const content = createEl(doc, "div", {
    style: {
      display: "grid",
      gridTemplateColumns: "240px minmax(0, 1fr)",
      gap: "8px",
      flex: "1",
      width: "100%",
      maxWidth: "100%",
      minWidth: "0",
      minHeight: "0",
      overflow: "hidden",
    },
  });

  const leftPane = createEl(doc, "div", {
    style: {
      border: "1px solid #dbe3ef",
      borderRadius: "8px",
      padding: "10px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      minHeight: "0",
      background: "#ffffff",
      boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
    },
  });
  leftPane.append(
    createEl(doc, "div", {
      text: "分类文件夹",
      style: { fontSize: "12px", fontWeight: "600", color: "#111827" },
    }),
  );

  const folderList = createEl(doc, "div", {
    attrs: {},
    style: {
      width: "100%",
      flex: "1",
      minHeight: "0",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      overflow: "auto",
      paddingRight: "2px",
    },
  }) as HTMLDivElement;
  leftPane.append(folderList);

  const rightPane = createEl(doc, "div", {
    style: {
      display: "grid",
      gridTemplateRows: "minmax(0, 1fr) 180px",
      gap: "8px",
      width: "100%",
      minWidth: "0",
      maxWidth: "100%",
      minHeight: "0",
      overflow: "hidden",
    },
  });

  const tableWrap = createEl(doc, "div", {
    style: {
      border: "1px solid #dbe3ef",
      borderRadius: "8px",
      overflow: "hidden",
      background: "#fff",
      width: "100%",
      minWidth: "0",
      maxWidth: "100%",
      minHeight: "0",
      display: "grid",
      gridTemplateRows: "auto minmax(0, 1fr)",
      boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
    },
  });

  const tableToolbar = createEl(doc, "div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr auto 1fr",
      alignItems: "center",
      gap: "8px",
      padding: "10px",
      borderBottom: "1px solid #e2e8f0",
      background: "#f8fafc",
    },
  });
  const viewSwitchWrap = createEl(doc, "div", {
    style: {
      display: "inline-flex",
      border: "1px solid #cbd5e1",
      borderRadius: "6px",
      overflow: "hidden",
      background: "#fff",
    },
  });
  viewLiteratureBtn.style.border = "none";
  viewLiteratureBtn.style.borderRight = "1px solid #d1d5db";
  viewLiteratureBtn.style.borderRadius = "0";
  viewLiteratureBtn.dataset.segmented = "1";
  viewSummaryBtn.style.border = "none";
  viewSummaryBtn.style.borderRadius = "0";
  viewSummaryBtn.dataset.segmented = "1";
  viewSwitchWrap.append(viewLiteratureBtn, viewSummaryBtn);
  const toolbarLeftSpacer = createEl(doc, "div", {
    style: {
      minWidth: "0",
    },
  });
  const switchControlCenter = createEl(doc, "div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: "0",
    },
  });
  switchControlCenter.append(viewSwitchWrap);
  const toolbarRightSpacer = createEl(doc, "div", {
    style: {
      minWidth: "0",
    },
  });
  tableToolbar.append(
    toolbarLeftSpacer,
    switchControlCenter,
    toolbarRightSpacer,
  );

  const tableScrollWrap = createEl(doc, "div", {
    style: {
      overflowX: "scroll",
      overflowY: "auto",
      width: "100%",
      minWidth: "0",
      maxWidth: "100%",
      minHeight: "0",
      height: "100%",
      maxHeight: "100%",
      scrollbarGutter: "stable both-edges",
      overscrollBehavior: "contain",
    },
  });

  const table = createEl(doc, "table", {
    style: {
      width: "100%",
      maxWidth: "100%",
      borderCollapse: "collapse",
      fontSize: "12px",
      tableLayout: "fixed",
    },
  }) as HTMLTableElement;

  const thead = createEl(doc, "thead") as HTMLTableSectionElement;
  const headRow = createEl(doc, "tr") as HTMLTableRowElement;
  thead.appendChild(headRow);

  const tableBody = createEl(doc, "tbody") as HTMLTableSectionElement;
  table.append(thead, tableBody);
  tableScrollWrap.appendChild(table);
  tableWrap.append(tableToolbar, tableScrollWrap);

  const previewWrap = createEl(doc, "div", {
    style: {
      border: "1px solid #dbe3ef",
      borderRadius: "8px",
      padding: "10px",
      display: "grid",
      gridTemplateRows: "auto 1fr",
      gap: "6px",
      minWidth: "0",
      minHeight: "0",
      background: "#fff",
      boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
      position: "sticky",
      bottom: "0",
      zIndex: "2",
      overflow: "hidden",
    },
  });
  previewWrap.append(
    createEl(doc, "div", {
      text: "内容预览",
      style: { fontSize: "12px", fontWeight: "600" },
    }),
  );
  const preview = createEl(doc, "textarea", {
    attrs: { readonly: "readonly" },
    style: {
      width: "100%",
      height: "100%",
      minHeight: "130px",
      resize: "vertical",
      fontSize: "13px",
      lineHeight: "1.6",
      boxSizing: "border-box",
      border: "1px solid #e2e8f0",
      borderRadius: "6px",
      padding: "10px",
      background: "#f8fafc",
      color: "#1e293b",
    },
  }) as HTMLTextAreaElement;
  previewWrap.append(preview);

  rightPane.append(tableWrap, previewWrap);
  content.append(leftPane, rightPane);

  root.append(titleRow, toolbar, actionBar, content);

  ctx.refs = {
    root,
    statusText,
    folderList,
    viewLiteratureBtn,
    viewSummaryBtn,
    searchInput,
    sortKeyBtn,
    sortDirBtn,
    filterStatusText,
    table,
    tableHeadRow: headRow,
    tableBody,
    preview,
    selectionText,
    btnCreateFolder,
    btnRenameFolder,
    btnDeleteFolder,
    btnMergeFolder,
    btnFolderSummary,
    btnMoveSelected,
    btnRemoveSelected,
    btnDeleteSelected,
    btnSelectAll,
    btnClearSelection,
    btnPreviewRaw,
    btnCreateNote,
    btnExport,
  };

  searchInput.addEventListener("input", () => {
    ctx.state.search = searchInput.value.trim();
    void refreshAndRender(ctx);
  });
  searchInput.addEventListener("focus", () => {
    searchInput.style.borderColor = "#93c5fd";
    searchInput.style.background = "#ffffff";
  });
  searchInput.addEventListener("blur", () => {
    searchInput.style.borderColor = "#cbd5e1";
    searchInput.style.background = "#f8fafc";
  });
  viewLiteratureBtn.addEventListener("click", () => {
    switchManagerView(ctx, "literature");
  });
  viewSummaryBtn.addEventListener("click", () => {
    switchManagerView(ctx, "folderSummary");
  });

  sortKeyBtn.addEventListener("click", () => {
    ctx.state.sortKey = cycleSortKey(ctx.state.sortKey);
    void refreshAndRender(ctx);
  });

  sortDirBtn.addEventListener("click", () => {
    ctx.state.sortDir = ctx.state.sortDir === "desc" ? "asc" : "desc";
    void refreshAndRender(ctx);
  });

  btnCreateFolder.addEventListener("click", async () => {
    const name = await promptForFolderName(ctx, "请输入新文件夹名称", "");
    if (name == null) return;
    if (!name) {
      win.alert("文件夹名称不能为空");
      return;
    }
    try {
      const folder = await createReviewFolder(name);
      applyFocusedFolderState(ctx, folder.id);
      await trackReviewEvent("folder_create", {
        timestamp: new Date().toISOString(),
        folder_name: folder.name,
      });
      await refreshAndRender(ctx);
      showManagerToast(`已创建文件夹“${folder.name}”`);
    } catch (e: any) {
      win.alert(`创建文件夹失败：${e?.message || e}`);
    }
  });

  btnRenameFolder.addEventListener("click", async () => {
    await handleRenameFolderRequest(ctx, resolveFolderForRename(ctx));
  });

  btnDeleteFolder.addEventListener("click", async () => {
    const ids = Array.from(ctx.state.selectedFolderIDs);
    if (!ids.length) {
      win.alert("请先在左侧选中文件夹");
      return;
    }
    if (
      !win.confirm(
        `确认删除所选 ${ids.length} 个文件夹？无其他分类的记录将自动归入“未分类”。`,
      )
    ) {
      return;
    }
    try {
      const locked = ids
        .map((id) => ctx.state.folders.find((f) => f.id === id))
        .filter((f): f is ReviewFolderRow => Boolean(f))
        .filter((f) => isProtectedFolderName(f.name));
      if (locked.length) {
        win.alert(
          `系统文件夹不可删除：${locked.map((f) => f.name).join("、")}`,
        );
        return;
      }
      for (const id of ids) {
        const folder = ctx.state.folders.find((f) => f.id === id);
        await deleteReviewFolder(id);
        await trackReviewEvent("folder_delete", {
          timestamp: new Date().toISOString(),
          folder_name: folder?.name || String(id),
        });
      }
      ctx.state.selectedFolderIDs.clear();
      await refreshAndRender(ctx);
    } catch (e: any) {
      win.alert(`删除文件夹失败：${e?.message || e}`);
    }
  });

  btnMergeFolder.addEventListener("click", async () => {
    const ids = Array.from(ctx.state.selectedFolderIDs);
    if (ids.length < 2) {
      win.alert("请在左侧至少选择两个文件夹进行合并");
      return;
    }
    const locked = ids
      .map((id) => ctx.state.folders.find((f) => f.id === id))
      .filter((f): f is ReviewFolderRow => Boolean(f))
      .filter((f) => isProtectedFolderName(f.name));
    if (locked.length) {
      win.alert(`系统文件夹不可合并：${locked.map((f) => f.name).join("、")}`);
      return;
    }
    const newName = await promptForFolderName(ctx, "合并后的新文件夹名称", "");
    if (newName == null) return;
    if (!newName) {
      win.alert("合并后的文件夹名称不能为空");
      return;
    }
    try {
      const newFolder = await mergeReviewFolders(ids, newName);
      await trackReviewEvent("folder_merge", {
        timestamp: new Date().toISOString(),
        folder_count: ids.length,
        new_folder_name: newFolder.name,
      });
      applyFocusedFolderState(ctx, newFolder.id);
      await refreshAndRender(ctx);
      showManagerToast(`已合并为文件夹“${newFolder.name}”`);
    } catch (e: any) {
      win.alert(`合并文件夹失败：${e?.message || e}`);
    }
  });

  btnFolderSummary.addEventListener("click", async () => {
    const targetFolder = resolveFolderForSummary(ctx);
    if (!targetFolder) {
      win.alert("请先在左侧点击一个文件夹，再执行“合并综述”");
      return;
    }
    let progress: any = null;
    try {
      const allRows = await listReviewRecords({
        folderID: targetFolder.id,
        recordType: "literature",
        sortKey: "updatedAt",
        sortDir: "desc",
      });
      if (!allRows.length) {
        win.alert(`文件夹“${targetFolder.name}”下暂无记录`);
        return;
      }

      progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
        closeTime: -1,
      })
        .createLine({
          text: `正在合并综述：${targetFolder.name}`,
          type: "default",
          progress: 0,
        })
        .show();

      const onProgress = (update: ReviewExtractionProgress) => {
        try {
          progress.changeLine({
            text: `合并综述（${Math.max(0, Math.min(96, update.progress))}%）: ${targetFolder.name} · ${update.stage}`,
            progress: Math.max(0, Math.min(96, update.progress)),
          });
        } catch {
          // ignore
        }
      };

      const result = await synthesizeFolderReview(targetFolder.name, allRows, {
        onProgress,
      });
      const savedSummary = await createFolderSummaryRecord({
        folderID: targetFolder.id,
        folderName: targetFolder.name,
        summaryText: result.text,
        sourceRows: allRows.map((row) => ({
          id: row.id,
          zoteroItemID: row.zoteroItemID,
        })),
        aiProvider: result.provider,
        aiModel: result.model,
      });
      progress.changeLine({
        text: `合并综述完成：${targetFolder.name}`,
        type: "success",
        progress: 100,
      });
      progress.startCloseTimer(1500);
      await trackReviewEvent("folder_summary_success", {
        timestamp: new Date().toISOString(),
        folder_name: targetFolder.name,
        record_count: allRows.length,
        summary_record_id: savedSummary.id,
        model_type: `${result.provider}:${result.model}`,
      }).catch((e) => ztoolkit.log(e));
      await refreshAndRender(ctx);
      await openFolderSummaryDialog(
        targetFolder.name,
        result.text,
        allRows.length,
      );
    } catch (e) {
      const message = getReviewErrorMessage(e);
      try {
        progress?.changeLine({
          text: `合并综述失败：${message}`,
          type: "error",
          progress: 100,
        });
        progress?.startCloseTimer?.(4000);
      } catch {
        // ignore
      }
      await trackReviewEvent("folder_summary_fail", {
        timestamp: new Date().toISOString(),
        folder_name: targetFolder.name,
        fail_reason: message,
      }).catch((err) => ztoolkit.log(err));
      win.alert(`合并综述失败：${message}`);
    }
  });

  btnMoveSelected.addEventListener("click", async () => {
    const recordIDs = Array.from(ctx.state.selectedRecordIDs);
    if (!recordIDs.length) {
      win.alert("请先在表格中勾选记录");
      return;
    }
    const targetFolderID = resolveMoveTargetFolderID(ctx);
    if (!targetFolderID) {
      win.alert("请先在左侧点击一个目标文件夹（不能是“我的记录”）");
      return;
    }
    try {
      ctx.state.moveTargetFolderID = targetFolderID;
      const targetFolderName =
        ctx.state.folders.find((folder) => folder.id === targetFolderID)
          ?.name || "目标文件夹";
      const hiddenByFilter =
        ctx.state.folderFilterID != null &&
        ctx.state.folderFilterID !== targetFolderID;
      await assignReviewRecordsFolder(recordIDs, targetFolderID);
      await refreshAndRender(ctx);
      showManagerToast(
        hiddenByFilter
          ? `已将 ${recordIDs.length} 条记录加入“${targetFolderName}”。当前筛选条件下它们可能暂时不可见。`
          : `已将 ${recordIDs.length} 条记录加入“${targetFolderName}”`,
      );
    } catch (e: any) {
      win.alert(`加入文件夹失败：${e?.message || e}`);
    }
  });

  btnRemoveSelected.addEventListener("click", async () => {
    const recordIDs = Array.from(ctx.state.selectedRecordIDs);
    if (!recordIDs.length) {
      win.alert("请先在表格中勾选记录");
      return;
    }
    const sourceFolder = resolveFolderForRecordRemoval(ctx);
    if (!sourceFolder) {
      win.alert("请先在左侧点击一个要移出的文件夹（不能是“我的记录”）");
      return;
    }
    if (isProtectedFolderName(sourceFolder.name)) {
      win.alert("“未分类”为系统目录，不能直接移出。请先加入其它文件夹。");
      return;
    }

    const effectiveRows = ctx.state.rows.filter(
      (row) =>
        ctx.state.selectedRecordIDs.has(row.id) &&
        Array.isArray(row.folderIDs) &&
        row.folderIDs.includes(sourceFolder.id),
    );
    if (!effectiveRows.length) {
      win.alert(`所选记录不在“${sourceFolder.name}”中`);
      return;
    }

    try {
      await removeReviewRecordsFromFolder(
        effectiveRows.map((row) => row.id),
        sourceFolder.id,
      );
      await refreshAndRender(ctx);
      const hiddenByFilter = ctx.state.folderFilterID === sourceFolder.id;
      showManagerToast(
        hiddenByFilter
          ? `已将 ${effectiveRows.length} 条记录从“${sourceFolder.name}”移出。当前筛选条件下它们可能暂时不可见。`
          : `已将 ${effectiveRows.length} 条记录从“${sourceFolder.name}”移出`,
      );
    } catch (e: any) {
      win.alert(`移出文件夹失败：${e?.message || e}`);
    }
  });

  btnDeleteSelected.addEventListener("click", async () => {
    const recordIDs = Array.from(ctx.state.selectedRecordIDs);
    if (!recordIDs.length) {
      win.alert("请先在表格中勾选记录");
      return;
    }
    if (
      !win.confirm(
        `确认彻底删除所选 ${recordIDs.length} 条记录？该操作不可恢复。`,
      )
    ) {
      return;
    }
    try {
      const deletedCount = await deleteReviewRecords(recordIDs);
      await trackReviewEvent("record_delete", {
        timestamp: new Date().toISOString(),
        record_count: deletedCount,
        view_mode: ctx.state.viewMode,
      }).catch((e) => ztoolkit.log(e));
      ctx.state.selectedRecordIDs.clear();
      ctx.state.selectionAnchorRecordID = null;
      await refreshAndRender(ctx);
      showManagerToast(`已删除 ${deletedCount} 条记录`);
    } catch (e: any) {
      win.alert(`删除记录失败：${e?.message || e}`);
    }
  });

  btnSelectAll.addEventListener("click", () => {
    ctx.state.selectedRecordIDs = new Set(ctx.state.rows.map((row) => row.id));
    ctx.state.selectionAnchorRecordID = ctx.state.rows[0]?.id ?? null;
    renderManager(ctx);
  });

  btnClearSelection.addEventListener("click", () => {
    ctx.state.selectedRecordIDs.clear();
    ctx.state.selectionAnchorRecordID = null;
    renderManager(ctx);
  });

  btnPreviewRaw.addEventListener("click", async () => {
    const row = getPrimarySelectedRow(ctx);
    if (!row) {
      win.alert("请先选择一条记录");
      return;
    }
    const detail = await getReviewRecordByID(row.id);
    if (!detail) {
      win.alert("记录不存在，可能已被删除");
      return;
    }
    await openRawRecordEditorDialog(ctx, detail);
  });

  btnCreateNote.addEventListener("click", async () => {
    if (ctx.state.viewMode !== "literature") {
      win.alert("当前视图为合并综述，仅支持文献记录生成原生笔记");
      return;
    }

    const selectedRows = getSelectedRows(ctx).filter(
      (row) => row.recordType !== "folderSummary",
    );
    if (!selectedRows.length) {
      win.alert("请先在表格中勾选至少一条文献记录");
      return;
    }

    const generatedAt = new Date();
    const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
      closeTime: -1,
    })
      .createLine({
        text: `正在创建原生笔记（共 ${selectedRows.length} 条）`,
        type: "default",
        progress: 0,
      })
      .show();

    const results: Array<{
      title: string;
      ok: boolean;
      error?: string;
    }> = [];

    for (let index = 0; index < selectedRows.length; index += 1) {
      const row = selectedRows[index];
      progress.changeLine({
        text: `(${index + 1}/${selectedRows.length}) 正在创建笔记: ${truncate(row.title || `记录 ${row.id}`, 32)}`,
        progress: Math.floor((index / selectedRows.length) * 100),
      });

      try {
        const detail = await getReviewRecordByID(row.id);
        if (!detail) {
          throw new Error("记录不存在，可能已被删除");
        }
        await createNativeNoteForReviewRecord(detail, { generatedAt });
        results.push({
          title: detail.title || `记录 ${detail.id}`,
          ok: true,
        });
      } catch (e: any) {
        results.push({
          title: row.title || `记录 ${row.id}`,
          ok: false,
          error: e?.message || String(e),
        });
      }
    }

    const successCount = results.filter((result) => result.ok).length;
    const failCount = results.length - successCount;
    progress.changeLine({
      text: `原生笔记创建完成：成功 ${successCount}，失败 ${failCount}`,
      type: failCount ? "default" : "success",
      progress: 100,
    });
    progress.startCloseTimer(failCount ? 4500 : 1500);

    await trackReviewEvent("native_note_create", {
      timestamp: new Date().toISOString(),
      record_count: selectedRows.length,
      success_count: successCount,
      fail_count: failCount,
    }).catch((e) => ztoolkit.log(e));

    if (!failCount) {
      showManagerToast(`已在 ${successCount} 条 Zotero 文献下创建原生笔记`);
      return;
    }

    win.alert(
      [
        `原生笔记创建完成：成功 ${successCount} 条，失败 ${failCount} 条。`,
        "失败明细：",
        results
          .filter((result) => !result.ok)
          .map(
            (result) =>
              `- ${truncate(result.title, 36)}: ${result.error || "未知错误"}`,
          )
          .join("\n"),
      ].join("\n\n"),
    );
  });

  btnExport.addEventListener("click", async () => {
    try {
      const csv = await exportReviewRecordsAsCSV({
        folderID: ctx.state.folderFilterID,
        recordType: ctx.state.viewMode,
        search: ctx.state.search,
        sortKey: ctx.state.sortKey,
        sortDir: ctx.state.sortDir,
      });
      const path = await new ztoolkit.FilePicker(
        "导出表格",
        "save",
        [["CSV 文件 (*.csv)", "*.csv"]],
        `literature-review-${Date.now()}.csv`,
      ).open();
      if (!path) return;
      const normalizedPath = String(path).endsWith(".csv")
        ? String(path)
        : `${path}.csv`;
      await writeTextFile(normalizedPath, csv);
      await trackReviewEvent("excel_export", {
        timestamp: new Date().toISOString(),
        record_count: ctx.state.rows.length,
      });
      win.alert(`已导出：${normalizedPath}`);
    } catch (e: any) {
      win.alert(`导出失败：${e?.message || e}`);
    }
  });
}

function renderManager(ctx: ManagerContext) {
  const refs = ctx.refs;
  if (!refs) return;
  const { state } = ctx;
  const columns = getCurrentTableColumns(ctx);

  refs.searchInput.value = state.search;
  syncViewButtonState(refs.viewLiteratureBtn, state.viewMode === "literature");
  syncViewButtonState(refs.viewSummaryBtn, state.viewMode === "folderSummary");
  refs.sortKeyBtn.textContent = `排序：${getSortKeyLabel(state.sortKey)}`;
  refs.sortDirBtn.textContent = state.sortDir === "desc" ? "降序" : "升序";
  const folderFilterLabel =
    state.folderFilterID == null
      ? "全部文件夹"
      : state.folders.find((f) => f.id === state.folderFilterID)?.name ||
        "已选文件夹";
  refs.filterStatusText.textContent = `筛选：${folderFilterLabel}`;

  renderFolderButtons(ctx);
  syncActionButtons(ctx);

  refs.statusText.textContent = `${getViewModeLabel(state.viewMode)} · ${state.folders.length} 个文件夹 · 共 ${state.totalRows} 条`;
  refs.selectionText.textContent = state.selectedRecordIDs.size
    ? `已选 ${state.selectedRecordIDs.size} 条`
    : "未选择";

  syncTableSizing(ctx, columns);
  renderTableHeader(ctx, columns);
  renderTableBody(ctx, columns);
  renderPreview(ctx);
}

function renderFolderButtons(ctx: ManagerContext) {
  const refs = ctx.refs;
  if (!refs) return;
  const { state } = ctx;
  const doc = refs.folderList.ownerDocument!;
  const activeFolderKey =
    state.pendingFocusFolderKey ||
    getFolderFocusKeyFromElement(doc.activeElement as Element | null);
  refs.folderList.innerHTML = "";

  const hint = createEl(doc, "div", {
    text: "单击筛选；Ctrl/Cmd 可多选；双击或 F2 可重命名",
    style: {
      fontSize: "11px",
      color: "#64748b",
      lineHeight: "1.4",
      marginBottom: "2px",
    },
  });
  refs.folderList.appendChild(hint);

  const allBtn = createFolderButton(doc, {
    label: "我的记录",
    active: state.folderFilterID == null,
    selected: false,
    locked: true,
    focusKey: getFolderFocusKey(null),
    title: "显示全部文件夹记录",
    onClick: (ev) => {
      handleFolderButtonClick(ctx, null, "我的记录", ev);
    },
    onKeyDown: (ev) => {
      handleFolderButtonKeydown(ctx, null, ev);
    },
  });
  refs.folderList.appendChild(allBtn);

  for (const folder of state.folders) {
    const isReserved = folder.name === "未分类";
    const btn = createFolderButton(doc, {
      label: folder.name,
      active: state.folderFilterID === folder.id,
      selected: state.selectedFolderIDs.has(folder.id),
      locked: isReserved,
      focusKey: getFolderFocusKey(folder.id),
      title: isReserved
        ? `文件夹：${folder.name}`
        : `文件夹：${folder.name}。双击可重命名`,
      onClick: (ev) => {
        handleFolderButtonClick(ctx, folder.id, folder.name, ev);
      },
      onDoubleClick: isReserved
        ? undefined
        : (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void handleRenameFolderRequest(ctx, folder);
          },
      onKeyDown: (ev) => {
        handleFolderButtonKeydown(ctx, folder, ev);
      },
    });
    refs.folderList.appendChild(btn);
  }
  if (activeFolderKey) {
    scheduleFocusRestore(
      ctx,
      () => focusFolderButtonByKey(ctx, activeFolderKey),
      "folder",
    );
  }
  state.pendingFocusFolderKey = null;
}

function syncActionButtons(ctx: ManagerContext) {
  const refs = ctx.refs;
  if (!refs) return;

  const selectedFolders = getSelectedConcreteFolders(ctx);
  const singleFolder = selectedFolders.length === 1 ? selectedFolders[0] : null;
  const protectedSelected = selectedFolders.some((folder) =>
    isProtectedFolderName(folder.name),
  );
  const summaryFolder = resolveFolderForSummary(ctx);
  const removableFolder = resolveFolderForRecordRemoval(ctx);
  const primaryRow = getPrimarySelectedRow(ctx);
  const recordSelectionCount = ctx.state.selectedRecordIDs.size;

  setButtonEnabled(refs.btnCreateFolder, true, "创建一个新文件夹");
  setButtonEnabled(
    refs.btnRenameFolder,
    Boolean(resolveFolderForRename(ctx)),
    singleFolder
      ? "重命名当前选中的文件夹"
      : "请先在左侧只选中一个可重命名文件夹",
  );
  setButtonEnabled(
    refs.btnDeleteFolder,
    selectedFolders.length > 0 && !protectedSelected,
    protectedSelected
      ? "系统文件夹不能删除"
      : selectedFolders.length
        ? "删除当前选中的文件夹"
        : "请先在左侧选中文件夹",
  );
  setButtonEnabled(
    refs.btnMergeFolder,
    selectedFolders.length >= 2 && !protectedSelected,
    protectedSelected
      ? "系统文件夹不能参与合并"
      : selectedFolders.length >= 2
        ? "合并当前选中的文件夹"
        : "请至少选择两个文件夹",
  );
  setButtonEnabled(
    refs.btnFolderSummary,
    Boolean(summaryFolder),
    summaryFolder
      ? `对“${summaryFolder.name}”执行合并综述`
      : "请先在左侧选中一个文件夹",
  );
  setButtonEnabled(
    refs.btnMoveSelected,
    recordSelectionCount > 0 && Boolean(resolveMoveTargetFolderID(ctx)),
    recordSelectionCount
      ? resolveMoveTargetFolderID(ctx)
        ? "将选中记录加入目标文件夹"
        : "请先在左侧选择一个目标文件夹"
      : "请先在表格中勾选记录",
  );
  setButtonEnabled(
    refs.btnRemoveSelected,
    recordSelectionCount > 0 &&
      Boolean(removableFolder) &&
      !isProtectedFolderName(removableFolder?.name || ""),
    removableFolder
      ? `将选中记录从“${removableFolder.name}”移出`
      : "请先选中一个可移出的文件夹",
  );
  setButtonEnabled(
    refs.btnDeleteSelected,
    recordSelectionCount > 0,
    recordSelectionCount ? "删除当前勾选的记录" : "请先在表格中勾选记录",
  );
  setButtonEnabled(
    refs.btnSelectAll,
    ctx.state.rows.length > 0,
    ctx.state.rows.length ? "全选当前表格记录" : "当前没有可选记录",
  );
  setButtonEnabled(
    refs.btnClearSelection,
    recordSelectionCount > 0,
    recordSelectionCount ? "清空当前记录选择" : "当前没有已选记录",
  );
  setButtonEnabled(
    refs.btnPreviewRaw,
    Boolean(primaryRow),
    primaryRow ? "编辑当前记录内容" : "请先选择一条记录",
  );
  setButtonEnabled(
    refs.btnCreateNote,
    ctx.state.viewMode === "literature" && recordSelectionCount > 0,
    ctx.state.viewMode !== "literature"
      ? "仅文献记录视图支持生成原生笔记"
      : recordSelectionCount
        ? "为选中的文献记录创建 Zotero 原生笔记"
        : "请先在表格中勾选记录",
  );
  setButtonEnabled(
    refs.btnExport,
    ctx.state.rows.length > 0,
    ctx.state.rows.length ? "导出当前视图记录" : "当前没有可导出的记录",
  );
}

function handleFolderButtonClick(
  ctx: ManagerContext,
  folderID: number | null,
  _folderName: string,
  ev: MouseEvent,
) {
  ctx.state.pendingFocusFolderKey = getFolderFocusKey(folderID);
  const isAdditive = Boolean(ev.ctrlKey || ev.metaKey);
  const isVirtualAll = folderID == null;

  if (!isAdditive) {
    ctx.state.folderFilterID = folderID;
    if (isVirtualAll) {
      ctx.state.moveTargetFolderID = null;
      ctx.state.selectedFolderIDs.clear();
    } else {
      ctx.state.moveTargetFolderID = folderID;
      ctx.state.selectedFolderIDs = new Set([folderID]);
    }
    void refreshAndRender(ctx);
    return;
  }

  if (isVirtualAll) {
    ctx.state.folderFilterID = null;
    renderManager(ctx);
    return;
  }

  if (ctx.state.selectedFolderIDs.has(folderID)) {
    ctx.state.selectedFolderIDs.delete(folderID);
  } else {
    ctx.state.selectedFolderIDs.add(folderID);
  }

  syncMoveTargetFolder(ctx);
  renderManager(ctx);
}

function focusFolderButtonByKey(ctx: ManagerContext, focusKey: string) {
  const refs = ctx.refs;
  if (!refs) return;
  const btn = refs.folderList.querySelector(
    `button[data-folder-focus-key="${cssEscapeCompat(focusKey)}"]`,
  );
  if (isFocusableElement(btn)) {
    btn.focus();
  }
}

function handleFolderButtonKeydown(
  ctx: ManagerContext,
  folder: ReviewFolderRow | null,
  ev: KeyboardEvent,
) {
  switch (ev.key) {
    case "ArrowDown":
      ev.preventDefault();
      focusAdjacentFolderButton(ctx, ev.currentTarget as HTMLButtonElement, 1);
      return;
    case "ArrowUp":
      ev.preventDefault();
      focusAdjacentFolderButton(ctx, ev.currentTarget as HTMLButtonElement, -1);
      return;
    case "Home":
      ev.preventDefault();
      focusAdjacentFolderButton(
        ctx,
        ev.currentTarget as HTMLButtonElement,
        -999,
      );
      return;
    case "End":
      ev.preventDefault();
      focusAdjacentFolderButton(
        ctx,
        ev.currentTarget as HTMLButtonElement,
        999,
      );
      return;
    case "F2":
      if (folder && !isProtectedFolderName(folder.name)) {
        ev.preventDefault();
        void handleRenameFolderRequest(ctx, folder);
      }
      return;
    default:
      return;
  }
}

function focusAdjacentFolderButton(
  ctx: ManagerContext,
  current: HTMLButtonElement,
  step: number,
) {
  const buttons = getFolderNavButtons(ctx);
  if (!buttons.length) return;
  const currentIndex = buttons.indexOf(current);
  if (currentIndex < 0) {
    buttons[0]?.focus();
    return;
  }
  if (step <= -999) {
    buttons[0]?.focus();
    return;
  }
  if (step >= 999) {
    buttons[buttons.length - 1]?.focus();
    return;
  }
  const nextIndex = clampNumber(currentIndex + step, 0, buttons.length - 1);
  buttons[nextIndex]?.focus();
}

function getFolderNavButtons(ctx: ManagerContext) {
  const refs = ctx.refs;
  if (!refs) return [] as HTMLButtonElement[];
  return Array.from(
    refs.folderList.querySelectorAll("button[data-folder-nav='1']"),
  ) as HTMLButtonElement[];
}

function createFolderButton(
  doc: Document,
  options: {
    label: string;
    active: boolean;
    selected: boolean;
    locked: boolean;
    focusKey: string;
    onClick: (ev: MouseEvent) => void;
    onDoubleClick?: (ev: MouseEvent) => void;
    onKeyDown?: (ev: KeyboardEvent) => void;
    title?: string;
  },
) {
  const btn = createHTMLElement(doc, "button");
  btn.type = "button";
  btn.dataset.folderNav = "1";
  btn.dataset.folderFocusKey = options.focusKey;
  btn.title = options.title || "";
  btn.style.width = "100%";
  btn.style.textAlign = "left";
  btn.style.padding = "7px 9px";
  btn.style.borderRadius = "6px";
  btn.style.border = options.active ? "1px solid #3b82f6" : "1px solid #dbe3ef";
  btn.style.background = options.active
    ? "#eff6ff"
    : options.selected
      ? "#f1f5f9"
      : "#fff";
  btn.style.color = "#111827";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "12px";
  btn.style.fontWeight = options.active ? "600" : "500";
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "space-between";
  btn.style.gap = "6px";
  btn.style.transition = "background-color 120ms ease, border-color 120ms ease";

  const label = createHTMLElement(doc, "span");
  label.textContent = options.label;
  btn.appendChild(label);

  const badges: string[] = [];
  if (options.locked) badges.push("固定");
  if (options.selected) badges.push("已选");
  if (badges.length) {
    const badge = createHTMLElement(doc, "span");
    badge.textContent = badges.join(" · ");
    badge.style.fontSize = "10px";
    badge.style.color = options.active ? "#1d4ed8" : "#475569";
    badge.style.background = options.active ? "#dbeafe" : "#f1f5f9";
    badge.style.border = "1px solid #dbeafe";
    badge.style.borderRadius = "999px";
    badge.style.padding = "1px 6px";
    btn.appendChild(badge);
  }

  btn.addEventListener("click", options.onClick);
  if (options.onDoubleClick) {
    btn.addEventListener("dblclick", options.onDoubleClick);
  }
  if (options.onKeyDown) {
    btn.addEventListener("keydown", options.onKeyDown);
  }
  return btn;
}

function renderTableHeader(ctx: ManagerContext, columns: TableColumnSpec[]) {
  const refs = ctx.refs;
  if (!refs) return;
  const doc = refs.tableHeadRow.ownerDocument!;
  refs.tableHeadRow.innerHTML = "";
  columns.forEach((column, idx) => {
    const width = getTableColumnWidth(column);
    const th = createEl(doc, "th", {
      text: column.label,
      style: {
        position: "sticky",
        top: "0",
        zIndex: "1",
        background: "#f3f4f6",
        borderBottom: "1px solid #e2e8f0",
        textAlign: column.align || (idx === 0 ? "center" : "left"),
        padding: "6px 8px",
        whiteSpace: "nowrap",
        color: "#334155",
        fontWeight: "600",
        boxSizing: "border-box",
      },
    });
    th.style.width = `${width}px`;
    th.style.minWidth = `${width}px`;
    th.style.maxWidth = `${width}px`;
    refs.tableHeadRow.appendChild(th);
  });
}

function syncTableSizing(ctx: ManagerContext, columns: TableColumnSpec[]) {
  const refs = ctx.refs;
  if (!refs) return;
  const preferredWidth = getPreferredTableWidth(columns);
  if (ctx.state.viewMode === "literature") {
    const width = Math.max(DEFAULT_TABLE_MIN_WIDTH, preferredWidth);
    refs.table.style.width = `${width}px`;
    refs.table.style.minWidth = `${width}px`;
    refs.table.style.maxWidth = "none";
    refs.table.style.tableLayout = "fixed";
    return;
  }
  const width = Math.max(COMPACT_TABLE_MIN_WIDTH, preferredWidth);
  refs.table.style.width = `${width}px`;
  refs.table.style.minWidth = `${width}px`;
  refs.table.style.maxWidth = "none";
  refs.table.style.tableLayout = "fixed";
}

function getPreferredTableWidth(columns: TableColumnSpec[]) {
  return columns.reduce(
    (total, column) => total + getTableColumnWidth(column),
    0,
  );
}

function getTableColumnWidth(column: TableColumnSpec) {
  const fallback = column.key === "__select__" ? 64 : 220;
  const width = Number(column.maxWidth);
  if (!Number.isFinite(width) || width <= 0) {
    return fallback;
  }
  if (column.key === "__select__") {
    return Math.max(56, Math.floor(width));
  }
  return Math.max(96, Math.floor(width));
}

function getCurrentTableColumns(ctx: ManagerContext): TableColumnSpec[] {
  if (ctx.state.viewMode === "folderSummary") {
    return getFolderSummaryTableColumns();
  }
  return getLiteratureTableColumns();
}

function getLiteratureTableColumns(): TableColumnSpec[] {
  const orderedFields = [...FIXED_LITERATURE_TABLE_FIELDS];
  if (!orderedFields.includes("title")) {
    orderedFields.unshift("title");
  }

  const contentColumns = orderedFields
    .map((key) => buildLiteratureFieldColumn(key))
    .filter((col): col is TableColumnSpec => Boolean(col));

  contentColumns.push({
    key: "folder",
    label: "文件夹",
    maxWidth: 220,
    renderCell: (_ctx, row) => getRecordFolderLabel(row),
  });
  contentColumns.push({
    key: "updatedAt",
    label: "更新时间",
    maxWidth: 160,
    renderCell: (_ctx, row) => formatTime(row.updatedAt),
  });

  return [buildSelectionColumn(), ...contentColumns];
}

function getFolderSummaryTableColumns(): TableColumnSpec[] {
  return [
    buildSelectionColumn(),
    {
      key: "title",
      label: "标题",
      maxWidth: 420,
      renderCell: (_ctx, row) =>
        truncateAdaptive(row.title, 60, 420) || "(无标题)",
    },
    {
      key: "sourceRecordCount",
      label: "来源数",
      align: "center",
      maxWidth: 80,
      renderCell: (_ctx, row) => String((row.sourceRecordIDs || []).length),
    },
    {
      key: "folder",
      label: "文件夹",
      maxWidth: 220,
      renderCell: (_ctx, row) => getRecordFolderLabel(row),
    },
    {
      key: "updatedAt",
      label: "更新时间",
      maxWidth: 160,
      renderCell: (_ctx, row) => formatTime(row.updatedAt),
    },
  ];
}

function buildSelectionColumn(): TableColumnSpec {
  return {
    key: "__select__",
    label: "选中",
    align: "center",
    maxWidth: 64,
    renderCell: (ctx, row, rowIndex) => {
      const checkbox = createHTMLElement(
        ctx.refs!.tableBody.ownerDocument!,
        "input",
      );
      checkbox.type = "checkbox";
      checkbox.checked = ctx.state.selectedRecordIDs.has(row.id);
      checkbox.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        applyRecordSelectionByEvent(
          ctx,
          row.id,
          rowIndex,
          ev as MouseEvent,
          "checkbox",
        );
        renderManager(ctx);
      });
      return checkbox;
    },
  };
}

function buildLiteratureFieldColumn(
  fieldKey: ReviewPromptFieldKey,
): TableColumnSpec | null {
  switch (fieldKey) {
    case "title":
      return {
        key: "title",
        label: "标题",
        maxWidth: 420,
        renderCell: (ctx, row) => createRecordTitleCell(ctx, row),
      };
    case "authors":
      return {
        key: "authors",
        label: "作者",
        maxWidth: 220,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.authors, 48, 220),
      };
    case "journal":
      return {
        key: "journal",
        label: "期刊",
        maxWidth: 220,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.journal, 40, 220),
      };
    case "publicationDate":
      return {
        key: "publicationDate",
        label: "时间",
        maxWidth: 120,
        renderCell: (_ctx, row) => row.publicationDate || "",
      };
    case "abstract":
      return {
        key: "abstract",
        label: "摘要",
        maxWidth: 420,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.abstractText, 120, 420),
      };
    case "researchBackground":
      return {
        key: "researchBackground",
        label: "研究背景",
        maxWidth: 420,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.researchBackground, 120, 420),
      };
    case "literatureReview":
      return {
        key: "literatureReview",
        label: "文献综述",
        maxWidth: 420,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.literatureReview, 120, 420),
      };
    case "researchMethods":
      return {
        key: "researchMethods",
        label: "研究方法",
        maxWidth: 360,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.researchMethods, 110, 360),
      };
    case "researchConclusions":
      return {
        key: "researchConclusions",
        label: "研究结论",
        maxWidth: 360,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.researchConclusions, 110, 360),
      };
    case "keyFindings":
      return {
        key: "keyFindings",
        label: "关键发现",
        maxWidth: 360,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(
            ctx,
            (row.keyFindings || []).join("；"),
            110,
            360,
          ),
      };
    case "classificationTags":
      return {
        key: "classificationTags",
        label: "标签",
        maxWidth: 260,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(
            ctx,
            row.classificationTags.join(", "),
            72,
            260,
          ),
      };
    case "pdfAnnotationNotesText":
      return {
        key: "pdfAnnotationNotesText",
        label: "PDF批注",
        maxWidth: 360,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(
            ctx,
            String(row.pdfAnnotationNotesText || ""),
            110,
            360,
          ),
      };
    default:
      return null;
  }
}

function formatLiteratureCellText(
  _ctx: ManagerContext,
  text: string,
  limit: number,
  maxWidth: number,
) {
  return truncateAdaptive(text, limit, maxWidth);
}

function createRecordTitleCell(ctx: ManagerContext, row: ReviewRecordRow) {
  const doc = ctx.refs!.tableBody.ownerDocument!;
  const titleText = truncateAdaptive(row.title, 60, 420) || "(无标题)";
  if (row.recordType === "folderSummary") {
    return titleText;
  }
  const titleLink = createHTMLElement(doc, "a");
  titleLink.href = "#";
  titleLink.textContent = titleText;
  titleLink.title = row.title;
  titleLink.style.color = "#1d4ed8";
  titleLink.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    focusZoteroItem(row.zoteroItemID);
  });
  return titleLink;
}

function renderTableBody(ctx: ManagerContext, columns: TableColumnSpec[]) {
  const refs = ctx.refs;
  if (!refs) return;
  const { state } = ctx;
  const doc = refs.tableBody.ownerDocument!;

  refs.tableBody.innerHTML = "";

  if (!state.rows.length) {
    const tr = createHTMLElement(doc, "tr");
    const td = createHTMLElement(doc, "td");
    td.colSpan = Math.max(1, columns.length);
    td.textContent =
      state.viewMode === "folderSummary"
        ? "暂无合并综述记录。请先在左侧选择文件夹并执行“合并综述”。"
        : "暂无文献记录。请先右键条目执行 AI 提炼并保存结果。";
    td.style.padding = "12px";
    td.style.color = "#6b7280";
    tr.appendChild(td);
    refs.tableBody.appendChild(tr);
    return;
  }

  state.rows.forEach((row, rowIndex) => {
    const tr = createHTMLElement(doc, "tr");
    tr.dataset.recordId = String(row.id);
    tr.style.borderBottom = "1px solid #f1f5f9";
    const baseBackground = state.selectedRecordIDs.has(row.id)
      ? "#e8f1ff"
      : rowIndex % 2 === 0
        ? "#ffffff"
        : "#f8fafc";
    tr.style.background = baseBackground;
    tr.style.borderLeft = state.selectedRecordIDs.has(row.id)
      ? "2px solid #3b82f6"
      : "2px solid transparent";
    tr.style.transition = "background-color 120ms ease";

    columns.forEach((column) => {
      const applyLiteratureTextMode =
        ctx.state.viewMode === "literature" && column.key !== "__select__";
      const width = getTableColumnWidth(column);
      appendCell(tr, column.renderCell(ctx, row, rowIndex), {
        align: column.align || "left",
        width,
        maxWidth: column.maxWidth,
        nowrap: applyLiteratureTextMode ? true : undefined,
      });
    });

    tr.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      const tag = String(target?.tagName || "").toLowerCase();
      if (["input", "a", "button", "select", "textarea"].includes(tag)) return;
      applyRecordSelectionByEvent(
        ctx,
        row.id,
        rowIndex,
        ev as MouseEvent,
        "row",
      );
      renderManager(ctx);
    });

    tr.addEventListener("mouseenter", () => {
      if (!ctx.state.selectedRecordIDs.has(row.id)) {
        tr.style.background = "#eef4ff";
      }
    });

    tr.addEventListener("mouseleave", () => {
      const selected = ctx.state.selectedRecordIDs.has(row.id);
      tr.style.background = selected
        ? "#e8f1ff"
        : rowIndex % 2 === 0
          ? "#ffffff"
          : "#f8fafc";
      tr.style.borderLeft = selected
        ? "2px solid #3b82f6"
        : "2px solid transparent";
    });

    refs.tableBody.appendChild(tr);
  });
}

function renderPreview(ctx: ManagerContext) {
  const refs = ctx.refs;
  if (!refs) return;
  const row = getPrimarySelectedRow(ctx);
  if (!row) {
    refs.preview.value = "请从表格中选择一条记录查看详细内容。";
    return;
  }

  refs.preview.value = [
    `类型: ${getRecordTypeLabel(row.recordType)}`,
    `标题: ${row.title}`,
    `作者: ${row.authors}`,
    `期刊: ${row.journal}`,
    `发布时间: ${row.publicationDate}`,
    `文件夹: ${getRecordFolderLabel(row)}`,
    `标签: ${row.classificationTags.join(", ")}`,
    "",
    "摘要:",
    row.abstractText || "",
    "",
    "研究背景:",
    row.researchBackground || "",
    "",
    "文献综述:",
    row.literatureReview || "",
    "",
    "研究方法:",
    row.researchMethods || "",
    "",
    "研究结论:",
    row.researchConclusions || "",
    "",
    "关键发现:",
    ...(row.keyFindings.length
      ? row.keyFindings.map((v, i) => `${i + 1}. ${v}`)
      : ["（无）"]),
    "",
    "来源文献记录ID:",
    (row.sourceRecordIDs || []).length
      ? row.sourceRecordIDs.join(", ")
      : "（无）",
    "来源文献条目ID:",
    (row.sourceZoteroItemIDs || []).length
      ? row.sourceZoteroItemIDs.join(", ")
      : "（无）",
    "",
    "PDF批注与笔记:",
    String(row.pdfAnnotationNotesText || "").trim() || "（无）",
  ].join("\n");
}

function getPrimarySelectedRow(ctx: ManagerContext) {
  for (const row of ctx.state.rows) {
    if (ctx.state.selectedRecordIDs.has(row.id)) {
      return row;
    }
  }
  return null;
}

function getSelectedRows(ctx: ManagerContext) {
  return ctx.state.rows.filter((row) =>
    ctx.state.selectedRecordIDs.has(row.id),
  );
}

function getSelectedConcreteFolders(ctx: ManagerContext) {
  return Array.from(ctx.state.selectedFolderIDs)
    .map((id) => ctx.state.folders.find((folder) => folder.id === id))
    .filter((folder): folder is ReviewFolderRow => Boolean(folder));
}

function formatSelectionSummary(ctx: ManagerContext) {
  const folderCount = getSelectedConcreteFolders(ctx).length;
  const recordCount = ctx.state.selectedRecordIDs.size;
  if (!folderCount && !recordCount) return "未选择";
  const parts: string[] = [];
  if (folderCount) {
    parts.push(`文件夹 ${folderCount}`);
  }
  if (recordCount) {
    parts.push(`记录 ${recordCount}`);
  }
  return `已选 ${parts.join(" · ")}`;
}

function applyFocusedFolderState(ctx: ManagerContext, folderID: number | null) {
  ctx.state.pendingFocusFolderKey = getFolderFocusKey(folderID);
  ctx.state.folderFilterID = folderID;
  if (folderID == null) {
    ctx.state.selectedFolderIDs.clear();
    ctx.state.moveTargetFolderID = null;
    return;
  }
  ctx.state.selectedFolderIDs = new Set([folderID]);
  ctx.state.moveTargetFolderID = folderID;
}

function syncMoveTargetFolder(ctx: ManagerContext) {
  const selected = Array.from(ctx.state.selectedFolderIDs).filter(Boolean);
  if (selected.length === 1) {
    ctx.state.moveTargetFolderID = selected[0];
    return;
  }
  if (selected.length > 1) {
    if (
      ctx.state.moveTargetFolderID == null ||
      !selected.includes(ctx.state.moveTargetFolderID)
    ) {
      ctx.state.moveTargetFolderID = selected[0] || null;
    }
    return;
  }
  ctx.state.moveTargetFolderID = ctx.state.folderFilterID;
}

function getFolderFocusKey(folderID: number | null) {
  return folderID == null ? "__all__" : String(folderID);
}

function getFolderFocusKeyFromElement(el: Element | null) {
  const button = closestElement(
    el,
    "button[data-folder-focus-key]",
  ) as HTMLButtonElement | null;
  return button?.dataset.folderFocusKey || null;
}

function scheduleFocusRestore(
  ctx: ManagerContext,
  restore: () => void,
  kind: "folder" | "record",
) {
  const win = (ctx.helper?.window || getTargetMainWindow()) as Window | null;
  if (!win) return;
  scheduleWindowTask(win, 0, () => {
    const active = win.document?.activeElement as Element | null;
    if (kind === "folder" && isTextEntryElement(active)) return;
    if (kind === "record" && isTextEntryElement(active)) return;
    restore();
  });
}

function isTextEntryElement(el: Element | null) {
  if (!isElementLike(el)) return false;
  const tag = String((el as Element).tagName || "").toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    Boolean((el as any).isContentEditable) ||
    (typeof (el as any).getAttribute === "function" &&
      (el as any).getAttribute("role") === "textbox")
  );
}

function isElementLike(value: unknown): value is Element {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as any).nodeType === "number" &&
    typeof (value as any).tagName === "string",
  );
}

function closestElement(el: Element | null, selector: string) {
  if (!isElementLike(el)) return null;
  const closest = (el as any).closest;
  if (typeof closest !== "function") return null;
  try {
    return (closest.call(el, selector) as Element | null) || null;
  } catch {
    return null;
  }
}

function isFocusableElement(value: unknown): value is {
  focus: () => void;
} {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as any).focus === "function",
  );
}

function resolveFolderForRename(ctx: ManagerContext): ReviewFolderRow | null {
  const selectedFolders = getSelectedConcreteFolders(ctx);
  if (selectedFolders.length !== 1) return null;
  const target = selectedFolders[0];
  return isProtectedFolderName(target.name) ? null : target;
}

async function handleRenameFolderRequest(
  ctx: ManagerContext,
  folder: ReviewFolderRow | null,
) {
  const win = (ctx.helper?.window || getTargetMainWindow()) as Window | null;
  if (!folder) {
    win?.alert?.("请先在左侧只选中一个可重命名文件夹");
    return;
  }
  const nextName = await promptForFolderName(
    ctx,
    "请输入新的文件夹名称",
    folder.name,
  );
  if (nextName == null) return;
  if (!nextName) {
    win?.alert?.("文件夹名称不能为空");
    return;
  }
  try {
    const renamed = await renameReviewFolder(folder.id, nextName);
    applyFocusedFolderState(ctx, renamed.id);
    await trackReviewEvent("folder_rename", {
      timestamp: new Date().toISOString(),
      folder_id: renamed.id,
      old_folder_name: folder.name,
      new_folder_name: renamed.name,
    });
    await refreshAndRender(ctx);
    showManagerToast(`已将文件夹重命名为“${renamed.name}”`);
  } catch (e: any) {
    win?.alert?.(`重命名文件夹失败：${e?.message || e}`);
  }
}

function resolveMoveTargetFolderID(ctx: ManagerContext) {
  if (
    ctx.state.moveTargetFolderID &&
    Number.isFinite(ctx.state.moveTargetFolderID)
  ) {
    return ctx.state.moveTargetFolderID;
  }
  const fromLeftSelection = Array.from(ctx.state.selectedFolderIDs).filter(
    Boolean,
  );
  if (fromLeftSelection.length === 1) {
    return fromLeftSelection[0];
  }
  return null;
}

function resolveFolderForSummary(ctx: ManagerContext): ReviewFolderRow | null {
  if (ctx.state.folderFilterID != null) {
    return (
      ctx.state.folders.find((f) => f.id === ctx.state.folderFilterID) || null
    );
  }
  const selected = Array.from(ctx.state.selectedFolderIDs);
  if (selected.length === 1) {
    return ctx.state.folders.find((f) => f.id === selected[0]) || null;
  }
  return null;
}

function resolveFolderForRecordRemoval(
  ctx: ManagerContext,
): ReviewFolderRow | null {
  if (ctx.state.folderFilterID != null) {
    return (
      ctx.state.folders.find((f) => f.id === ctx.state.folderFilterID) || null
    );
  }
  const selected = Array.from(ctx.state.selectedFolderIDs);
  if (selected.length === 1) {
    return ctx.state.folders.find((f) => f.id === selected[0]) || null;
  }
  return null;
}

function cycleSortKey(
  current: ManagerState["sortKey"],
): ManagerState["sortKey"] {
  const order: ManagerState["sortKey"][] = [
    "updatedAt",
    "publicationDate",
    "title",
    "journal",
  ];
  const index = order.indexOf(current);
  if (index < 0) return order[0];
  return order[(index + 1) % order.length];
}

function switchManagerView(
  ctx: ManagerContext,
  nextViewMode: ManagerState["viewMode"],
) {
  if (ctx.state.viewMode === nextViewMode) return;
  ctx.state.viewMode = nextViewMode;
  ctx.state.selectedRecordIDs.clear();
  ctx.state.selectionAnchorRecordID = null;
  void refreshAndRender(ctx);
}

function syncViewButtonState(btn: HTMLButtonElement, active: boolean) {
  btn.dataset.active = active ? "1" : "0";
  btn.style.background = active ? "#eff6ff" : "#fff";
  btn.style.color = active ? "#1d4ed8" : "#111827";
  btn.style.fontWeight = active ? "600" : "400";
}

function getViewModeLabel(viewMode: ManagerState["viewMode"]) {
  return viewMode === "folderSummary" ? "合并综述" : "文献记录";
}

function getSortKeyLabel(sortKey: ManagerState["sortKey"]) {
  switch (sortKey) {
    case "title":
      return "标题";
    case "publicationDate":
      return "发表时间";
    case "journal":
      return "期刊";
    case "updatedAt":
    default:
      return "更新时间";
  }
}

function getRecordTypeLabel(recordType: ReviewRecordRow["recordType"]) {
  return recordType === "folderSummary" ? "合并综述" : "文献记录";
}

function isProtectedFolderName(name: string) {
  return String(name || "").trim() === "未分类";
}

function getRecordFolderLabel(
  row: Pick<ReviewRecordRow, "folderNames" | "folderName">,
) {
  if (Array.isArray(row.folderNames) && row.folderNames.length) {
    return row.folderNames.join("、");
  }
  return row.folderName || "未分类";
}

async function openRawRecordEditorDialog(
  ctx: ManagerContext,
  row: ReviewRecordRow,
) {
  if (row.recordType !== "folderSummary") {
    await openLiteratureRecordEditorDialog(ctx, row);
    return;
  }

  const prettyRaw = tryPrettyJSON(
    row.rawAIResponse || row.literatureReview || "",
  );
  const dialogData: Record<string, any> = {
    rawText: prettyRaw,
    loadCallback: () => {
      try {
        helper?.window?.document?.documentElement?.setAttribute("width", "900");
        helper?.window?.document?.documentElement?.setAttribute(
          "height",
          "700",
        );
      } catch {
        // ignore
      }
    },
  };

  const dialog = new ztoolkit.Dialog(4, 2)
    .addCell(0, 0, {
      tag: "h2",
      properties: { innerHTML: "合并综述记录（可编辑）" },
      styles: { margin: "0", fontSize: "16px" },
    })
    .addCell(
      0,
      1,
      {
        tag: "div",
        namespace: "html",
        properties: {
          innerHTML: `${truncate(row.title, 28)} · ${getRecordFolderLabel(row)}`,
        },
        styles: {
          fontSize: "12px",
          color: "#475569",
          textAlign: "right",
          paddingTop: "4px",
        },
      },
      false,
    )
    .addCell(1, 0, {
      tag: "label",
      namespace: "html",
      properties: { innerHTML: "内容" },
      styles: { fontSize: "12px", paddingTop: "6px", verticalAlign: "top" },
    })
    .addCell(
      1,
      1,
      {
        tag: "textarea",
        namespace: "html",
        attributes: {
          rows: "26",
          "data-bind": "rawText",
          "data-prop": "value",
        },
        styles: {
          width: "100%",
          minWidth: "760px",
          boxSizing: "border-box",
          fontSize: "12px",
          lineHeight: "1.45",
          resize: "vertical",
          padding: "8px",
        },
      },
      false,
    );

  const helper = dialog
    .addButton("保存", "save")
    .addButton("取消", "cancel")
    .setDialogData(dialogData)
    .open(`编辑记录 - ${truncate(row.title, 24)}`);

  if (!dialogData.unloadLock?.promise) {
    focusManagerContext(ctx);
    return;
  }
  await dialogData.unloadLock.promise.catch(() => undefined);
  focusManagerContext(ctx);
  if (dialogData._lastButtonId !== "save") return;

  const nextRaw = String(dialogData.rawText || "");
  await updateReviewRecordRawResponse(row.id, nextRaw);
  await refreshAndRender(ctx);
  showManagerToast("记录已保存");
}

async function openLiteratureRecordEditorDialog(
  ctx: ManagerContext,
  row: ReviewRecordRow,
) {
  const dialogData: Record<string, any> = {
    title: row.title || "",
    authors: row.authors || "",
    journal: row.journal || "",
    publicationDate: row.publicationDate || "",
    abstractText: row.abstractText || "",
    researchBackground: row.researchBackground || "",
    literatureReview: row.literatureReview || "",
    researchMethods: row.researchMethods || "",
    researchConclusions: row.researchConclusions || "",
    keyFindingsText: formatEditorListText(row.keyFindings || []),
    classificationTagsText: formatEditorListText(row.classificationTags || []),
    pdfAnnotationNotesText: row.pdfAnnotationNotesText || "",
    loadCallback: () => {
      try {
        helper?.window?.document?.documentElement?.setAttribute("width", "980");
        helper?.window?.document?.documentElement?.setAttribute(
          "height",
          "820",
        );
      } catch {
        // ignore
      }
      const dialogWin = helper?.window as Window | null;
      const titleInput = dialogWin?.document?.getElementById(
        "review-record-edit-title",
      ) as HTMLInputElement | null;
      if (!dialogWin || !titleInput) return;
      scheduleWindowTask(dialogWin, 0, () => {
        try {
          titleInput.focus();
          titleInput.select();
        } catch {
          // ignore
        }
      });
    },
  };

  const labelStyles = {
    fontSize: "12px",
    paddingTop: "6px",
    verticalAlign: "top",
    color: "#334155",
  };
  const inputStyles = {
    width: "100%",
    minWidth: "820px",
    boxSizing: "border-box",
    fontSize: "12px",
    lineHeight: "1.4",
    padding: "6px 8px",
  };
  const textareaStyles = {
    ...inputStyles,
    resize: "vertical",
    lineHeight: "1.5",
  };
  const fields: Array<{
    key: string;
    label: string;
    tag: "input" | "textarea";
    rows?: string;
    id?: string;
    placeholder?: string;
  }> = [
    {
      key: "title",
      label: "标题",
      tag: "input",
      id: "review-record-edit-title",
    },
    { key: "authors", label: "作者", tag: "input" },
    { key: "journal", label: "期刊", tag: "input" },
    { key: "publicationDate", label: "发布时间", tag: "input" },
    { key: "abstractText", label: "摘要", tag: "textarea", rows: "4" },
    {
      key: "researchBackground",
      label: "研究背景",
      tag: "textarea",
      rows: "5",
    },
    {
      key: "literatureReview",
      label: "文献综述",
      tag: "textarea",
      rows: "6",
    },
    {
      key: "researchMethods",
      label: "研究方法",
      tag: "textarea",
      rows: "4",
    },
    {
      key: "researchConclusions",
      label: "研究结论",
      tag: "textarea",
      rows: "4",
    },
    {
      key: "keyFindingsText",
      label: "关键发现",
      tag: "textarea",
      rows: "6",
      placeholder: "每行一条关键发现",
    },
    {
      key: "pdfAnnotationNotesText",
      label: "PDF批注与笔记",
      tag: "textarea",
      rows: "4",
    },
    {
      key: "classificationTagsText",
      label: "标签",
      tag: "textarea",
      rows: "3",
      placeholder: "每行一个标签，或使用逗号分隔",
    },
  ];

  const dialog = new ztoolkit.Dialog(fields.length + 1, 2)
    .addCell(0, 0, {
      tag: "h2",
      properties: { innerHTML: "文献记录（可编辑）" },
      styles: { margin: "0", fontSize: "16px" },
    })
    .addCell(
      0,
      1,
      {
        tag: "div",
        namespace: "html",
        properties: {
          innerHTML: `${truncate(row.title, 28)} · ${getRecordFolderLabel(row)}`,
        },
        styles: {
          fontSize: "12px",
          color: "#475569",
          textAlign: "right",
          paddingTop: "4px",
        },
      },
      false,
    );

  fields.forEach((field, index) => {
    const rowIndex = index + 1;
    dialog.addCell(rowIndex, 0, {
      tag: "label",
      namespace: "html",
      attributes: field.id ? { for: field.id } : {},
      properties: { innerHTML: field.label },
      styles: labelStyles,
    });
    dialog.addCell(
      rowIndex,
      1,
      {
        tag: field.tag,
        namespace: "html",
        id: field.id,
        attributes: {
          ...(field.tag === "input" ? { type: "text" } : {}),
          ...(field.rows ? { rows: field.rows } : {}),
          ...(field.placeholder ? { placeholder: field.placeholder } : {}),
          "data-bind": field.key,
          "data-prop": "value",
        },
        styles: field.tag === "input" ? inputStyles : textareaStyles,
      },
      false,
    );
  });

  const helper = dialog
    .addButton("保存", "save")
    .addButton("取消", "cancel")
    .setDialogData(dialogData)
    .open(`编辑记录 - ${truncate(row.title, 24)}`);

  if (!dialogData.unloadLock?.promise) {
    focusManagerContext(ctx);
    return;
  }

  await dialogData.unloadLock.promise.catch(() => undefined);
  focusManagerContext(ctx);
  if (dialogData._lastButtonId !== "save") return;

  await updateLiteratureReviewRecord(row.id, {
    title: String(dialogData.title || ""),
    authors: String(dialogData.authors || ""),
    journal: String(dialogData.journal || ""),
    publicationDate: String(dialogData.publicationDate || ""),
    abstractText: String(dialogData.abstractText || ""),
    pdfAnnotationNotesText: String(dialogData.pdfAnnotationNotesText || ""),
    researchBackground: String(dialogData.researchBackground || ""),
    literatureReview: String(dialogData.literatureReview || ""),
    researchMethods: String(dialogData.researchMethods || ""),
    researchConclusions: String(dialogData.researchConclusions || ""),
    keyFindings: parseEditorLineList(String(dialogData.keyFindingsText || "")),
    classificationTags: parseEditorTagList(
      String(dialogData.classificationTagsText || ""),
    ),
  });
  await refreshAndRender(ctx);
  showManagerToast("记录已保存");
}

async function openFolderSummaryDialog(
  folderName: string,
  summaryText: string,
  recordCount: number,
) {
  const dialogData: Record<string, any> = {
    summaryText: String(summaryText || "").trim(),
    loadCallback: () => {
      try {
        helper?.window?.document?.documentElement?.setAttribute("width", "920");
        helper?.window?.document?.documentElement?.setAttribute(
          "height",
          "760",
        );
      } catch {
        // ignore
      }
    },
  };

  const dialog = new ztoolkit.Dialog(4, 2)
    .addCell(0, 0, {
      tag: "h2",
      properties: { innerHTML: "文件夹合并综述结果" },
      styles: { margin: "0", fontSize: "16px" },
    })
    .addCell(
      0,
      1,
      {
        tag: "div",
        namespace: "html",
        properties: { innerHTML: `${folderName} · ${recordCount} 条记录` },
        styles: {
          fontSize: "12px",
          color: "#475569",
          textAlign: "right",
          paddingTop: "4px",
        },
      },
      false,
    )
    .addCell(1, 0, {
      tag: "label",
      namespace: "html",
      properties: { innerHTML: "综述内容" },
      styles: { fontSize: "12px", paddingTop: "6px", verticalAlign: "top" },
    })
    .addCell(
      1,
      1,
      {
        tag: "textarea",
        namespace: "html",
        attributes: {
          rows: "28",
          "data-bind": "summaryText",
          "data-prop": "value",
        },
        styles: {
          width: "100%",
          minWidth: "780px",
          boxSizing: "border-box",
          fontSize: "12px",
          lineHeight: "1.5",
          resize: "vertical",
          padding: "8px",
        },
      },
      false,
    );

  const helper = dialog
    .addButton("关闭", "close")
    .setDialogData(dialogData)
    .open(`合并综述 - ${truncate(folderName, 24)}`);

  if (dialogData.unloadLock?.promise) {
    await dialogData.unloadLock.promise.catch(() => undefined);
  }
}

function formatEditorListText(values: string[]) {
  return (values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function parseEditorLineList(text: string) {
  return String(text || "")
    .split(/\r?\n+/)
    .map((value) => value.replace(/^\s*(?:[-*•]\s*|\d+[.)]\s*)/, "").trim())
    .filter(Boolean);
}

function parseEditorTagList(text: string) {
  return String(text || "")
    .split(/[\r\n,，;；]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function tryPrettyJSON(text: string) {
  const raw = String(text || "");
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function applyRecordSelectionByEvent(
  ctx: ManagerContext,
  rowID: number,
  rowIndex: number,
  ev: MouseEvent,
  source: "row" | "checkbox",
) {
  const state = ctx.state;
  const isRange = Boolean(ev.shiftKey);
  const isAdditive = Boolean(ev.ctrlKey || ev.metaKey);

  if (isRange) {
    const anchorID = state.selectionAnchorRecordID ?? rowID;
    const anchorIndex = state.rows.findIndex((row) => row.id === anchorID);
    const start = Math.min(anchorIndex >= 0 ? anchorIndex : rowIndex, rowIndex);
    const end = Math.max(anchorIndex >= 0 ? anchorIndex : rowIndex, rowIndex);
    const rangeIDs = state.rows.slice(start, end + 1).map((row) => row.id);
    if (isAdditive) {
      for (const id of rangeIDs) state.selectedRecordIDs.add(id);
    } else {
      state.selectedRecordIDs = new Set(rangeIDs);
    }
    state.selectionAnchorRecordID = rowID;
    return;
  }

  if (source === "checkbox" || isAdditive) {
    if (state.selectedRecordIDs.has(rowID)) {
      state.selectedRecordIDs.delete(rowID);
    } else {
      state.selectedRecordIDs.add(rowID);
    }
    state.selectionAnchorRecordID = rowID;
    return;
  }

  state.selectedRecordIDs = new Set([rowID]);
  state.selectionAnchorRecordID = rowID;
}

function appendCell(
  tr: HTMLTableRowElement,
  content: string | Node,
  options: {
    align?: string;
    width?: number;
    maxWidth?: number;
    nowrap?: boolean;
  },
) {
  const td = createHTMLElement(tr.ownerDocument!, "td");
  td.style.padding = "6px 8px";
  td.style.verticalAlign = "top";
  td.style.textAlign = options.align || "left";
  const maxWidth = Math.max(56, Number(options.maxWidth) || 280);
  const fixedWidth = Math.max(
    56,
    Math.floor(Number(options.width) || maxWidth),
  );
  td.style.width = `${fixedWidth}px`;
  td.style.minWidth = `${fixedWidth}px`;
  td.style.boxSizing = "border-box";
  td.style.maxWidth = `${fixedWidth}px`;
  td.style.overflow = "hidden";
  td.style.textOverflow = "ellipsis";
  td.style.whiteSpace = options.nowrap === false ? "normal" : "nowrap";
  if (options.nowrap === false) {
    td.style.textOverflow = "clip";
  }
  if (typeof content === "string") {
    td.textContent = content;
  } else {
    td.appendChild(content);
  }
  tr.appendChild(td);
}

async function promptForFolderName(
  ctx: ManagerContext,
  message: string,
  defaultValue = "",
) {
  const dialogData: Record<string, any> = {
    folderName: String(defaultValue || ""),
    loadCallback: () => {
      try {
        helper?.window?.document?.documentElement?.setAttribute("width", "520");
        helper?.window?.document?.documentElement?.setAttribute(
          "height",
          "180",
        );
      } catch {
        // ignore
      }
      const dialogWin = helper?.window as Window | null;
      const input = dialogWin?.document?.getElementById(
        "review-folder-name-input",
      ) as HTMLInputElement | null;
      if (!dialogWin || !input) return;
      scheduleWindowTask(dialogWin, 0, () => {
        try {
          input.focus();
          input.select();
        } catch {
          // ignore
        }
      });
    },
  };

  const dialog = new ztoolkit.Dialog(2, 2)
    .addCell(0, 0, {
      tag: "label",
      namespace: "html",
      attributes: {
        for: "review-folder-name-input",
      },
      properties: { innerHTML: message },
      styles: {
        fontSize: "12px",
        paddingTop: "8px",
        color: "#334155",
        whiteSpace: "nowrap",
      },
    })
    .addCell(
      0,
      1,
      {
        tag: "input",
        namespace: "html",
        id: "review-folder-name-input",
        attributes: {
          type: "text",
          "data-bind": "folderName",
          "data-prop": "value",
          placeholder: "请输入文件夹名称",
        },
        styles: {
          width: "100%",
          minWidth: "320px",
          boxSizing: "border-box",
          fontSize: "13px",
          lineHeight: "1.4",
          padding: "6px 8px",
        },
      },
      false,
    )
    .addCell(1, 1, {
      tag: "div",
      namespace: "html",
      properties: {
        innerHTML: "输入名称后点击“确定”保存。",
      },
      styles: {
        fontSize: "11px",
        color: "#64748b",
        paddingTop: "4px",
      },
    });

  const helper = dialog
    .addButton("确定", "save")
    .addButton("取消", "cancel")
    .setDialogData(dialogData)
    .open("文件夹名称");

  if (!dialogData.unloadLock?.promise) {
    focusManagerContext(ctx);
    return null;
  }

  await dialogData.unloadLock.promise.catch(() => undefined);
  focusManagerContext(ctx);
  if (dialogData._lastButtonId !== "save") {
    return null;
  }
  return String(dialogData.folderName || "").trim();
}

function scheduleWindowTask(win: Window, delayMS: number, task: () => void) {
  try {
    win.setTimeout(() => {
      if ((win as any).closed) return;
      task();
    }, delayMS);
  } catch {
    task();
  }
}

function setButtonEnabled(
  btn: HTMLButtonElement,
  enabled: boolean,
  title?: string,
) {
  btn.disabled = !enabled;
  btn.title = title || "";
  if (btn.dataset.segmented === "1" || btn.dataset.active === "1") {
    btn.style.opacity = enabled ? "1" : "0.55";
    btn.style.cursor = enabled ? "pointer" : "not-allowed";
    return;
  }
  btn.style.opacity = enabled ? "1" : "0.55";
  btn.style.cursor = enabled ? "pointer" : "not-allowed";
  btn.style.background = enabled ? "#fff" : "#f8fafc";
  btn.style.borderColor = enabled ? "#cbd5e1" : "#e2e8f0";
  btn.style.color = enabled ? "#0f172a" : "#94a3b8";
}

function cssEscapeCompat(value: string) {
  const input = String(value || "");
  const escapeFn = (globalThis as any)?.CSS?.escape;
  if (typeof escapeFn === "function") {
    return escapeFn(input);
  }
  return input.replace(/["\\]/g, "\\$&");
}

function createButton(doc: Document, label: string) {
  const btn = createHTMLElement(doc, "button");
  btn.type = "button";
  btn.textContent = label;
  btn.dataset.active = "0";
  btn.style.height = "28px";
  btn.style.padding = "0 10px";
  btn.style.border = "1px solid #cbd5e1";
  btn.style.borderRadius = "6px";
  btn.style.background = "#fff";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "12px";
  btn.style.color = "#0f172a";
  btn.style.transition =
    "background-color 120ms ease, border-color 120ms ease, color 120ms ease";
  btn.addEventListener("mouseenter", () => {
    if (
      btn.disabled ||
      btn.dataset.segmented === "1" ||
      btn.dataset.active === "1"
    ) {
      return;
    }
    btn.style.background = "#f8fafc";
    btn.style.borderColor = "#94a3b8";
  });
  btn.addEventListener("mouseleave", () => {
    if (
      btn.disabled ||
      btn.dataset.segmented === "1" ||
      btn.dataset.active === "1"
    ) {
      return;
    }
    btn.style.background = "#fff";
    btn.style.borderColor = "#cbd5e1";
  });
  btn.addEventListener("focus", () => {
    if (btn.dataset.segmented === "1" || btn.dataset.active === "1") return;
    btn.style.borderColor = "#93c5fd";
  });
  btn.addEventListener("blur", () => {
    if (btn.dataset.segmented === "1" || btn.dataset.active === "1") return;
    btn.style.borderColor = "#cbd5e1";
  });
  return btn;
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  options: {
    text?: string;
    attrs?: Record<string, string>;
    style?: Partial<CSSStyleDeclaration>;
  } = {},
) {
  const el = createHTMLElement(doc, tag);
  if (options.text != null) el.textContent = options.text;
  if (options.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) {
      el.setAttribute(k, v);
    }
  }
  if (options.style) {
    Object.assign(el.style, options.style);
  }
  return el;
}

function createHTMLElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
) {
  return doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
}

function createXULElement(doc: Document, tag: string) {
  const create = (doc as any).createXULElement;
  if (typeof create === "function") {
    return create.call(doc, tag);
  }
  return doc.createElementNS(XUL_NS, tag);
}

function waitForFrameReady(
  frame: XULElement & {
    contentWindow?: Window | null;
    contentDocument?: Document | null;
  },
) {
  const isReady = () =>
    Boolean(
      frame.contentWindow?.document?.getElementById(REVIEW_MANAGER_ROOT_ID),
    );

  if (isReady()) {
    return Promise.resolve(frame.contentWindow as Window);
  }

  return new Promise<Window>((resolve, reject) => {
    const pollWindow =
      frame.ownerDocument?.defaultView || getTargetMainWindow() || globalThis;
    let finished = false;
    let attempts = 0;
    const maxAttempts = 120;

    const cleanup = () => {
      finished = true;
      frame.removeEventListener("load", onLoad as EventListener);
      frame.removeEventListener("error", onError as EventListener);
    };

    const resolveWhenReady = () => {
      if (finished) return;
      if (isReady()) {
        cleanup();
        resolve(frame.contentWindow as Window);
        return;
      }
      attempts += 1;
      if (attempts >= maxAttempts) {
        cleanup();
        reject(new Error("review manager iframe load timed out"));
        return;
      }
      try {
        (pollWindow as Window).setTimeout(resolveWhenReady, 50);
      } catch {
        setTimeout(resolveWhenReady, 50);
      }
    };

    const onLoad = () => {
      resolveWhenReady();
    };
    const onError = () => {
      cleanup();
      reject(new Error("review manager iframe failed to load"));
    };
    frame.addEventListener("load", onLoad as EventListener, { once: true });
    frame.addEventListener("error", onError as EventListener, { once: true });
    resolveWhenReady();
  });
}

function truncate(text: string, limit: number) {
  const input = String(text || "");
  return input.length > limit ? `${input.slice(0, limit - 1)}…` : input;
}

function truncateAdaptive(text: string, baseLimit: number, maxWidth: number) {
  const input = String(text || "");
  if (!input) return "";

  const normalizedBase = Math.max(8, Math.floor(Number(baseLimit) || 8));
  const normalizedWidth = Math.max(120, Math.floor(Number(maxWidth) || 120));

  const widthFactor = clampNumber(
    normalizedWidth / TABLE_TRUNCATE_BASE_WIDTH,
    0.75,
    1.9,
  );

  let cjkCount = 0;
  let latinCount = 0;
  let whitespaceCount = 0;
  for (const ch of input) {
    if (isCJKCharacter(ch)) {
      cjkCount += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      whitespaceCount += 1;
      continue;
    }
    if (/[A-Za-z0-9]/.test(ch)) {
      latinCount += 1;
    }
  }

  const totalLength = Math.max(1, input.length);
  const cjkRatio = cjkCount / totalLength;
  const latinRatio = latinCount / totalLength;
  const whitespaceRatio = whitespaceCount / totalLength;
  const scriptFactor = cjkRatio >= 0.55 ? 0.96 : latinRatio >= 0.55 ? 1.16 : 1;
  const spacingFactor = whitespaceRatio >= 0.16 ? 1.12 : 1;
  const longTokenFactor = /\S{28,}/.test(input) ? 0.95 : 1;

  const adaptiveLimit = Math.round(
    normalizedBase *
      widthFactor *
      scriptFactor *
      spacingFactor *
      longTokenFactor,
  );
  const minLimit = Math.max(
    TABLE_TRUNCATE_MIN_SENTENCE_LENGTH,
    Math.floor(normalizedBase * TABLE_TRUNCATE_MIN_FACTOR),
  );
  const maxLimit = Math.max(
    minLimit + 8,
    Math.floor(normalizedBase * TABLE_TRUNCATE_MAX_FACTOR),
  );
  const rawLimit = clampNumber(adaptiveLimit, minLimit, maxLimit);
  const finalLimit = expandToSentenceBoundary(
    input,
    rawLimit,
    TABLE_TRUNCATE_BOUNDARY_WINDOW,
  );
  return truncate(input, finalLimit);
}

function expandToSentenceBoundary(
  text: string,
  limit: number,
  windowSize: number,
) {
  const input = String(text || "");
  if (input.length <= limit) return input.length;

  const start = Math.max(0, limit - 2);
  const end = Math.min(input.length - 1, limit + Math.max(0, windowSize));
  let secondaryBoundary = -1;
  for (let i = start; i <= end; i++) {
    const ch = input[i];
    if (/[。！？.!?]/.test(ch)) {
      return i + 1;
    }
    if (secondaryBoundary < 0 && /[；;，,]/.test(ch)) {
      secondaryBoundary = i + 1;
    }
  }
  if (secondaryBoundary > 0) return secondaryBoundary;
  return limit;
}

function isCJKCharacter(ch: string) {
  const code = ch.codePointAt(0) || 0;
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2ceaf)
  );
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(iso: string) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}`;
  } catch {
    return iso;
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

function focusZoteroItem(itemID: number) {
  const wins = getMainWindowsCompat();
  const win = wins[0] as any;
  if (!win) {
    ztoolkit.getGlobal("alert")("无法定位条目：未找到 Zotero 主窗口");
    return;
  }
  try {
    win.focus();
    if (win.ZoteroPane?.selectItem) {
      void win.ZoteroPane.selectItem(itemID);
    }
  } catch (e) {
    ztoolkit.log("focusZoteroItem failed", e);
  }
}

function showManagerToast(
  text: string,
  type: "success" | "default" = "success",
) {
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text,
      type,
      progress: 100,
    })
    .show();
}

async function writeTextFile(path: string, content: string) {
  const zFile = (Zotero as any).File;
  if (zFile?.putContentsAsync) {
    await zFile.putContentsAsync(path, content);
    return;
  }
  const ioUtils = (globalThis as any).IOUtils;
  if (ioUtils?.writeUTF8) {
    await ioUtils.writeUTF8(path, content);
    return;
  }
  throw new Error("当前环境不支持文件写入 API");
}
