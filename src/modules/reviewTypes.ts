export type ReviewModelConfigMode = "awesomegpt";
export type ReviewProvider = "openai";
export type ReviewAPIConfigMode = "zoterogpt";
export type ReviewRecordType = "literature" | "folderSummary";

export interface ReviewSettings {
  modelConfigMode: ReviewModelConfigMode;
  apiConfigMode: ReviewAPIConfigMode;
  provider: ReviewProvider;
  api: string;
  secretKey: string;
  model: string;
  temperature: number;
  embeddingModel: string;
  embeddingBatchNum: number;
  timeoutSeconds: number;
  usePDFAsInputSource: boolean;
  usePDFAnnotationsAsContext: boolean;
  importPDFAnnotationsAsField: boolean;
  enablePDFInputTruncation: boolean;
  pdfTextMaxChars: number;
  pdfAnnotationTextMaxChars: number;
  customPromptTemplate: string;
  customFolderSummaryPromptTemplate: string;
}

export interface ZoteroGPTPrefsSnapshot {
  api: string;
  secretKey: string;
  model: string;
  temperature: number;
  embeddingModel: string;
  embeddingBatchNum: number;
  source: "zoterogpt";
}

export interface AwesomeGPTDetection {
  installed: boolean;
  source: string;
  detail?: string;
  callable?: boolean;
  addonID?: string;
  addonName?: string;
  obstacle?: string;
}

export interface LiteratureReviewDraft {
  zoteroItemID: number;
  recordType?: ReviewRecordType;
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
  sourceRecordIDs?: number[];
  sourceZoteroItemIDs?: number[];
  aiProvider: string;
  aiModel: string;
  rawAIResponse?: string;
}

export interface ReviewFolderRow {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRecordRow extends LiteratureReviewDraft {
  id: number;
  recordType: ReviewRecordType;
  folderID: number | null;
  folderName: string | null;
  folderIDs: number[];
  folderNames: string[];
  sourceRecordIDs: number[];
  sourceZoteroItemIDs: number[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewListFilters {
  folderID?: number | null;
  recordType?: ReviewRecordType | "all";
  search?: string;
  sortKey?: "updatedAt" | "title" | "publicationDate" | "journal";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}
