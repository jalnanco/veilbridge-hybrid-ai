export type PiiCategory =
  | "PERSON"
  | "SSN_TAX_ID"
  | "EMAIL"
  | "PHONE"
  | "BANK_FINANCE"
  | "SECRET_KEY"
  | "ADDRESS"
  | "RATE_AMOUNT";

export interface VaultEntity {
  token: string;
  category: PiiCategory;
  originalValue: string;
  occurrences: number;
  redacted: boolean;
  detectedBy: "ON_DEVICE_NANO" | "LOCAL_REGEX_GUARD";
}

export interface AirlockResult {
  originalText: string;
  sanitizedText: string;
  vault: VaultEntity[];
  rawBytes: number;
  sanitizedBytes: number;
  leakedCount: number;
  inferenceSource: "on_device" | "local_guard";
  latencyMs: number;
}

export type RiskSeverity = "HIGH" | "MEDIUM" | "LOW";

export interface ClauseTriageItem {
  id: string;
  heading: string;
  severity: RiskSeverity;
  summary: string;
  obligation: string;
}

export interface RedlineSuggestion {
  clauseTitle: string;
  severity: RiskSeverity;
  issue: string;
  beforeSanitized: string;
  afterSanitized: string;
  afterRehydrated: string;
}

export interface NegotiationAnalysis {
  overallRiskScore: number; // 0 - 100
  verdictBadge: string;
  executiveSummarySanitized: string;
  executiveSummaryRehydrated: string;
  redlines: RedlineSuggestion[];
  counterEmailSanitized: string;
  counterEmailRehydrated: string;
  inferenceSource: "on_device" | "in_cloud" | "hybrid_sandbox";
  modelUsed: string;
  latencyMs: number;
}

export interface TelemetryEvent {
  id: string;
  timestamp: string;
  stage: "STAGE_1_AIRLOCK" | "STAGE_2_TRIAGE" | "STAGE_3_DEEP_ANALYST";
  configuredMode: "only_on_device" | "prefer_on_device" | "prefer_in_cloud";
  actualSource: "on_device" | "in_cloud" | "local_sandbox";
  modelLabel: string;
  latencyMs: number;
  cloudBytesSent: number;
  piiVaultedCount: number;
  estimatedCloudTokensSaved: number;
}

export type NanoAvailability = "available" | "downloadable" | "downloading" | "unavailable";

export interface FirebaseRuntimeConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  recaptchaSiteKey?: string;
}

export interface PresetScenario {
  id: string;
  label: string;
  docType: "CONTRACT" | "MEDICAL_BILL" | "INCIDENT_LOG";
  badge: string;
  description: string;
  rawText: string;
  hasSyntheticReceiptImage?: boolean;
}
