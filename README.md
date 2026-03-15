# Zotero-Exitem

[![zotero target version](https://img.shields.io/badge/Zotero-8-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero-Exitem is a Zotero plugin for AI-assisted literature extraction, review management, synthesis, and export.

[English](README.md) | [简体中文](doc/README-zhCN.md) | [Français](doc/README-frFR.md)

## Preview

![Plugin Preview](./doc/images/preview-icon.png)

## Prerequisites

- Zotero 8
- Installed and configured `zotero-gpt` plugin:
  - Project: https://github.com/MuiseDestiny/zotero-gpt
  - Setup guide (Chinese): https://zotero-chinese.com/user-guide/plugins/zotero-gpt
- For PDF-related processing, `zotero-gpt` must have both:
  - a main chat/completion model
  - an embedding model

## Installation

1. Download the `.xpi` package from this project release/build output.
2. In Zotero: `Tools` -> `Plugins` -> gear icon -> `Install Plugin From File...`
3. Select `zotero-exitem.xpi`.
4. Restart Zotero.

## Tutorial (Step by Step)

In a typical literature-review workflow, you can first run single-item extraction to generate an initial summary, read the paper with that summary, add highlights/annotations, and then run single-item extraction again. Highlighted text and annotation notes are automatically synced into AI extraction fields and used as synthesis sources, helping avoid missing key information in PDFs.

A full flow is: `Preferences setup` -> `Single/Batch extraction` -> `Review Manager` -> `Folder synthesis` -> `Edit and export`.

### 1. Check GPT connection and extraction input strategy first

- Go to `Settings -> Zotero-Exitem`.
- Confirm the GPT compatibility check shows connected.
- Configure extraction inputs based on your workflow: include PDF full text, include PDF annotations/annotation notes, and import annotation text into a dedicated field.
- Exitem prioritizes user-provided signals: PDF highlights and annotation notes are stored as key inputs and reused as synthesis sources.

![Preferences: connection check and extraction input controls](./doc/images/首先项-连接状态检查与传入参数控制界面.png)

### 2. Configure extraction prompt and folder-synthesis prompt

- Edit custom prompts in preferences (for both extraction and folder synthesis).
- Click `保存 Prompt 配置` to save the current configuration.
- Prompts now affect AI extraction and folder synthesis output only; they no longer control which columns appear in the literature table.

### 3. Single-item extraction

- In the Zotero main view, select one item and click `AI提炼文献内容` from the right-click menu.
- The plugin runs extraction through your configured `zotero-gpt` models.
- Extraction progress is shown in a single progress window; on success, the record is saved automatically into the `我的记录` folder.

![Single-item extraction entry](./doc/images/单条文献提取操作.png)

### 4. Batch extraction (up to 5 items per run)

- Multi-select items in Zotero, then click `AI提炼文献内容`.
- It is recommended to confirm selected items have usable metadata/PDFs before running.

![Batch extraction entry](./doc/images/批量文献提取操作.png)

### 5. Open Review Manager

- Click the Exitem icon in Zotero's top toolbar to open Review Manager.
- Review Manager opens as an embedded tab inside the Zotero main window.

![Open Review Manager](./doc/images/打开文献综述管理页面.png)

### 6. Review Manager basics

- Left panel: folders. Center: record list. Bottom: content preview.
- Top toolbar supports refresh, folder operations, record operations, edit record, generate note, and export.

![Review Manager overview](./doc/images/文献综述管理界面展示.png)

### 7. Switch between "Literature Records" and "Folder Synthesis"

- Use the view toggle to switch between extracted records and synthesized records.

![Switch views: records/synthesis](./doc/images/切换视图.png)

### 8. Add records into a target folder

- Select records in `文献记录`.
- Select a folder on the left, then click `加入文件夹` for batch assignment.

![Add literature records to folder](./doc/images/将文献记录加入到文件夹.png)

### 9. Run folder synthesis

- Select a folder and click `合并综述`.
- By default, the plugin synthesizes all single-item records under that folder into one synthesis record.

![Run folder synthesis](./doc/images/合并综述操作.png)

### 10. View and edit records (both record types)

- Select a target record and click `编辑记录`.
- You can revise extracted fields directly before saving for reuse, export, or note generation.

![Open record editor from manager](./doc/images/查看原始记录并编辑.png)

![Record editor](./doc/images/原始记录编辑界面.png)

### 11. Generate native Zotero notes

- In the `文献记录` view, select one or more records and click `生成笔记`.
- The plugin creates native child notes under the corresponding Zotero items instead of generating separate files.
- Note content is built from the current Exitem record and written into Zotero after being organized into a Markdown-friendly structure.
- These notes are saved as native Zotero data, so they remain available in Zotero's own note system.

### 12. Export results

- Click `导出表格` in Review Manager to export CSV under the current view/filter scope.

## Current Features

- Trigger extraction from Zotero item context menu: `AI提炼文献内容`
- Single-item extraction:
  - uses a single progress window with live stage updates
  - auto-saves successful results into the `我的记录` folder
- Batch extraction:
  - supports up to 5 items per run
  - auto-saves successful results to a folder and opens Review Manager
- Extraction input composition (configurable):
  - item metadata, abstract, notes
  - optional PDF full text
  - optional PDF annotations and annotation notes
  - optional import of PDF annotation text into an independent record field
- Prompt system:
  - custom literature extraction prompt
  - custom folder-synthesis prompt (`合并综述`)
  - preferences action to save prompt settings
- Review Manager UI:
  - entry from toolbar button, opening as an embedded Zotero tab
  - dual view: `文献记录` and `合并综述`
  - fixed view switch controls and record detail preview panel
  - fixed literature-table columns for extracted fields
- Folder and record management:
  - create/delete/merge folders
  - add/remove record-folder membership (supports multi-folder membership)
  - search, sort, multi-select, and bulk delete
  - title column links back to the original Zotero item
- Synthesis and export:
  - folder-level synthesis (`合并综述`) with progress feedback
  - persisted summary records with source tracing (`sourceRecordIDs`, `sourceZoteroItemIDs`)
  - batch creation of native Zotero child notes from `文献记录`
  - note content generated from Exitem records and stored natively under Zotero items
  - record viewer/editor
  - CSV export for current view/filter scope
- Storage:
  - independent JSON storage file in Zotero data directory: `exitem-review-store.json`
  - local event logging (for actions such as extraction, synthesis, export)

## Runtime Path

- AI calls are bridged through installed `zotero-gpt` runtime/configuration.
