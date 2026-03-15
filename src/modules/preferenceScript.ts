import { config } from "../../package.json";
import {
  getDefaultFolderSummaryPromptTemplate,
  getDefaultReviewPromptTemplate,
} from "./reviewAI";
import {
  detectAwesomeGPT,
  detectAwesomeGPTAsync,
  getReviewSettings,
  saveReviewSettings,
} from "./reviewConfig";

export async function registerPrefsScripts(_window: Window) {
  addon.data.prefs = { window: _window };
  initPrefsUI(_window);
}

function initPrefsUI(win: Window) {
  const doc = win.document;
  const settings = getReviewSettings();
  const detection = detectAwesomeGPT();

  const usePDFAsInputSourceInput = getEl<HTMLInputElement>(
    doc,
    id("use-pdf-as-input-source"),
  );
  const usePDFAnnotationsAsContextInput = getEl<HTMLInputElement>(
    doc,
    id("use-pdf-annotations-as-context"),
  );
  const importPDFAnnotationsAsFieldInput = getEl<HTMLInputElement>(
    doc,
    id("import-pdf-annotations-as-field"),
  );
  const enablePDFInputTruncationInput = getEl<HTMLInputElement>(
    doc,
    id("enable-pdf-input-truncation"),
  );
  const pdfTextMaxCharsInput = getEl<HTMLInputElement>(
    doc,
    id("pdf-text-max-chars"),
  );
  const pdfAnnotationTextMaxCharsInput = getEl<HTMLInputElement>(
    doc,
    id("pdf-annotation-text-max-chars"),
  );
  const pdfTruncationConfig = getEl<HTMLElement>(
    doc,
    id("pdf-truncation-config"),
  );
  const customPromptInput = getEl<HTMLTextAreaElement>(
    doc,
    id("custom-prompt"),
  );
  const defaultPromptView = getEl<HTMLTextAreaElement>(
    doc,
    id("default-prompt"),
  );
  const customFolderSummaryPromptInput = getEl<HTMLTextAreaElement>(
    doc,
    id("custom-folder-summary-prompt"),
  );
  const defaultFolderSummaryPromptView = getEl<HTMLTextAreaElement>(
    doc,
    id("default-folder-summary-prompt"),
  );
  const detectionStatus = getEl<HTMLElement>(doc, id("awesome-status"));
  const detectionDetail = getEl<HTMLElement>(doc, id("awesome-detail"));
  const saveBtn = getEl<HTMLButtonElement>(doc, id("save-btn"));
  const refreshBtn = getEl<HTMLButtonElement>(doc, id("refresh-detection-btn"));
  const savePromptBtn = getEl<HTMLButtonElement>(
    doc,
    id("refresh-prompt-view-btn"),
  );

  usePDFAsInputSourceInput.checked = Boolean(settings.usePDFAsInputSource);
  usePDFAnnotationsAsContextInput.checked = Boolean(
    settings.usePDFAnnotationsAsContext,
  );
  importPDFAnnotationsAsFieldInput.checked = Boolean(
    settings.importPDFAnnotationsAsField,
  );
  enablePDFInputTruncationInput.checked = Boolean(
    settings.enablePDFInputTruncation,
  );
  pdfTextMaxCharsInput.value = String(settings.pdfTextMaxChars);
  pdfAnnotationTextMaxCharsInput.value = String(
    settings.pdfAnnotationTextMaxChars,
  );
  customPromptInput.value = settings.customPromptTemplate;
  defaultPromptView.value = getDefaultReviewPromptTemplate();
  customFolderSummaryPromptInput.value =
    settings.customFolderSummaryPromptTemplate;
  defaultFolderSummaryPromptView.value =
    getDefaultFolderSummaryPromptTemplate();
  syncPDFTruncationConfigState(
    enablePDFInputTruncationInput,
    pdfTruncationConfig,
  );

  renderAwesomeStatus(detectionStatus, detectionDetail, detection);
  void refreshAwesomeDetectionStatus(detectionStatus, detectionDetail);

  refreshBtn.onclick = () => {
    void refreshAwesomeDetectionStatus(detectionStatus, detectionDetail);
  };

  enablePDFInputTruncationInput.onchange = () => {
    syncPDFTruncationConfigState(
      enablePDFInputTruncationInput,
      pdfTruncationConfig,
    );
  };

  const persistSettings = () => {
    const current = getReviewSettings();
    const truncationEnabled = enablePDFInputTruncationInput.checked;
    return saveReviewSettings({
      modelConfigMode: "awesomegpt",
      apiConfigMode: "zoterogpt",
      provider: "openai",
      usePDFAsInputSource: usePDFAsInputSourceInput.checked,
      usePDFAnnotationsAsContext: usePDFAnnotationsAsContextInput.checked,
      importPDFAnnotationsAsField: importPDFAnnotationsAsFieldInput.checked,
      enablePDFInputTruncation: truncationEnabled,
      ...(truncationEnabled
        ? {
            pdfTextMaxChars: Math.max(
              1,
              Math.floor(
                Number(pdfTextMaxCharsInput.value) ||
                  current.pdfTextMaxChars ||
                  20_000,
              ),
            ),
            pdfAnnotationTextMaxChars: Math.max(
              1,
              Math.floor(
                Number(pdfAnnotationTextMaxCharsInput.value) ||
                  current.pdfAnnotationTextMaxChars ||
                  12_000,
              ),
            ),
          }
        : {}),
      customPromptTemplate: customPromptInput.value.trim(),
      customFolderSummaryPromptTemplate:
        customFolderSummaryPromptInput.value.trim(),
    });
  };

  saveBtn.onclick = () => {
    try {
      persistSettings();
      win.alert("配置已保存");
    } catch (e: any) {
      win.alert(`保存失败：${e?.message || e}`);
    }
  };

  savePromptBtn.onclick = () => {
    try {
      saveReviewSettings({
        customPromptTemplate: customPromptInput.value.trim(),
        customFolderSummaryPromptTemplate:
          customFolderSummaryPromptInput.value.trim(),
      });
      win.alert("Prompt 配置已保存");
    } catch (e: any) {
      win.alert(`保存 Prompt 配置失败：${e?.message || e}`);
    }
  };
}

function renderAwesomeStatus(
  statusEl: HTMLElement,
  detailEl: HTMLElement,
  detection: ReturnType<typeof detectAwesomeGPT>,
) {
  const pluginName = detection.addonName || "GPT 插件";
  if (detection.callable) {
    statusEl.textContent = `已连接 ${pluginName}`;
    statusEl.style.color = "#047857";
    detailEl.textContent = `${pluginName} 可直接使用`;
    return;
  }

  if (detection.installed) {
    statusEl.textContent = `已检测到 ${pluginName}（暂不可直连）`;
    statusEl.style.color = "#b45309";
    detailEl.textContent =
      detection.obstacle || "已检测到插件，但当前无法直接调用。";
    return;
  }

  statusEl.textContent = "未检测到兼容 GPT 插件";
  statusEl.style.color = "#6b7280";
  detailEl.textContent = "请先安装并配置 Zotero GPT 插件。";
}

function toggleCustomFields(container: HTMLElement, enabled: boolean) {
  container.style.opacity = enabled ? "1" : "0.55";
  const inputs = container.querySelectorAll("input, select, textarea");
  inputs.forEach((el: Element) => {
    (
      el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    ).disabled = !enabled;
  });
}

function syncPDFTruncationConfigState(
  enabledInput: HTMLInputElement,
  configEl: HTMLElement,
) {
  toggleCustomFields(configEl, enabledInput.checked);
}

function id(suffix: string) {
  return `zotero-prefpane-${config.addonRef}-${suffix}`;
}

function getEl<T extends Element>(doc: Document, selector: string) {
  const el = doc.getElementById(selector);
  if (!el) {
    throw new Error(`Preference element not found: ${selector}`);
  }
  return el as T;
}

async function refreshAwesomeDetectionStatus(
  statusEl: HTMLElement,
  detailEl: HTMLElement,
) {
  statusEl.textContent = "正在检查兼容 GPT 插件...";
  statusEl.style.color = "#1d4ed8";
  detailEl.textContent = "正在检查插件状态，请稍候。";
  try {
    const next = await detectAwesomeGPTAsync();
    renderAwesomeStatus(statusEl, detailEl, next);
  } catch (e: any) {
    statusEl.textContent = "检测失败";
    statusEl.style.color = "#b91c1c";
    detailEl.textContent = `无法完成插件检测：${String(e?.message || e)}`;
  }
}
