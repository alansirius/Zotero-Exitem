import { registerPrefsScripts } from "./modules/preferenceScript";
import { trackReviewEvent } from "./modules/reviewStore";
import {
  cleanupReviewFeatureUI,
  initializeReviewFeature,
  registerReviewContextMenu,
  registerReviewToolbarButton,
  unregisterReviewToolbarButton,
} from "./modules/reviewUI";
import { getString, initLocale } from "./utils/locale";

let prefsRegistered = false;

async function onStartup() {
  try {
    await Promise.all(
      [
        Zotero.initializationPromise,
        (Zotero as any).unlockPromise,
        (Zotero as any).uiReadyPromise,
      ].filter(Boolean),
    );
  } catch (e) {
    ztoolkit.log("Startup wait promises failed", e);
  }

  try {
    initLocale();
  } catch (e) {
    ztoolkit.log("Locale init failed; continuing startup", e);
  }
  try {
    registerPreferencePane();
  } catch (e) {
    ztoolkit.log("Preference pane registration failed", e);
  }
  try {
    await initializeReviewFeature();
  } catch (e) {
    ztoolkit.log("Review feature init failed; continuing startup", e);
  }

  const mainWindows = getMainWindowsCompat();
  await Promise.all(
    mainWindows.map(async (win) => {
      try {
        await onMainWindowLoad(win);
      } catch (e) {
        ztoolkit.log("Main window load hook failed", e);
      }
    }),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  try {
    win.MozXULElement.insertFTLIfNeeded(
      `${addon.data.config.addonRef}-mainWindow.ftl`,
    );
  } catch (e) {
    ztoolkit.log("insertFTLIfNeeded failed", e);
  }

  registerReviewToolbarButton(win);
  registerReviewContextMenu(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterReviewToolbarButton(win);
}

function onShutdown(): void {
  cleanupReviewFeatureUI();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "load") {
    void trackReviewEvent("plugin_open", {
      timestamp: new Date().toISOString(),
      source: "preferences",
    }).catch((e) => ztoolkit.log(e));
    await registerPrefsScripts(data.window);
  }
}

function onShortcuts(_type: string) {
  // Reserved for future keyboard shortcuts
}

function onDialogEvents(_type: string) {
  // Dialog events are handled inside dedicated modules
}

function registerPreferencePane() {
  if (prefsRegistered) return;
  const preferencePanes = (Zotero as any).PreferencePanes;
  if (typeof preferencePanes?.register !== "function") {
    ztoolkit.log("PreferencePanes.register is unavailable in this Zotero");
    return;
  }
  preferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
  prefsRegistered = true;
}

function getMainWindowsCompat(): _ZoteroTypes.MainWindow[] {
  const getMainWindows = (Zotero as any)?.getMainWindows;
  if (typeof getMainWindows === "function") {
    const wins = getMainWindows.call(Zotero);
    if (Array.isArray(wins)) {
      return wins as _ZoteroTypes.MainWindow[];
    }
  }

  const getMainWindow = (Zotero as any)?.getMainWindow;
  if (typeof getMainWindow === "function") {
    const win = getMainWindow.call(Zotero);
    if (win) return [win as _ZoteroTypes.MainWindow];
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
    ztoolkit.log("Window mediator fallback failed", e);
  }

  return [];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
