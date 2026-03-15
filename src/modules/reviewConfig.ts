import { clearPref, getPref, setPref } from "../utils/prefs";
import {
  AwesomeGPTDetection,
  ReviewSettings,
  ZoteroGPTPrefsSnapshot,
} from "./reviewTypes";

const DEFAULTS: ReviewSettings = {
  modelConfigMode: "awesomegpt",
  apiConfigMode: "zoterogpt",
  provider: "openai",
  api: "https://api.openai.com",
  secretKey: "",
  model: "zotero-gpt",
  temperature: 1.0,
  embeddingModel: "text-embedding-ada-002",
  embeddingBatchNum: 10,
  timeoutSeconds: 600,
  usePDFAsInputSource: true,
  usePDFAnnotationsAsContext: true,
  importPDFAnnotationsAsField: true,
  enablePDFInputTruncation: false,
  pdfTextMaxChars: 20_000,
  pdfAnnotationTextMaxChars: 12_000,
  customPromptTemplate: "",
  customFolderSummaryPromptTemplate: "",
};

const AWESOME_GPT_DETECTION_CACHE_TTL_MS = 15_000;

let awesomeGPTDetectionCache: {
  expiresAt: number;
  result: AwesomeGPTDetection;
} | null = null;

export function getReviewSettings(): ReviewSettings {
  const snapshot = getZoteroGPTPrefsSnapshot();

  return {
    modelConfigMode: "awesomegpt",
    apiConfigMode: "zoterogpt",
    provider: "openai",
    api: snapshot?.api || DEFAULTS.api,
    secretKey: snapshot?.secretKey || "",
    model: snapshot?.model || DEFAULTS.model,
    temperature: snapshot?.temperature ?? DEFAULTS.temperature,
    embeddingModel: snapshot?.embeddingModel || DEFAULTS.embeddingModel,
    embeddingBatchNum:
      snapshot?.embeddingBatchNum || DEFAULTS.embeddingBatchNum,
    timeoutSeconds: Math.max(
      DEFAULTS.timeoutSeconds,
      normalizeInt(getPref("timeoutSeconds"), DEFAULTS.timeoutSeconds),
    ),
    usePDFAsInputSource: normalizeBool(
      getPref("usePDFAsInputSource"),
      DEFAULTS.usePDFAsInputSource,
    ),
    usePDFAnnotationsAsContext: normalizeBool(
      getPref("usePDFAnnotationsAsContext"),
      DEFAULTS.usePDFAnnotationsAsContext,
    ),
    importPDFAnnotationsAsField: normalizeBool(
      getPref("importPDFAnnotationsAsField"),
      DEFAULTS.importPDFAnnotationsAsField,
    ),
    enablePDFInputTruncation: normalizeBool(
      getPref("enablePDFInputTruncation"),
      DEFAULTS.enablePDFInputTruncation,
    ),
    pdfTextMaxChars: Math.max(
      1,
      normalizeInt(getPref("pdfTextMaxChars"), DEFAULTS.pdfTextMaxChars),
    ),
    pdfAnnotationTextMaxChars: Math.max(
      1,
      normalizeInt(
        getPref("pdfAnnotationTextMaxChars"),
        DEFAULTS.pdfAnnotationTextMaxChars,
      ),
    ),
    customPromptTemplate: String(
      getPref("customPromptTemplate") || DEFAULTS.customPromptTemplate,
    ).trim(),
    customFolderSummaryPromptTemplate: String(
      getPref("customFolderSummaryPromptTemplate") ||
        DEFAULTS.customFolderSummaryPromptTemplate,
    ).trim(),
  };
}

export function saveReviewSettings(input: Partial<ReviewSettings>) {
  const current = getReviewSettings();
  const next: ReviewSettings = {
    ...current,
    ...input,
    modelConfigMode: "awesomegpt",
    apiConfigMode: "zoterogpt",
    provider: "openai",
  };

  setPref("modelConfigMode", "awesomegpt");
  setPref("apiConfigMode", "zoterogpt");
  setPref("provider", "openai");
  setPref(
    "timeoutSeconds",
    Math.max(
      DEFAULTS.timeoutSeconds,
      normalizeInt(next.timeoutSeconds, DEFAULTS.timeoutSeconds),
    ),
  );
  setPref("usePDFAsInputSource", Boolean(next.usePDFAsInputSource));
  setPref(
    "usePDFAnnotationsAsContext",
    Boolean(next.usePDFAnnotationsAsContext),
  );
  setPref(
    "importPDFAnnotationsAsField",
    Boolean(next.importPDFAnnotationsAsField),
  );
  const truncationEnabled = Boolean(next.enablePDFInputTruncation);
  setPref("enablePDFInputTruncation", truncationEnabled);
  if (truncationEnabled) {
    setPref(
      "pdfTextMaxChars",
      Math.max(1, normalizeInt(next.pdfTextMaxChars, 20_000)),
    );
    setPref(
      "pdfAnnotationTextMaxChars",
      Math.max(1, normalizeInt(next.pdfAnnotationTextMaxChars, 12_000)),
    );
  } else {
    clearPref("pdfTextMaxChars");
    clearPref("pdfAnnotationTextMaxChars");
  }
  setPref("customPromptTemplate", next.customPromptTemplate);
  setPref(
    "customFolderSummaryPromptTemplate",
    next.customFolderSummaryPromptTemplate,
  );
  return next;
}

export function getZoteroGPTPrefsSnapshot(): ZoteroGPTPrefsSnapshot | null {
  try {
    const base = "extensions.zotero.zoterogpt";
    const prefs = (Zotero as any)?.Prefs;
    if (!prefs?.get) return null;

    const api = normalizeAPIBase(String(prefs.get(`${base}.api`) || "").trim());
    const secretKey = String(prefs.get(`${base}.secretKey`) || "").trim();
    const model = String(prefs.get(`${base}.model`) || "").trim();
    const temperature = normalizeFloat(
      prefs.get(`${base}.temperature`),
      1.0,
      0,
      2,
    );
    const embeddingBatchNum = Math.max(
      1,
      normalizeInt(
        prefs.get(`${base}.embeddingBatchNum`),
        DEFAULTS.embeddingBatchNum,
      ),
    );

    // zotero-gpt currently hard-codes this model in Meet/OpenAI.ts
    const embeddingModel = "text-embedding-ada-002";

    if (!api && !secretKey && !model) return null;
    return {
      api: api || DEFAULTS.api,
      secretKey,
      model: model || DEFAULTS.model,
      temperature,
      embeddingModel,
      embeddingBatchNum,
      source: "zoterogpt",
    };
  } catch {
    return null;
  }
}

export function getEffectiveReviewAPISettings(settings = getReviewSettings()) {
  const snapshot = getZoteroGPTPrefsSnapshot();
  if (!snapshot) {
    return {
      ...settings,
      modelConfigMode: "awesomegpt" as const,
      apiConfigMode: "zoterogpt" as const,
      provider: "openai" as const,
    };
  }

  return {
    ...settings,
    modelConfigMode: "awesomegpt" as const,
    apiConfigMode: "zoterogpt" as const,
    provider: "openai" as const,
    api: snapshot.api,
    secretKey: snapshot.secretKey,
    model: snapshot.model,
    temperature: snapshot.temperature,
    embeddingModel: snapshot.embeddingModel,
    embeddingBatchNum: snapshot.embeddingBatchNum,
  };
}

export function detectAwesomeGPT(): AwesomeGPTDetection {
  const mainWin = getPrimaryMainWindowSafe();
  const zoteroGPT = (Zotero as any)?.ZoteroGPT;
  const meet = (mainWin as any)?.Meet || (globalThis as any)?.window?.Meet;
  if (zoteroGPT || meet) {
    const meetCallable = typeof meet?.OpenAI?.getGPTResponse === "function";
    const viewsReady = Boolean(zoteroGPT?.views);
    return {
      installed: true,
      source: "Zotero.ZoteroGPT / window.Meet",
      addonName: "Zotero GPT",
      callable: meetCallable && viewsReady,
      detail: [
        zoteroGPT ? "检测到 Zotero.ZoteroGPT" : "",
        meet ? "检测到 window.Meet" : "",
        viewsReady ? "views 已初始化" : "views 未初始化",
      ]
        .filter(Boolean)
        .join("，"),
      obstacle:
        meetCallable && viewsReady
          ? "当前通过 zotero-gpt 的内部 Meet API 兼容桥接，接口可能随版本变化。"
          : "zotero-gpt 已安装，但其内部 API 尚未完全就绪（可能需要其界面先初始化）。",
    };
  }

  const candidates: Array<[string, any]> = [
    ["Zotero.AwesomeGPT", (Zotero as any)?.AwesomeGPT],
    ["Zotero.GPT", (Zotero as any)?.GPT],
    ["window.AwesomeGPT", (globalThis as any)?.AwesomeGPT],
    ["window.awesomeGPT", (globalThis as any)?.awesomeGPT],
  ];

  for (const [source, value] of candidates) {
    if (value) {
      return {
        installed: true,
        source,
        addonName: "Awesome GPT",
        callable: true,
        detail:
          typeof value === "object"
            ? Object.keys(value).join(", ")
            : typeof value,
      };
    }
  }

  try {
    const maybeAddonManager = (globalThis as any).AddonManager;
    if (maybeAddonManager?.getAddonByID) {
      return {
        installed: false,
        source: "AddonManager",
        callable: false,
        detail: "可访问插件管理器，但未发现可直接调用接口",
        obstacle: "兼容 GPT 插件未必对外暴露全局 API，自动调用可能受限",
      };
    }
  } catch {
    // ignore
  }

  return {
    installed: false,
    source: "not-found",
    callable: false,
    obstacle:
      "未发现运行时接口；如果 GPT 插件未暴露全局 API，本插件无法直接调用",
  };
}

export async function detectAwesomeGPTAsync(): Promise<AwesomeGPTDetection> {
  const runtime = detectAwesomeGPT();
  if (runtime.callable) {
    return runtime;
  }

  if (
    awesomeGPTDetectionCache &&
    awesomeGPTDetectionCache.expiresAt > Date.now()
  ) {
    return awesomeGPTDetectionCache.result;
  }

  const addonManager = await getAddonManagerSafe();
  if (!addonManager) {
    const result = {
      ...runtime,
      detail:
        runtime.detail ||
        "当前环境无法访问 AddonManager，无法进一步确认是否已安装兼容 GPT 插件",
    };
    awesomeGPTDetectionCache = {
      expiresAt: Date.now() + AWESOME_GPT_DETECTION_CACHE_TTL_MS,
      result,
    };
    return result;
  }

  try {
    const addons: any[] = await getAllExtensions(addonManager);
    const match = addons.find((addon) => {
      const name = String(addon?.name || "");
      const id = String(addon?.id || "");
      return /(awesome\s*gpt|zotero\s*gpt|gpt\s+meet\s+zotero)/i.test(
        `${name} ${id}`,
      );
    });

    if (!match) {
      const result = {
        ...runtime,
        detail: "在已安装扩展列表中未发现兼容 GPT 插件",
      };
      awesomeGPTDetectionCache = {
        expiresAt: Date.now() + AWESOME_GPT_DETECTION_CACHE_TTL_MS,
        result,
      };
      return result;
    }

    const result = {
      installed: true,
      source: "AddonManager",
      callable: false,
      addonID: String(match.id || ""),
      addonName: String(match.name || "GPT 插件"),
      detail: `已检测到插件：${String(match.name || "GPT 插件")}`,
      obstacle:
        "已安装但未检测到可调用接口，请确认 Zotero GPT 版本与运行时状态。",
    };
    awesomeGPTDetectionCache = {
      expiresAt: Date.now() + AWESOME_GPT_DETECTION_CACHE_TTL_MS,
      result,
    };
    return result;
  } catch (e: any) {
    const result = {
      ...runtime,
      detail: `读取已安装插件列表失败：${String(e?.message || e)}`,
      obstacle: "无法通过 AddonManager 确认 GPT 插件安装状态",
    };
    awesomeGPTDetectionCache = {
      expiresAt: Date.now() + AWESOME_GPT_DETECTION_CACHE_TTL_MS,
      result,
    };
    return result;
  }
}

export function isCustomAIConfigured(_settings = getReviewSettings()) {
  const snapshot = getZoteroGPTPrefsSnapshot();
  return Boolean(snapshot?.secretKey && snapshot?.model);
}

function normalizeInt(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

function normalizeBool(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

function normalizeFloat(
  value: unknown,
  fallback: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeAPIBase(value: string) {
  const text = String(value || "").trim();
  if (!text) return DEFAULTS.api;
  return text.replace(/\/(?:v1)?\/?$/, "");
}

async function getAddonManagerSafe(): Promise<any | null> {
  const globalAddonManager = (globalThis as any).AddonManager;
  if (globalAddonManager) return globalAddonManager;

  try {
    const chromeUtils = (globalThis as any).ChromeUtils;
    if (chromeUtils?.importESModule) {
      const mod = chromeUtils.importESModule(
        "resource://gre/modules/AddonManager.sys.mjs",
      );
      if (mod?.AddonManager) return mod.AddonManager;
    }
  } catch {
    // ignore
  }

  return null;
}

function getPrimaryMainWindowSafe() {
  try {
    const getMainWindows = (Zotero as any)?.getMainWindows;
    if (typeof getMainWindows === "function") {
      const wins = getMainWindows.call(Zotero);
      if (Array.isArray(wins) && wins.length) return wins[0] as any;
    }
    const getMainWindow = (Zotero as any)?.getMainWindow;
    if (typeof getMainWindow === "function") {
      return (getMainWindow.call(Zotero) as any) || null;
    }
    const wm = (globalThis as any)?.Services?.wm;
    if (wm?.getMostRecentWindow) {
      return (wm.getMostRecentWindow("zotero:main") as any) || null;
    }
    return null;
  } catch {
    return null;
  }
}

async function getAllExtensions(addonManager: any): Promise<any[]> {
  if (typeof addonManager.getAddonsByTypes === "function") {
    return (await addonManager.getAddonsByTypes(["extension"])) || [];
  }
  if (typeof addonManager.getAllAddons === "function") {
    const addons = (await addonManager.getAllAddons()) || [];
    return addons.filter(
      (addon: any) => String(addon?.type || "") === "extension",
    );
  }
  return [];
}
