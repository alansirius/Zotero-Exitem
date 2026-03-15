# Zotero-Exitem

[![zotero target version](https://img.shields.io/badge/Zotero-8-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero-Exitem est un plugin Zotero pour l'extraction IA de références, la gestion de revues, la synthèse de dossiers et l'export.

[English](../README.md) | [简体中文](README-zhCN.md) | [Français](README-frFR.md)

## Apercu

![Apercu du plugin](./images/preview-icon.png)

## Prérequis

- Zotero 8
- Plugin `zotero-gpt` installé et configuré :
  - Projet : https://github.com/MuiseDestiny/zotero-gpt
  - Guide de configuration (chinois) : https://zotero-chinese.com/user-guide/plugins/zotero-gpt
- Pour le traitement PDF, `zotero-gpt` doit configurer :
  - un modèle principal (chat/complétion)
  - un modèle d'embedding

## Installation

1. Téléchargez le fichier `.xpi` depuis la release ou la sortie de build.
2. Dans Zotero : `Outils` -> `Plugins` -> icône engrenage -> `Install Plugin From File...`
3. Sélectionnez `zotero-exitem.xpi`.
4. Redémarrez Zotero.

## Tutoriel (pas a pas)

Dans un flux de revue de littérature, vous pouvez d'abord lancer une extraction unitaire pour générer un premier résumé, lire l'article avec ce résumé, ajouter des surlignages/annotations, puis relancer l'extraction unitaire. Les passages surlignés et les notes d'annotation sont automatiquement synchronisés dans les champs d'extraction IA et réutilisés comme sources de synthèse, afin de limiter les oublis d'informations importantes du PDF.

Flux complet recommande : `Configuration des préférences` -> `Extraction unitaire/lot` -> `Gestionnaire de revue` -> `Synthèse de dossier` -> `Edition et export`.

### 1. Verifier la connexion GPT et la strategie d'entree

- Ouvrez `Paramètres -> Zotero-Exitem`.
- Vérifiez que le contrôle de compatibilité GPT indique un état connecté.
- Configurez les entrées d'extraction selon votre usage : texte PDF complet, annotations/notes d'annotation et import du texte d'annotation dans un champ dédié.
- Exitem met en avant les signaux saisis par l'utilisateur : surlignages PDF et notes d'annotation sont stockés comme entrées importantes et réutilisés pour la synthèse.

![Préférences : connexion et paramètres d'entrée](./images/首先项-连接状态检查与传入参数控制界面.png)

### 2. Configurer les prompts d'extraction et de synthese

- Éditez les prompts personnalisés dans les préférences (extraction et synthèse de dossier).
- Cliquez sur `保存 Prompt 配置` pour enregistrer la configuration actuelle.
- Les prompts influencent désormais uniquement le contenu généré par l'extraction IA et la synthèse de dossier ; ils ne pilotent plus les colonnes de la vue littérature.

### 3. Extraction unitaire

- Dans la vue principale Zotero, sélectionnez un item puis cliquez sur `AI提炼文献内容` dans le menu contextuel.
- Le plugin exécute l'extraction via les modèles `zotero-gpt` configurés.
- La progression s'affiche dans une seule fenêtre de progression ; en cas de succès, la fiche est enregistrée automatiquement dans le dossier `我的记录`.

![Entrée extraction unitaire](./images/单条文献提取操作.png)

### 4. Extraction par lot (jusqu'a 5 items par execution)

- Sélectionnez plusieurs items dans Zotero puis cliquez sur `AI提炼文献内容`.
- Il est recommandé de vérifier que les items sélectionnés possèdent des métadonnées/PDF exploitables avant lancement.

![Entrée extraction par lot](./images/批量文献提取操作.png)

### 5. Ouvrir le gestionnaire de revue

- Cliquez sur l'icône Exitem dans la barre d'outils supérieure de Zotero pour ouvrir le gestionnaire.
- Le gestionnaire s'ouvre sous forme d'onglet intégré dans la fenêtre principale de Zotero.

![Ouvrir le gestionnaire de revue](./images/打开文献综述管理页面.png)

### 6. Prise en main du gestionnaire

- Panneau gauche : dossiers. Centre : liste des enregistrements. Bas : aperçu du contenu.
- La barre d'outils supérieure permet l'actualisation, les opérations sur les dossiers et les fiches, l'édition des fiches, la génération de notes et l'export.

![Vue d'ensemble du gestionnaire](./images/文献综述管理界面展示.png)

### 7. Basculer entre vues "Fiches litterature" et "Synthese"

- Utilisez le sélecteur de vue pour passer des fiches extraites aux enregistrements de synthèse.

![Basculer entre vues](./images/切换视图.png)

### 8. Ajouter des fiches dans un dossier cible

- Sélectionnez des fiches dans `文献记录`.
- Sélectionnez un dossier à gauche puis cliquez sur `加入文件夹` pour un classement par lot.

![Ajouter des fiches au dossier](./images/将文献记录加入到文件夹.png)

### 9. Lancer la synthese de dossier

- Sélectionnez un dossier puis cliquez sur `合并综述`.
- Par défaut, le plugin synthétise toutes les fiches unitaires du dossier en un enregistrement de synthèse.

![Lancer la synthèse de dossier](./images/合并综述操作.png)

### 10. Voir et editer les enregistrements

- Sélectionnez un enregistrement puis cliquez sur `编辑记录`.
- Vous pouvez modifier directement les champs extraits avant sauvegarde pour la réutilisation, l'export ou la génération de notes.

![Ouvrir l'éditeur d'enregistrement](./images/查看原始记录并编辑.png)

![Interface d'édition de l'enregistrement](./images/原始记录编辑界面.png)

### 11. Générer des notes Zotero natives

- Dans la vue `文献记录`, sélectionnez une ou plusieurs fiches puis cliquez sur `生成笔记`.
- Le plugin crée des notes enfants natives sous les items Zotero correspondants, sans générer de fichiers séparés.
- Le contenu de la note est construit à partir de la fiche Exitem courante puis écrit dans Zotero après mise en forme en structure Markdown.
- Ces notes sont enregistrées comme données natives de Zotero et restent disponibles dans le système de notes de Zotero.

### 12. Exporter les resultats

- Cliquez sur `导出表格` dans le gestionnaire pour exporter un CSV selon la vue et les filtres courants.

## Fonctionnalités actuelles

- Déclenchement de l'extraction depuis le menu contextuel Zotero : `AI提炼文献内容`
- Extraction unitaire :
  - utilise une seule fenêtre de progression avec mise à jour des étapes en temps réel
  - enregistre automatiquement les réussites dans le dossier `我的记录`
- Extraction par lot :
  - jusqu'à 5 documents par exécution
  - sauvegarde automatique des succès dans un dossier puis ouverture du gestionnaire
- Composition des entrées d'extraction (configurable) :
  - métadonnées de l'item, résumé, notes
  - texte PDF complet (optionnel)
  - annotations PDF et notes d'annotation (optionnel)
  - import optionnel du texte d'annotation PDF dans un champ dédié
- Système de prompts :
  - prompt d'extraction personnalisable
  - prompt de synthèse de dossier (`合并综述`) personnalisable
  - action de préférences pour enregistrer la configuration des prompts
- Interface du gestionnaire de revue :
  - entrée via le bouton de barre d'outils, avec ouverture dans un onglet intégré Zotero
  - double vue : `文献记录` et `合并综述`
  - contrôles de bascule fixes et panneau d'aperçu détaillé
  - colonnes fixes pour la vue littérature
- Gestion des dossiers et des fiches :
  - créer/supprimer/fusionner des dossiers
  - ajouter/retirer des fiches d'un dossier (multi-appartenance supportée)
  - recherche, tri, multi-sélection et suppression en lot
  - lien depuis la colonne titre vers l'item Zotero d'origine
- Synthèse et export :
  - synthèse par dossier (`合并综述`) avec retour de progression
  - enregistrement persistant avec traçage des sources (`sourceRecordIDs`, `sourceZoteroItemIDs`)
  - création par lot de notes enfants Zotero natives depuis `文献记录`
  - contenu des notes généré depuis les fiches Exitem et stocké nativement sous les items Zotero
  - consultation/édition des fiches
  - export CSV selon la vue et les filtres courants
- Stockage :
  - fichier JSON indépendant dans le répertoire de données Zotero : `exitem-review-store.json`
  - journal local des événements (extraction, synthèse, export, etc.)

## Chemin d'appel IA

- Les appels IA passent par le pont runtime/configuration du plugin `zotero-gpt` installé.
