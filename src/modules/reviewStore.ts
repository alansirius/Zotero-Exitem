import { config } from "../../package.json";
import {
  LiteratureReviewDraft,
  ReviewFolderRow,
  ReviewListFilters,
  ReviewRecordRow,
  ReviewRecordType,
} from "./reviewTypes";

const DEFAULT_FOLDER_NAME = "未分类";
const PROTECTED_FOLDER_NAMES = new Set([DEFAULT_FOLDER_NAME]);
const DEFAULT_COEXIST_FOLDER_NAMES = new Set(["我的记录"]);
const STORE_FILE_NAME = `${config.addonRef}-review-store.json`;
const STORE_SCHEMA_VERSION = 2;

type StoreEventName = string;

interface JSONStoreFolder {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface JSONStoreRecord {
  id: number;
  zoteroItemID: number;
  recordType: ReviewRecordType;
  title: string;
  authors: string;
  journal: string;
  publicationDate: string;
  abstractText: string;
  pdfAnnotationNotesText: string;
  researchBackground: string;
  literatureReview: string;
  researchMethods: string;
  researchConclusions: string;
  keyFindings: string[];
  classificationTags: string[];
  aiProvider: string;
  aiModel: string;
  rawAIResponse: string;
  sourceRecordIDs: number[];
  sourceZoteroItemIDs: number[];
  createdAt: string;
  updatedAt: string;
}

interface JSONStoreRecordFolderLink {
  recordID: number;
  folderID: number;
  createdAt: string;
}

interface JSONStoreEvent {
  id: number;
  eventName: StoreEventName;
  payloadJSON: string;
  createdAt: string;
}

interface JSONStoreData {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  nextIDs: {
    folder: number;
    record: number;
    event: number;
  };
  folders: JSONStoreFolder[];
  records: JSONStoreRecord[];
  recordFolderLinks: JSONStoreRecordFolderLink[];
  events: JSONStoreEvent[];
}

let initialized = false;
let opChain: Promise<void> = Promise.resolve();

export async function initReviewStore() {
  await withStoreOp(async () => {
    const store = await loadStoreData();
    const changed = ensureStoreIntegrity(store);
    if (changed) {
      await saveStoreData(store);
    }
    initialized = true;
  });
}

export async function trackReviewEvent(
  eventName: string,
  payload: Record<string, unknown> = {},
) {
  await withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    store.events.push({
      id: allocateID(store, "event"),
      eventName: String(eventName || "").trim() || "unknown_event",
      payloadJSON: safeJSONStringify(payload),
      createdAt: nowISO(),
    });
    markStoreUpdated(store);
    await saveStoreData(store);
  });
}

export async function getTodayAIExtractionCount(): Promise<number> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const today = new Date().toISOString().slice(0, 10);
    return store.events.filter(
      (e) =>
        (e.eventName === "ai_extraction_success" ||
          e.eventName === "ai_extraction_fail") &&
        String(e.createdAt || "").slice(0, 10) === today,
    ).length;
  });
}

export async function listReviewFolders(): Promise<ReviewFolderRow[]> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    return sortFolders(store.folders).map(mapFolderRow);
  });
}

export async function createReviewFolder(
  name: string,
): Promise<ReviewFolderRow> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const normalized = normalizeFolderName(name);
    if (!normalized) {
      throw new Error("文件夹名称不能为空");
    }
    const existing = findFolderByName(store, normalized);
    if (existing) return mapFolderRow(existing);
    const timestamp = nowISO();
    const folder: JSONStoreFolder = {
      id: allocateID(store, "folder"),
      name: normalized,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.folders.push(folder);
    markStoreUpdated(store);
    await saveStoreData(store);
    return mapFolderRow(folder);
  });
}

export async function renameReviewFolder(
  folderID: number,
  nextName: string,
): Promise<ReviewFolderRow> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const id = Number(folderID);
    const folder = findFolderByID(store, id);
    if (!folder) {
      throw new Error("文件夹不存在");
    }
    if (PROTECTED_FOLDER_NAMES.has(folder.name)) {
      throw new Error(`系统文件夹不可重命名：${folder.name}`);
    }

    const normalized = normalizeFolderName(nextName);
    if (!normalized) {
      throw new Error("文件夹名称不能为空");
    }

    const existing = findFolderByName(store, normalized);
    if (existing && existing.id !== folder.id) {
      throw new Error(`已存在同名文件夹：${existing.name}`);
    }

    if (folder.name === normalized) {
      return mapFolderRow(folder);
    }

    const timestamp = nowISO();
    folder.name = normalized;
    folder.updatedAt = timestamp;
    touchRecords(
      store,
      getRecordIDsByFolderIDsInternal(store, [folder.id]),
      timestamp,
    );
    markStoreUpdated(store);
    await saveStoreData(store);
    return mapFolderRow(folder);
  });
}

export async function deleteReviewFolder(folderID: number) {
  await withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const id = Number(folderID);
    const folder = findFolderByID(store, id);
    if (!folder) return;
    if (PROTECTED_FOLDER_NAMES.has(folder.name)) {
      throw new Error(`系统文件夹不可删除：${folder.name}`);
    }
    const affectedRecordIDs = getRecordIDsByFolderIDsInternal(store, [id]);
    store.recordFolderLinks = store.recordFolderLinks.filter(
      (link) => link.folderID !== id,
    );
    store.folders = store.folders.filter((f) => f.id !== id);
    normalizeRecordFolderMemberships(store, affectedRecordIDs);
    touchRecords(store, affectedRecordIDs);
    markStoreUpdated(store);
    await saveStoreData(store);
  });
}

export async function mergeReviewFolders(
  folderIDs: number[],
  newFolderName: string,
): Promise<ReviewFolderRow> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const validIDs = Array.from(new Set(folderIDs.map(Number).filter(Boolean)));
    if (validIDs.length < 2) {
      throw new Error("至少选择两个文件夹进行合并");
    }
    const folders = validIDs
      .map((id) => findFolderByID(store, id))
      .filter((f): f is JSONStoreFolder => Boolean(f));
    const protectedFolders = folders.filter((f) =>
      PROTECTED_FOLDER_NAMES.has(f.name),
    );
    if (protectedFolders.length) {
      throw new Error(
        `系统文件夹不可合并：${protectedFolders.map((f) => f.name).join("、")}`,
      );
    }

    const normalizedName = normalizeFolderName(newFolderName);
    if (!normalizedName) {
      throw new Error("合并后的文件夹名称不能为空");
    }
    let newFolder = findFolderByName(store, normalizedName);
    if (!newFolder) {
      const timestamp = nowISO();
      newFolder = {
        id: allocateID(store, "folder"),
        name: normalizedName,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      store.folders.push(newFolder);
    }

    const affectedRecordIDs = getRecordIDsByFolderIDsInternal(store, validIDs);
    const timestamp = nowISO();
    for (const recordID of affectedRecordIDs) {
      addRecordFolderLink(store, recordID, newFolder.id, timestamp);
    }

    const sourceFolderIDs = validIDs.filter((id) => id !== newFolder!.id);
    if (sourceFolderIDs.length) {
      const sourceIDSet = new Set(sourceFolderIDs);
      store.recordFolderLinks = store.recordFolderLinks.filter(
        (link) => !sourceIDSet.has(link.folderID),
      );
      store.folders = store.folders.filter(
        (folder) =>
          !sourceIDSet.has(folder.id) ||
          PROTECTED_FOLDER_NAMES.has(folder.name),
      );
    }

    normalizeRecordFolderMemberships(store, affectedRecordIDs);
    touchRecords(store, affectedRecordIDs, timestamp);
    markStoreUpdated(store);
    await saveStoreData(store);
    return mapFolderRow(newFolder);
  });
}

export async function ensureDefaultReviewFolder() {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    const changed = ensureStoreIntegrity(store);
    const folder = ensureDefaultFolder(store);
    if (changed) {
      await saveStoreData(store);
    }
    return mapFolderRow(folder);
  });
}

export async function upsertReviewRecord(
  draft: LiteratureReviewDraft,
  options: { folderID?: number | null } = {},
): Promise<ReviewRecordRow> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const existing = store.records.find(
      (record) =>
        record.recordType !== "folderSummary" &&
        record.zoteroItemID === Number(draft.zoteroItemID),
    );
    const timestamp = nowISO();
    let record: JSONStoreRecord;
    if (existing) {
      record = existing;
      record.recordType = "literature";
      record.title = String(draft.title || "");
      record.authors = String(draft.authors || "");
      record.journal = String(draft.journal || "");
      record.publicationDate = String(draft.publicationDate || "");
      record.abstractText = String(draft.abstractText || "");
      record.pdfAnnotationNotesText = String(
        draft.pdfAnnotationNotesText || "",
      );
      record.researchBackground = String(draft.researchBackground || "");
      record.literatureReview = String(draft.literatureReview || "");
      record.researchMethods = String(draft.researchMethods || "");
      record.researchConclusions = String(draft.researchConclusions || "");
      record.keyFindings = normalizeStringArray(draft.keyFindings);
      record.classificationTags = normalizeStringArray(
        draft.classificationTags,
      );
      record.aiProvider = String(draft.aiProvider || "");
      record.aiModel = String(draft.aiModel || "");
      record.rawAIResponse = String(draft.rawAIResponse || "");
      record.sourceRecordIDs = [];
      record.sourceZoteroItemIDs = [];
      record.updatedAt = timestamp;
    } else {
      record = {
        id: allocateID(store, "record"),
        zoteroItemID: Number(draft.zoteroItemID),
        recordType: "literature",
        title: String(draft.title || ""),
        authors: String(draft.authors || ""),
        journal: String(draft.journal || ""),
        publicationDate: String(draft.publicationDate || ""),
        abstractText: String(draft.abstractText || ""),
        pdfAnnotationNotesText: String(draft.pdfAnnotationNotesText || ""),
        researchBackground: String(draft.researchBackground || ""),
        literatureReview: String(draft.literatureReview || ""),
        researchMethods: String(draft.researchMethods || ""),
        researchConclusions: String(draft.researchConclusions || ""),
        keyFindings: normalizeStringArray(draft.keyFindings),
        classificationTags: normalizeStringArray(draft.classificationTags),
        aiProvider: String(draft.aiProvider || ""),
        aiModel: String(draft.aiModel || ""),
        rawAIResponse: String(draft.rawAIResponse || ""),
        sourceRecordIDs: [],
        sourceZoteroItemIDs: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      store.records.push(record);
    }

    if (typeof options.folderID === "number" || options.folderID === null) {
      const actualFolderID = resolveTargetFolderID(store, options.folderID);
      addRecordFolderLink(store, record.id, actualFolderID, timestamp);
    }

    normalizeRecordFolderMemberships(store, [record.id]);
    markStoreUpdated(store);
    await saveStoreData(store);
    return mapRecordWithFolders(store, record, { includeRawAIResponse: true });
  });
}

export async function createFolderSummaryRecord(input: {
  folderID?: number | null;
  folderName: string;
  summaryText: string;
  sourceRows: Array<Pick<ReviewRecordRow, "id" | "zoteroItemID">>;
  aiProvider: string;
  aiModel: string;
}): Promise<ReviewRecordRow> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);

    const timestamp = nowISO();
    const normalizedFolderName =
      String(input.folderName || "").trim() || "未命名文件夹";
    const sourceRecordIDs = normalizeIDList(
      input.sourceRows.map((row) => Number(row.id)),
    );
    const sourceZoteroItemIDs = normalizePositiveIntegerList(
      input.sourceRows.map((row) => Number(row.zoteroItemID)),
    );
    const publicationDate = timestamp.slice(0, 10);

    const record: JSONStoreRecord = {
      id: allocateID(store, "record"),
      zoteroItemID: 0,
      recordType: "folderSummary",
      title: `合并综述：${normalizedFolderName}（${publicationDate}）`,
      authors: `基于 ${sourceRecordIDs.length} 篇文献`,
      journal: "文件夹合并综述",
      publicationDate,
      abstractText: "",
      pdfAnnotationNotesText: "",
      researchBackground: "",
      literatureReview: String(input.summaryText || "").trim(),
      researchMethods: "",
      researchConclusions: "",
      keyFindings: [],
      classificationTags: normalizeStringArray([
        "合并综述",
        normalizedFolderName,
      ]),
      aiProvider: String(input.aiProvider || ""),
      aiModel: String(input.aiModel || ""),
      rawAIResponse: String(input.summaryText || "").trim(),
      sourceRecordIDs,
      sourceZoteroItemIDs,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.records.push(record);

    const actualFolderID = resolveTargetFolderID(store, input.folderID ?? null);
    addRecordFolderLink(store, record.id, actualFolderID, timestamp);

    normalizeRecordFolderMemberships(store, [record.id]);
    markStoreUpdated(store);
    await saveStoreData(store);
    return mapRecordWithFolders(store, record, { includeRawAIResponse: true });
  });
}

export async function getReviewRecordByItemID(
  zoteroItemID: number,
): Promise<ReviewRecordRow | null> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const record = store.records.find(
      (row) =>
        row.recordType !== "folderSummary" &&
        row.zoteroItemID === Number(zoteroItemID),
    );
    if (!record) return null;
    return mapRecordWithFolders(store, record, { includeRawAIResponse: true });
  });
}

export async function getReviewRecordByID(
  id: number,
): Promise<ReviewRecordRow | null> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const record = store.records.find((row) => row.id === Number(id));
    if (!record) return null;
    return mapRecordWithFolders(store, record, { includeRawAIResponse: true });
  });
}

export async function countReviewRecords(
  filters: ReviewListFilters = {},
): Promise<number> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    return applyRecordFilters(store, store.records, filters).length;
  });
}

export async function listReviewRecords(
  filters: ReviewListFilters = {},
): Promise<ReviewRecordRow[]> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    let rows = applyRecordFilters(store, store.records, filters);
    rows = sortRecords(rows, filters);
    rows = paginateRecords(rows, filters);
    return rows.map((record) =>
      mapRecordWithFolders(store, record, { includeRawAIResponse: false }),
    );
  });
}

export async function assignReviewRecordsFolder(
  recordIDs: number[],
  folderID: number | null,
) {
  await withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const ids = normalizeIDList(recordIDs);
    if (!ids.length) return;
    const actualFolderID = resolveTargetFolderID(store, folderID);
    const timestamp = nowISO();
    for (const id of ids) {
      if (!store.records.some((record) => record.id === id)) continue;
      addRecordFolderLink(store, id, actualFolderID, timestamp);
    }
    normalizeRecordFolderMemberships(store, ids);
    touchRecords(store, ids, timestamp);
    markStoreUpdated(store);
    await saveStoreData(store);
  });
}

export async function removeReviewRecordsFromFolder(
  recordIDs: number[],
  folderID: number,
) {
  await withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const ids = normalizeIDList(recordIDs);
    if (!ids.length) return;
    const folder = findFolderByID(store, Number(folderID));
    if (!folder) {
      throw new Error("目标文件夹不存在");
    }
    if (PROTECTED_FOLDER_NAMES.has(folder.name)) {
      throw new Error(`系统文件夹不可直接移出：${folder.name}`);
    }
    const idSet = new Set(ids);
    store.recordFolderLinks = store.recordFolderLinks.filter(
      (link) => !(link.folderID === folder.id && idSet.has(link.recordID)),
    );
    normalizeRecordFolderMemberships(store, ids);
    touchRecords(store, ids);
    markStoreUpdated(store);
    await saveStoreData(store);
  });
}

export async function deleteReviewRecords(
  recordIDs: number[],
): Promise<number> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const ids = normalizeIDList(recordIDs);
    if (!ids.length) return 0;

    const existingIDs = new Set(store.records.map((record) => record.id));
    const effectiveIDs = ids.filter((id) => existingIDs.has(id));
    if (!effectiveIDs.length) return 0;

    const effectiveIDSet = new Set(effectiveIDs);
    const removedZoteroItemIDs = new Set<number>();
    for (const record of store.records) {
      if (!effectiveIDSet.has(record.id)) continue;
      if (record.zoteroItemID > 0) {
        removedZoteroItemIDs.add(record.zoteroItemID);
      }
    }

    const timestamp = nowISO();
    store.records = store.records.filter(
      (record) => !effectiveIDSet.has(record.id),
    );
    store.recordFolderLinks = store.recordFolderLinks.filter(
      (link) => !effectiveIDSet.has(link.recordID),
    );

    for (const record of store.records) {
      const prevSourceRecordIDs = Array.isArray(record.sourceRecordIDs)
        ? record.sourceRecordIDs
        : [];
      const nextSourceRecordIDs = prevSourceRecordIDs.filter(
        (id) => !effectiveIDSet.has(Number(id)),
      );

      const prevSourceItemIDs = Array.isArray(record.sourceZoteroItemIDs)
        ? record.sourceZoteroItemIDs
        : [];
      const nextSourceItemIDs = prevSourceItemIDs.filter(
        (id) => !removedZoteroItemIDs.has(Number(id)),
      );

      if (
        nextSourceRecordIDs.length !== prevSourceRecordIDs.length ||
        nextSourceItemIDs.length !== prevSourceItemIDs.length
      ) {
        record.sourceRecordIDs = nextSourceRecordIDs;
        record.sourceZoteroItemIDs = nextSourceItemIDs;
        record.updatedAt = timestamp;
      }
    }

    markStoreUpdated(store);
    await saveStoreData(store);
    return effectiveIDs.length;
  });
}

export async function updateReviewRecordRawResponse(
  recordID: number,
  rawAIResponse: string,
): Promise<ReviewRecordRow | null> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const record = store.records.find((row) => row.id === Number(recordID));
    if (!record) return null;
    const nextRaw = String(rawAIResponse || "");
    record.rawAIResponse = nextRaw;
    // Keep folder-summary body in sync with editable raw content.
    if (record.recordType === "folderSummary") {
      record.literatureReview = nextRaw;
    }
    record.updatedAt = nowISO();
    markStoreUpdated(store);
    await saveStoreData(store);
    return mapRecordWithFolders(store, record, { includeRawAIResponse: true });
  });
}

export async function updateLiteratureReviewRecord(
  recordID: number,
  input: {
    title: string;
    authors: string;
    journal: string;
    publicationDate: string;
    abstractText: string;
    pdfAnnotationNotesText: string;
    researchBackground: string;
    literatureReview: string;
    researchMethods: string;
    researchConclusions: string;
    keyFindings: string[];
    classificationTags: string[];
  },
): Promise<ReviewRecordRow | null> {
  return withStoreOp(async () => {
    const store = await loadStoreData();
    ensureStoreIntegrity(store);
    const record = store.records.find((row) => row.id === Number(recordID));
    if (!record) return null;
    if (record.recordType === "folderSummary") {
      throw new Error("合并综述记录不支持此编辑方式");
    }

    record.title = String(input.title || "").trim();
    record.authors = String(input.authors || "").trim();
    record.journal = String(input.journal || "").trim();
    record.publicationDate = String(input.publicationDate || "").trim();
    record.abstractText = String(input.abstractText || "").trim();
    record.pdfAnnotationNotesText = String(
      input.pdfAnnotationNotesText || "",
    ).trim();
    record.researchBackground = String(input.researchBackground || "").trim();
    record.literatureReview = String(input.literatureReview || "").trim();
    record.researchMethods = String(input.researchMethods || "").trim();
    record.researchConclusions = String(input.researchConclusions || "").trim();
    record.keyFindings = normalizeStringArray(input.keyFindings);
    record.classificationTags = normalizeStringArray(input.classificationTags);
    record.rawAIResponse = buildLiteratureRawAIResponse(record);
    record.updatedAt = nowISO();
    markStoreUpdated(store);
    await saveStoreData(store);
    return mapRecordWithFolders(store, record, { includeRawAIResponse: true });
  });
}

export async function exportReviewRecordsAsCSV(
  filters: ReviewListFilters = {},
): Promise<string> {
  const rows = await listReviewRecords(filters);
  const csvRows =
    filters.recordType === "folderSummary"
      ? buildFolderSummaryCSVRows(rows)
      : buildLiteratureCSVRows(rows);
  return (
    "\uFEFF" + csvRows.map((cols) => cols.map(csvEscape).join(",")).join("\n")
  );
}

function buildLiteratureCSVRows(rows: ReviewRecordRow[]) {
  const headers = [
    "记录ID",
    "记录类型",
    "Zotero条目ID",
    "来源记录ID",
    "来源条目ID",
    "文件夹",
    "标题",
    "作者",
    "期刊",
    "发布时间",
    "标签",
    "摘要",
    "PDF批注与笔记",
    "研究背景",
    "文献综述",
    "研究方法",
    "研究结论",
    "关键发现",
    "AI供应商",
    "AI模型",
    "更新时间",
  ];
  const csvRows = [headers];
  for (const row of rows) {
    csvRows.push([
      String(row.id),
      String(row.recordType || "literature"),
      String(row.zoteroItemID),
      (row.sourceRecordIDs || []).map((v) => String(v)).join("; "),
      (row.sourceZoteroItemIDs || []).map((v) => String(v)).join("; "),
      row.folderNames.join("; "),
      row.title,
      row.authors,
      row.journal,
      row.publicationDate,
      row.classificationTags.join("; "),
      row.abstractText,
      row.pdfAnnotationNotesText || "",
      row.researchBackground,
      row.literatureReview,
      row.researchMethods,
      row.researchConclusions,
      row.keyFindings.join("; "),
      row.aiProvider,
      row.aiModel,
      row.updatedAt,
    ]);
  }
  return csvRows;
}

function buildFolderSummaryCSVRows(rows: ReviewRecordRow[]) {
  const headers = [
    "记录ID",
    "记录类型",
    "标题",
    "文件夹",
    "来源文献数",
    "来源文献记录ID",
    "来源Zotero条目ID",
    "合并综述内容",
    "AI供应商",
    "AI模型",
    "创建时间",
    "更新时间",
  ];
  const csvRows = [headers];
  for (const row of rows) {
    csvRows.push([
      String(row.id),
      String(row.recordType || "folderSummary"),
      row.title,
      row.folderNames.join("; "),
      String((row.sourceRecordIDs || []).length),
      (row.sourceRecordIDs || []).map((v) => String(v)).join("; "),
      (row.sourceZoteroItemIDs || []).map((v) => String(v)).join("; "),
      row.literatureReview || row.rawAIResponse || "",
      row.aiProvider,
      row.aiModel,
      row.createdAt,
      row.updatedAt,
    ]);
  }
  return csvRows;
}

async function withStoreOp<T>(fn: () => Promise<T>): Promise<T> {
  const task = opChain.then(fn, fn);
  opChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function loadStoreData(): Promise<JSONStoreData> {
  const filePath = getStoreFilePath();
  const text = await tryReadTextFile(filePath);
  if (!text) {
    const initial = createEmptyStoreData();
    ensureStoreIntegrity(initial);
    await saveStoreData(initial);
    return initial;
  }

  try {
    const parsed = JSON.parse(text);
    const store = normalizeStoreData(parsed);
    ensureStoreIntegrity(store);
    return store;
  } catch (e) {
    ztoolkit.log("Failed to parse review JSON store, recreating file", e);
    const fallback = createEmptyStoreData();
    ensureStoreIntegrity(fallback);
    await saveStoreData(fallback);
    return fallback;
  }
}

async function saveStoreData(store: JSONStoreData) {
  markStoreUpdated(store);
  const filePath = getStoreFilePath();
  const text = JSON.stringify(store, null, 2);
  await writeTextFile(filePath, text);
}

function createEmptyStoreData(): JSONStoreData {
  const timestamp = nowISO();
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextIDs: {
      folder: 1,
      record: 1,
      event: 1,
    },
    folders: [],
    records: [],
    recordFolderLinks: [],
    events: [],
  };
}

function normalizeStoreData(raw: any): JSONStoreData {
  const now = nowISO();
  const folders = Array.isArray(raw?.folders)
    ? raw.folders.map(normalizeFolderRecord).filter(Boolean)
    : [];
  const records = Array.isArray(raw?.records)
    ? raw.records.map(normalizeReviewRecord).filter(Boolean)
    : [];
  const recordFolderLinks = Array.isArray(raw?.recordFolderLinks)
    ? raw.recordFolderLinks.map(normalizeRecordFolderLink).filter(Boolean)
    : [];
  const events = Array.isArray(raw?.events)
    ? raw.events.map(normalizeStoreEvent).filter(Boolean)
    : [];
  const nextIDs = {
    folder: Math.max(
      1,
      Number(raw?.nextIDs?.folder) ||
        maxID(folders.map((f: JSONStoreFolder) => f.id)) + 1,
    ),
    record: Math.max(
      1,
      Number(raw?.nextIDs?.record) ||
        maxID(records.map((r: JSONStoreRecord) => r.id)) + 1,
    ),
    event: Math.max(
      1,
      Number(raw?.nextIDs?.event) ||
        maxID(events.map((e: JSONStoreEvent) => e.id)) + 1,
    ),
  };
  return {
    schemaVersion: Number(raw?.schemaVersion) || STORE_SCHEMA_VERSION,
    createdAt: String(raw?.createdAt || now),
    updatedAt: String(raw?.updatedAt || now),
    nextIDs,
    folders,
    records,
    recordFolderLinks,
    events,
  };
}

function ensureStoreIntegrity(store: JSONStoreData) {
  let changed = false;
  store.schemaVersion = STORE_SCHEMA_VERSION;
  if (!store.createdAt) {
    store.createdAt = nowISO();
    changed = true;
  }
  if (!store.updatedAt) {
    store.updatedAt = nowISO();
    changed = true;
  }

  const defaultFolder = ensureDefaultFolder(store);
  if (!defaultFolder) {
    changed = true;
  }

  const folderIDs = new Set(store.folders.map((f) => f.id));
  const recordIDs = new Set(store.records.map((r) => r.id));
  const seenLinkKeys = new Set<string>();
  const beforeLinksLen = store.recordFolderLinks.length;
  store.recordFolderLinks = store.recordFolderLinks.filter((link) => {
    if (!folderIDs.has(link.folderID) || !recordIDs.has(link.recordID))
      return false;
    const key = `${link.recordID}:${link.folderID}`;
    if (seenLinkKeys.has(key)) return false;
    seenLinkKeys.add(key);
    return true;
  });
  if (store.recordFolderLinks.length !== beforeLinksLen) changed = true;

  const beforeFolderLen = store.folders.length;
  const folderSeen = new Set<string>();
  store.folders = store.folders.filter((folder) => {
    const key = String(folder.name || "")
      .trim()
      .toLowerCase();
    if (!key) return false;
    if (folderSeen.has(key)) return false;
    folderSeen.add(key);
    return true;
  });
  if (store.folders.length !== beforeFolderLen) changed = true;

  if (normalizeRecordFolderMemberships(store)) changed = true;

  store.nextIDs.folder = Math.max(
    store.nextIDs.folder || 1,
    maxID(store.folders.map((f) => f.id)) + 1,
  );
  store.nextIDs.record = Math.max(
    store.nextIDs.record || 1,
    maxID(store.records.map((r) => r.id)) + 1,
  );
  store.nextIDs.event = Math.max(
    store.nextIDs.event || 1,
    maxID(store.events.map((e) => e.id)) + 1,
  );
  return changed;
}

function ensureDefaultFolder(store: JSONStoreData): JSONStoreFolder {
  let folder = findFolderByName(store, DEFAULT_FOLDER_NAME);
  if (folder) return folder;
  const timestamp = nowISO();
  folder = {
    id: allocateID(store, "folder"),
    name: DEFAULT_FOLDER_NAME,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.folders.push(folder);
  return folder;
}

function resolveTargetFolderID(
  store: JSONStoreData,
  folderID: number | null | undefined,
) {
  if (typeof folderID === "number" && Number.isFinite(folderID)) {
    const folder = findFolderByID(store, folderID);
    if (!folder) {
      throw new Error("目标文件夹不存在");
    }
    return folder.id;
  }
  return ensureDefaultFolder(store).id;
}

function normalizeRecordFolderMemberships(
  store: JSONStoreData,
  recordIDs?: number[],
) {
  let changed = false;
  const ids = recordIDs?.length
    ? normalizeIDList(recordIDs)
    : store.records.map((record) => record.id);
  if (!ids.length) return changed;
  const defaultFolder = ensureDefaultFolder(store);

  for (const recordID of ids) {
    const links = store.recordFolderLinks.filter(
      (link) => link.recordID === recordID,
    );
    if (!links.length) {
      addRecordFolderLink(store, recordID, defaultFolder.id);
      changed = true;
      continue;
    }
    const hasDefault = links.some((link) => link.folderID === defaultFolder.id);
    const hasNonDefault = links.some(
      (link) => link.folderID !== defaultFolder.id,
    );
    const keepDefaultCoexist = links.some((link) => {
      if (link.folderID === defaultFolder.id) return false;
      const folder = findFolderByID(store, link.folderID);
      return !!folder && DEFAULT_COEXIST_FOLDER_NAMES.has(folder.name);
    });
    if (hasDefault && hasNonDefault && !keepDefaultCoexist) {
      const before = store.recordFolderLinks.length;
      store.recordFolderLinks = store.recordFolderLinks.filter(
        (link) =>
          !(link.recordID === recordID && link.folderID === defaultFolder.id),
      );
      if (store.recordFolderLinks.length !== before) changed = true;
    }
  }
  return changed;
}

function addRecordFolderLink(
  store: JSONStoreData,
  recordID: number,
  folderID: number,
  timestamp = nowISO(),
) {
  const exists = store.recordFolderLinks.some(
    (link) => link.recordID === recordID && link.folderID === folderID,
  );
  if (exists) return;
  store.recordFolderLinks.push({
    recordID,
    folderID,
    createdAt: timestamp,
  });
}

function touchRecords(
  store: JSONStoreData,
  recordIDs: number[],
  timestamp = nowISO(),
) {
  const idSet = new Set(normalizeIDList(recordIDs));
  if (!idSet.size) return;
  for (const record of store.records) {
    if (idSet.has(record.id)) {
      record.updatedAt = timestamp;
    }
  }
}

function markStoreUpdated(store: JSONStoreData) {
  store.updatedAt = nowISO();
}

function allocateID(store: JSONStoreData, key: keyof JSONStoreData["nextIDs"]) {
  const current = Math.max(1, Math.floor(Number(store.nextIDs[key]) || 1));
  store.nextIDs[key] = current + 1;
  return current;
}

function applyRecordFilters(
  store: JSONStoreData,
  records: JSONStoreRecord[],
  filters: ReviewListFilters = {},
) {
  let rows = [...records];

  const recordTypeFilter = filters.recordType || "all";
  if (recordTypeFilter !== "all") {
    rows = rows.filter((row) => row.recordType === recordTypeFilter);
  }

  if (typeof filters.folderID === "number") {
    const targetFolderID = Number(filters.folderID);
    const allowed = new Set(
      store.recordFolderLinks
        .filter((link) => link.folderID === targetFolderID)
        .map((link) => link.recordID),
    );
    rows = rows.filter((row) => allowed.has(row.id));
  }

  const q = String(filters.search || "")
    .trim()
    .toLowerCase();
  if (q) {
    const folderNamesByRecord = buildFolderNamesByRecordMap(store);
    rows = rows.filter((row) => {
      const haystack = [
        row.title,
        row.authors,
        row.journal,
        row.publicationDate,
        row.abstractText,
        row.pdfAnnotationNotesText,
        row.researchBackground,
        row.literatureReview,
        row.researchMethods,
        row.researchConclusions,
        row.keyFindings.join(","),
        row.classificationTags.join(","),
        row.recordType,
        row.sourceRecordIDs.join(","),
        row.sourceZoteroItemIDs.join(","),
        (folderNamesByRecord.get(row.id) || []).join(","),
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  return rows;
}

function sortRecords(
  records: JSONStoreRecord[],
  filters: ReviewListFilters = {},
) {
  const sortKey = filters.sortKey || "updatedAt";
  const sortDir = filters.sortDir === "asc" ? "asc" : "desc";
  return [...records].sort((a, b) => {
    const keyMap: Record<string, string> = {
      updatedAt: "updatedAt",
      title: "title",
      publicationDate: "publicationDate",
      journal: "journal",
    };
    const k = keyMap[sortKey] || "updatedAt";
    const av = String((a as any)[k] || "").toLowerCase();
    const bv = String((b as any)[k] || "").toLowerCase();
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return (b.id || 0) - (a.id || 0);
  });
}

function paginateRecords(
  records: JSONStoreRecord[],
  filters: ReviewListFilters = {},
) {
  const limit = normalizePositiveInteger(filters.limit);
  const offset = normalizeNonNegativeInteger(filters.offset) || 0;
  if (limit == null) {
    return offset > 0 ? records.slice(offset) : records;
  }
  return records.slice(offset, offset + limit);
}

function getRecordIDsByFolderIDsInternal(
  store: JSONStoreData,
  folderIDs: number[],
) {
  const idSet = new Set(normalizeIDList(folderIDs));
  return Array.from(
    new Set(
      store.recordFolderLinks
        .filter((link) => idSet.has(link.folderID))
        .map((link) => link.recordID),
    ),
  );
}

function mapFolderRow(folder: JSONStoreFolder): ReviewFolderRow {
  return {
    id: folder.id,
    name: folder.name,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

function mapRecordWithFolders(
  store: JSONStoreData,
  record: JSONStoreRecord,
  options: { includeRawAIResponse: boolean },
): ReviewRecordRow {
  const defaultFolder = ensureDefaultFolder(store);
  const folders = sortFolders(
    store.recordFolderLinks
      .filter((link) => link.recordID === record.id)
      .map((link) => findFolderByID(store, link.folderID))
      .filter((f): f is JSONStoreFolder => Boolean(f)),
  );
  const finalFolders = folders.length ? folders : [defaultFolder];
  const folderIDs = finalFolders.map((folder) => folder.id);
  const folderNames = finalFolders.map((folder) => folder.name);

  return {
    id: record.id,
    zoteroItemID: record.zoteroItemID,
    recordType: record.recordType,
    folderID: folderIDs[0] ?? null,
    folderName: folderNames[0] ?? null,
    folderIDs,
    folderNames,
    title: record.title,
    authors: record.authors,
    journal: record.journal,
    publicationDate: record.publicationDate,
    abstractText: record.abstractText,
    pdfAnnotationNotesText: record.pdfAnnotationNotesText || "",
    researchBackground: record.researchBackground,
    literatureReview: record.literatureReview,
    researchMethods: record.researchMethods,
    researchConclusions: record.researchConclusions,
    keyFindings: [...record.keyFindings],
    classificationTags: [...record.classificationTags],
    sourceRecordIDs: [...record.sourceRecordIDs],
    sourceZoteroItemIDs: [...record.sourceZoteroItemIDs],
    aiProvider: record.aiProvider,
    aiModel: record.aiModel,
    rawAIResponse: options.includeRawAIResponse ? record.rawAIResponse : "",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function buildFolderNamesByRecordMap(store: JSONStoreData) {
  const folderByID = new Map(
    store.folders.map((folder) => [folder.id, folder.name]),
  );
  const result = new Map<number, string[]>();
  for (const link of store.recordFolderLinks) {
    const folderName = folderByID.get(link.folderID);
    if (!folderName) continue;
    const list = result.get(link.recordID) || [];
    list.push(folderName);
    result.set(link.recordID, list);
  }
  for (const [recordID, names] of result.entries()) {
    result.set(recordID, sortFolderNames(names));
  }
  return result;
}

function sortFolders(folders: JSONStoreFolder[]) {
  return [...folders].sort((a, b) => {
    const aDefault = a.name === DEFAULT_FOLDER_NAME ? 0 : 1;
    const bDefault = b.name === DEFAULT_FOLDER_NAME ? 0 : 1;
    if (aDefault !== bDefault) return aDefault - bDefault;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return a.id - b.id;
  });
}

function sortFolderNames(names: string[]) {
  return [
    ...new Set(names.map((n) => String(n || "").trim()).filter(Boolean)),
  ].sort((a, b) => {
    const aDefault = a === DEFAULT_FOLDER_NAME ? 0 : 1;
    const bDefault = b === DEFAULT_FOLDER_NAME ? 0 : 1;
    if (aDefault !== bDefault) return aDefault - bDefault;
    return a.localeCompare(b, "zh-CN");
  });
}

function findFolderByID(store: JSONStoreData, id: number) {
  return store.folders.find((folder) => folder.id === Number(id)) || null;
}

function findFolderByName(store: JSONStoreData, name: string) {
  const target = String(name || "")
    .trim()
    .toLowerCase();
  return (
    store.folders.find(
      (folder) => folder.name.trim().toLowerCase() === target,
    ) || null
  );
}

function normalizeFolderRecord(value: any): JSONStoreFolder | null {
  const id = Number(value?.id);
  const name = normalizeFolderName(value?.name);
  if (!Number.isFinite(id) || id <= 0 || !name) return null;
  return {
    id,
    name,
    createdAt: String(value?.createdAt || nowISO()),
    updatedAt: String(value?.updatedAt || value?.createdAt || nowISO()),
  };
}

function normalizeReviewRecord(value: any): JSONStoreRecord | null {
  const id = Number(value?.id);
  const zoteroItemID = Number(value?.zoteroItemID);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(zoteroItemID)) {
    return null;
  }
  const timestamp = nowISO();
  const normalizedRecordType = normalizeRecordType(value?.recordType);
  return {
    id,
    zoteroItemID,
    recordType: normalizedRecordType,
    title: String(value?.title || ""),
    authors: String(value?.authors || ""),
    journal: String(value?.journal || ""),
    publicationDate: String(value?.publicationDate || ""),
    abstractText: String(value?.abstractText || ""),
    pdfAnnotationNotesText: String(value?.pdfAnnotationNotesText || ""),
    researchBackground: String(value?.researchBackground || ""),
    literatureReview: String(value?.literatureReview || ""),
    researchMethods: String(value?.researchMethods || ""),
    researchConclusions: String(value?.researchConclusions || ""),
    keyFindings: normalizeStringArray(value?.keyFindings),
    classificationTags: normalizeStringArray(value?.classificationTags),
    aiProvider: String(value?.aiProvider || ""),
    aiModel: String(value?.aiModel || ""),
    rawAIResponse: String(value?.rawAIResponse || ""),
    sourceRecordIDs: normalizeIDList(value?.sourceRecordIDs || []),
    sourceZoteroItemIDs: normalizePositiveIntegerList(
      value?.sourceZoteroItemIDs || [],
    ),
    createdAt: String(value?.createdAt || timestamp),
    updatedAt: String(value?.updatedAt || value?.createdAt || timestamp),
  };
}

function normalizeRecordFolderLink(
  value: any,
): JSONStoreRecordFolderLink | null {
  const recordID = Number(value?.recordID);
  const folderID = Number(value?.folderID);
  if (!Number.isFinite(recordID) || recordID <= 0) return null;
  if (!Number.isFinite(folderID) || folderID <= 0) return null;
  return {
    recordID,
    folderID,
    createdAt: String(value?.createdAt || nowISO()),
  };
}

function normalizeStoreEvent(value: any): JSONStoreEvent | null {
  const id = Number(value?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    eventName: String(value?.eventName || "unknown_event"),
    payloadJSON:
      typeof value?.payloadJSON === "string"
        ? value.payloadJSON
        : safeJSONStringify(value?.payloadJSON || {}),
    createdAt: String(value?.createdAt || nowISO()),
  };
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value
    .map((v) => String(v).trim())
    .filter(Boolean)
    .slice(0, 200);
}

function buildLiteratureRawAIResponse(
  record: Pick<
    JSONStoreRecord,
    | "title"
    | "authors"
    | "journal"
    | "publicationDate"
    | "abstractText"
    | "pdfAnnotationNotesText"
    | "researchBackground"
    | "literatureReview"
    | "researchMethods"
    | "researchConclusions"
    | "keyFindings"
    | "classificationTags"
    | "rawAIResponse"
  >,
) {
  const payload = parseJSONObject(record.rawAIResponse);
  delete payload.abstractText;
  payload.title = record.title;
  payload.authors = record.authors;
  payload.journal = record.journal;
  payload.publicationDate = record.publicationDate;
  payload.abstract = record.abstractText;
  payload.researchBackground = record.researchBackground;
  payload.literatureReview = record.literatureReview;
  payload.researchMethods = record.researchMethods;
  payload.researchConclusions = record.researchConclusions;
  payload.keyFindings = [...record.keyFindings];
  payload.classificationTags = [...record.classificationTags];
  if (String(record.pdfAnnotationNotesText || "").trim()) {
    payload.pdfAnnotationNotesText = record.pdfAnnotationNotesText;
  } else {
    delete payload.pdfAnnotationNotesText;
  }
  return JSON.stringify(payload, null, 2);
}

function parseJSONObject(text: string) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // ignore
  }
  return {} as Record<string, unknown>;
}

function normalizeRecordType(value: unknown): ReviewRecordType {
  return String(value || "").trim() === "folderSummary"
    ? "folderSummary"
    : "literature";
}

function normalizeFolderName(name: unknown) {
  return String(name || "")
    .trim()
    .slice(0, 100);
}

function normalizeIDList(ids: unknown) {
  const list = Array.isArray(ids) ? ids : [];
  return Array.from(
    new Set(
      list
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
        .map((v) => Math.floor(v)),
    ),
  );
}

function normalizePositiveIntegerList(ids: unknown) {
  const list = Array.isArray(ids) ? ids : [];
  return Array.from(
    new Set(
      list
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
        .map((v) => Math.floor(v)),
    ),
  );
}

function normalizePositiveInteger(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const v = Math.floor(n);
  return v > 0 ? v : null;
}

function normalizeNonNegativeInteger(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const v = Math.floor(n);
  return v >= 0 ? v : null;
}

function safeJSONStringify(value: unknown) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function maxID(values: number[]) {
  return values.reduce((max, value) => (value > max ? value : max), 0);
}

function csvEscape(value: string) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function nowISO() {
  return new Date().toISOString();
}

function getStoreFilePath() {
  const dataDir =
    (Zotero as any)?.DataDirectory?.dir ||
    (Zotero as any)?.Profile?.dir ||
    (addon as any)?.dataDir ||
    "";
  if (!dataDir) {
    throw new Error("无法确定 Zotero 数据目录，无法初始化 JSON 存储");
  }
  const pathUtils = (globalThis as any).PathUtils;
  if (pathUtils?.join) {
    return String(pathUtils.join(String(dataDir), STORE_FILE_NAME));
  }
  return `${String(dataDir).replace(/[\\/]+$/, "")}/${STORE_FILE_NAME}`;
}

async function tryReadTextFile(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch (e: any) {
    const msg = String(e?.message || e || "").toLowerCase();
    if (
      msg.includes("not found") ||
      msg.includes("no such file") ||
      msg.includes("ns_error_file_not_found")
    ) {
      return "";
    }
    throw e;
  }
}

async function readTextFile(path: string): Promise<string> {
  const zFile = (Zotero as any).File;
  if (zFile?.getContentsAsync) {
    return String((await zFile.getContentsAsync(path)) || "");
  }
  const ioUtils = (globalThis as any).IOUtils;
  if (ioUtils?.readUTF8) {
    return String((await ioUtils.readUTF8(path)) || "");
  }
  throw new Error("当前环境不支持读取 JSON 存储文件");
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
  throw new Error("当前环境不支持写入 JSON 存储文件");
}
