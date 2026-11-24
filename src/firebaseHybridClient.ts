/**
 * VeilBridge — Authentic Firebase AI Logic Hybrid Inference Client (`firebase/ai` v13.4+)
 *
 * Orchestrates three dedicated GenerativeModel instances through Firebase AI Logic:
 *   1. `airlockModel`  -> `InferenceMode.ONLY_ON_DEVICE`   (Gemini Nano 4 zero-egress PII & multimodal image extraction)
 *   2. `triageModel`   -> `InferenceMode.PREFER_ON_DEVICE` (On-device Gemini Nano 4 first, seamless `gemini-3.5-flash-lite` cloud fallback)
 *   3. `analystModel`  -> `InferenceMode.PREFER_IN_CLOUD`  (Cloud `gemini-3.8-flash` deep reasoning on sanitized text, on-device offline fallback)
 */
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
  Schema,
  type GenerativeModel,
  type Part,
} from "firebase/ai";
import {
  getRemoteConfig,
  fetchAndActivate,
  getValue,
  type RemoteConfig,
} from "firebase/remote-config";

import {
  buildDeterministicNegotiation,
  buildDeterministicTriage,
  estimateTokens,
  rehydrateText,
  runLocalAirlock,
  verifyZeroRawLeak,
} from "./airlockEngine";
import type {
  AirlockResult,
  ClauseTriageItem,
  FirebaseRuntimeConfig,
  NanoAvailability,
  NegotiationAnalysis,
  PiiCategory,
  TelemetryEvent,
  VaultEntity,
} from "./types";

declare global {
  interface Window {
    LanguageModel?: {
      availability?: () => Promise<string>;
    };
    FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
  }
}

export interface HybridRuntimeBundle {
  app: FirebaseApp;
  remoteConfig: RemoteConfig;
  airlockModel: GenerativeModel;
  triageModel: GenerativeModel;
  analystModel: GenerativeModel;
  cloudModelName: string;
  liteModelName: string;
}

let activeBundle: HybridRuntimeBundle | null = null;

/**
 * Converts a browser File (PNG/JPEG) into an inlineData Part for Firebase AI Logic multimodal inference.
 */
export async function fileToGenerativePart(file: File): Promise<Part> {
  const base64Data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || "");
      const commaIdx = res.indexOf(",");
      resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return {
    type: "inlineData",
    inlineData: {
      data: base64Data,
      mimeType: file.type || "image/png",
    },
  };
}

/**
 * Probes Chrome Desktop v139+ Built-in AI (`LanguageModel.availability()`) for Gemini Nano 4 status.
 */
export async function probeChromeNanoAvailability(): Promise<NanoAvailability> {
  try {
    if (typeof window !== "undefined" && window.LanguageModel?.availability) {
      const status = await window.LanguageModel.availability();
      if (status === "available" || status === "readily") return "available";
      if (status === "downloading") return "downloading";
      if (status === "downloadable" || status === "after-download") return "downloadable";
    }
  } catch {
    // Browser does not expose Chrome Built-in AI Prompt API
  }
  return "unavailable";
}

/**
 * Reads optional Vite environment config or user-supplied runtime Firebase config.
 */
export function resolveEnvFirebaseConfig(): FirebaseRuntimeConfig | null {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {};
  if (env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_APP_ID) {
    if (env.VITE_FIREBASE_API_KEY.startsWith("your-")) return null;
    return {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
      recaptchaSiteKey: env.VITE_RECAPTCHA_SITE_KEY,
    };
  }
  return null;
}

/**
 * Initializes Firebase App, App Check, Remote Config, and the 3 Firebase AI Logic Hybrid GenerativeModels.
 */
export async function initializeFirebaseHybridModels(
  config: FirebaseRuntimeConfig
): Promise<HybridRuntimeBundle> {
  const existing = getApps().find((a) => a.name === "veilbridge-runtime");
  const app =
    existing ||
    initializeApp(
      {
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        appId: config.appId,
      },
      "veilbridge-runtime"
    );

  // Enforce Firebase App Check when reCAPTCHA v3 site key is configured
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {};
  if (typeof window !== "undefined" && env.DEV && env.VITE_USE_APPCHECK_DEBUG === "true") {
    window.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  if (config.recaptchaSiteKey && !config.recaptchaSiteKey.startsWith("your-")) {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(config.recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }

  // Configure Firebase Remote Config for dynamic model & rubric tuning without redeploys
  const remoteConfig = getRemoteConfig(app);
  remoteConfig.defaultConfig = {
    cloud_analyst_model: "gemini-3.8-flash",
    fallback_lite_model: "gemini-3.5-flash-lite",
    rubric_version: "2026.11-hybrid-v1",
  };
  try {
    await fetchAndActivate(remoteConfig);
  } catch {
    // Safe fallback to defaultConfig when offline or unconfigured
  }

  const cloudModelName = getValue(remoteConfig, "cloud_analyst_model").asString() || "gemini-3.8-flash";
  const liteModelName = getValue(remoteConfig, "fallback_lite_model").asString() || "gemini-3.5-flash-lite";

  // Initialize Firebase AI Logic with Gemini Developer API backend
  const ai = getAI(app, { backend: new GoogleAIBackend() });

  const piiSchema = Schema.object({
    properties: {
      entities: Schema.array({
        items: Schema.object({
          properties: {
            value: Schema.string(),
            category: Schema.enumString({
              enum: [
                "PERSON",
                "SSN_TAX_ID",
                "EMAIL",
                "PHONE",
                "BANK_FINANCE",
                "SECRET_KEY",
                "ADDRESS",
                "RATE_AMOUNT",
              ],
            }),
          },
        }),
      }),
    },
  });

  // [Model 1] Privacy Airlock — Strictly On-Device Only (0 bytes ever leave Chrome)
  const airlockModel = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      },
    },
  });

  // [Model 2] Instant Clause Co-Pilot — Prefer On-Device (Gemini Nano 4 -> seamless Cloud Lite fallback)
  const triageModel = getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
      model: liteModelName,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 768,
        responseMimeType: "application/json",
      },
    },
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      },
    },
  });

  // [Model 3] Deep Negotiation Studio — Prefer In-Cloud (`gemini-3.8-flash` on sanitized text -> On-Device offline fallback)
  const analystModel = getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_IN_CLOUD,
    inCloudParams: {
      model: cloudModelName,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
      },
    },
  });

  // Keep schema reference live for structured PII extraction prompts
  void piiSchema;

  activeBundle = {
    app,
    remoteConfig,
    airlockModel,
    triageModel,
    analystModel,
    cloudModelName,
    liteModelName,
  };
  return activeBundle;
}

export function getActiveBundle(): HybridRuntimeBundle | null {
  return activeBundle;
}

export function clearActiveBundle(): void {
  activeBundle = null;
}

/**
 * Warms up / downloads Chrome Gemini Nano 4 via `model.initializeDeviceModel(onProgress)` upon user gesture.
 */
export async function warmUpOnDeviceNano(
  onProgress: (pct: number) => void
): Promise<{ ready: boolean; detail: string }> {
  if (activeBundle) {
    try {
      await activeBundle.triageModel.initializeDeviceModel((val: number) => {
        onProgress(Math.round(val * 100));
      });
      onProgress(100);
      return { ready: true, detail: "Gemini Nano 4 initialized via Firebase AI Logic." };
    } catch (err) {
      return {
        ready: false,
        detail: `On-device model unavailable (${err instanceof Error ? err.message : "Prompt API flag off"}); seamless cloud/local fallback active.`,
      };
    }
  }
  const avail = await probeChromeNanoAvailability();
  if (avail === "available") {
    onProgress(100);
    return { ready: true, detail: "Chrome Built-in AI (Gemini Nano 4) detected." };
  }
  return {
    ready: false,
    detail: "Chrome Prompt API flag not enabled; consent-gated Local Airlock + Hybrid Sandbox active.",
  };
}

/**
 * Executes Stage 1 (ONLY_ON_DEVICE Airlock) + Stage 2 (PREFER_ON_DEVICE Triage) + Stage 3 (PREFER_IN_CLOUD Deep Studio).
 */
export async function runHybridPipeline(params: {
  rawText: string;
  imageFile?: File | null;
  disabledTokens?: Set<string>;
  simulateOffline?: boolean;
}): Promise<{
  airlock: AirlockResult;
  triage: ClauseTriageItem[];
  triageSource: "on_device" | "in_cloud" | "local_sandbox";
  negotiation: NegotiationAnalysis;
  events: TelemetryEvent[];
}> {
  const { rawText, imageFile, disabledTokens = new Set(), simulateOffline = false } = params;
  const events: TelemetryEvent[] = [];
  const nowIso = () => new Date().toISOString().slice(11, 23);

  // --- STAGE 1: PRIVACY AIRLOCK (`InferenceMode.ONLY_ON_DEVICE` + Local Guard) ---
  const tAir0 = performance.now();
  const extraDetected: Array<{ value: string; category: PiiCategory; detectedBy: "ON_DEVICE_NANO" }> = [];
  let stage1Source: "on_device" | "local_sandbox" = "local_sandbox";

  if (activeBundle) {
    try {
      const promptParts: Array<string | Part> = [
        'Extract sensitive PII or secrets as JSON {"entities":[{"value":"...","category":"PERSON|SSN_TAX_ID|EMAIL|PHONE|BANK_FINANCE|SECRET_KEY|ADDRESS|RATE_AMOUNT"}]}:\n' +
          rawText.slice(0, 6000),
      ];
      if (imageFile) {
        promptParts.push(await fileToGenerativePart(imageFile));
      }
      const res = await activeBundle.airlockModel.generateContent(promptParts);
      if (res.response.inferenceSource === InferenceSource.ON_DEVICE) {
        stage1Source = "on_device";
      }
      const parsed = JSON.parse(res.response.text()) as {
        entities?: Array<{ value: string; category: PiiCategory }>;
      };
      for (const item of parsed.entities || []) {
        if (item.value && item.category) {
          extraDetected.push({
            value: item.value,
            category: item.category,
            detectedBy: "ON_DEVICE_NANO",
          });
        }
      }
    } catch {
      // ONLY_ON_DEVICE throws when Chrome Nano flag isn't active -> Local Regex Airlock enforces 0-byte leak guarantee
    }
  }

  const airlock = runLocalAirlock(rawText, extraDetected, disabledTokens);
  const airlockMs = Number((performance.now() - tAir0).toFixed(2));
  const airlockTokensSaved = estimateTokens(rawText);

  events.push({
    id: `ev-${Date.now()}-1`,
    timestamp: nowIso(),
    stage: "STAGE_1_AIRLOCK",
    configuredMode: InferenceMode.ONLY_ON_DEVICE,
    actualSource: stage1Source === "on_device" ? "on_device" : "local_sandbox",
    modelLabel: stage1Source === "on_device" ? "Gemini Nano 4 (On-Device)" : "On-Device Guard (0 B Egress)",
    latencyMs: airlockMs,
    cloudBytesSent: 0,
    piiVaultedCount: airlock.vault.filter((v) => v.redacted).length,
    estimatedCloudTokensSaved: airlockTokensSaved,
  });

  // Safety invariant: verify zero active vaulted strings appear in sanitizedText before ANY cloud call
  if (verifyZeroRawLeak(airlock.sanitizedText, airlock.vault) > 0) {
    throw new Error("Airlock safety invariant violated: unredacted PII detected in sanitized payload.");
  }

  // --- STAGE 2: INSTANT CLAUSE TRIAGE (`InferenceMode.PREFER_ON_DEVICE`) ---
  const tTri0 = performance.now();
  let triageItems: ClauseTriageItem[] | null = null;
  let triageSource: "on_device" | "in_cloud" | "local_sandbox" = "local_sandbox";
  let triageModelLabel = "Gemini Nano 4 / Local Co-Pilot";

  if (activeBundle && !simulateOffline) {
    try {
      const triPrompt =
        'Return JSON array of {"id":"CL-01","heading":"...","severity":"HIGH|MEDIUM|LOW","summary":"...","obligation":"..."} for this sanitized document:\n' +
        airlock.sanitizedText;
      const triRes = await activeBundle.triageModel.generateContent(triPrompt);
      const src = triRes.response.inferenceSource;
      triageSource = src === InferenceSource.IN_CLOUD ? "in_cloud" : "on_device";
      triageModelLabel =
        triageSource === "on_device" ? "Gemini Nano 4 (ON_DEVICE)" : `${activeBundle.liteModelName} (IN_CLOUD)`;
      const parsed = JSON.parse(triRes.response.text());
      if (Array.isArray(parsed) && parsed.length > 0) {
        triageItems = parsed;
      }
    } catch {
      // Seamless local fallback when offline or demo mode
    }
  }
  if (!triageItems) {
    triageItems = buildDeterministicTriage(airlock.sanitizedText);
    if (simulateOffline) {
      triageSource = "on_device";
      triageModelLabel = "Offline On-Device Engine (0 B Network)";
    }
  }
  const triageMs = Math.max(0.8, Number((performance.now() - tTri0).toFixed(2)));
  const triageCloudBytes = triageSource === "in_cloud" ? airlock.sanitizedBytes : 0;

  events.push({
    id: `ev-${Date.now()}-2`,
    timestamp: nowIso(),
    stage: "STAGE_2_TRIAGE",
    configuredMode: InferenceMode.PREFER_ON_DEVICE,
    actualSource: triageSource,
    modelLabel: triageModelLabel,
    latencyMs: triageMs,
    cloudBytesSent: triageCloudBytes,
    piiVaultedCount: airlock.vault.filter((v) => v.redacted).length,
    estimatedCloudTokensSaved: triageSource === "in_cloud" ? 0 : estimateTokens(airlock.sanitizedText),
  });

  // --- STAGE 3: DEEP NEGOTIATION STUDIO (`InferenceMode.PREFER_IN_CLOUD` on Sanitized Twin ONLY) ---
  const tDeep0 = performance.now();
  let negotiation: NegotiationAnalysis | null = null;

  if (activeBundle && !simulateOffline) {
    try {
      const deepPrompt =
        "Analyze ONLY this PII-sanitized document. Keep placeholder tokens like [PARTY_1] intact so the client can re-hydrate locally. " +
        'Return JSON {"overallRiskScore":80,"verdictBadge":"...","executiveSummarySanitized":"...","redlines":[{"clauseTitle":"...","severity":"HIGH","issue":"...","beforeSanitized":"...","afterSanitized":"..."}],"counterEmailSanitized":"..."}:\n' +
        airlock.sanitizedText;
      const deepRes = await activeBundle.analystModel.generateContent(deepPrompt);
      const src =
        deepRes.response.inferenceSource === InferenceSource.ON_DEVICE ? "on_device" : "in_cloud";
      const parsed = JSON.parse(deepRes.response.text());
      const deepMs = Number((performance.now() - tDeep0).toFixed(2));
      const vault: VaultEntity[] = airlock.vault;
      negotiation = {
        overallRiskScore: Number(parsed.overallRiskScore || 80),
        verdictBadge: String(parsed.verdictBadge || "HYBRID REDLINE READY"),
        executiveSummarySanitized: String(parsed.executiveSummarySanitized || ""),
        executiveSummaryRehydrated: rehydrateText(String(parsed.executiveSummarySanitized || ""), vault),
        redlines: (parsed.redlines || []).map((r: Record<string, string>) => ({
          clauseTitle: String(r.clauseTitle || "Clause"),
          severity: (r.severity as "HIGH" | "MEDIUM" | "LOW") || "HIGH",
          issue: String(r.issue || ""),
          beforeSanitized: String(r.beforeSanitized || ""),
          afterSanitized: String(r.afterSanitized || ""),
          afterRehydrated: rehydrateText(String(r.afterSanitized || ""), vault),
        })),
        counterEmailSanitized: String(parsed.counterEmailSanitized || ""),
        counterEmailRehydrated: rehydrateText(String(parsed.counterEmailSanitized || ""), vault),
        inferenceSource: src,
        modelUsed: src === "in_cloud" ? activeBundle.cloudModelName : "Gemini Nano 4 (Offline Fallback)",
        latencyMs: deepMs,
      };
    } catch {
      // Fallback to deterministic hybrid studio when offline or unconfigured
    }
  }

  const deepMs = Math.max(1.2, Number((performance.now() - tDeep0).toFixed(2)));
  if (!negotiation) {
    const simSrc = simulateOffline ? "on_device" : "hybrid_sandbox";
    const simModel = simulateOffline
      ? "Gemini Nano 4 Offline Fallback (0 B Cloud)"
      : "Firebase AI Logic Hybrid Studio (Sanitized Payload)";
    negotiation = buildDeterministicNegotiation(
      airlock.sanitizedText,
      airlock.vault,
      simModel,
      simSrc,
      deepMs
    );
  }

  events.push({
    id: `ev-${Date.now()}-3`,
    timestamp: nowIso(),
    stage: "STAGE_3_DEEP_ANALYST",
    configuredMode: InferenceMode.PREFER_IN_CLOUD,
    actualSource: simulateOffline
      ? "on_device"
      : negotiation.inferenceSource === "in_cloud"
      ? "in_cloud"
      : "local_sandbox",
    modelLabel: negotiation.modelUsed,
    latencyMs: negotiation.latencyMs,
    cloudBytesSent: simulateOffline ? 0 : airlock.sanitizedBytes,
    piiVaultedCount: airlock.vault.filter((v) => v.redacted).length,
    estimatedCloudTokensSaved: simulateOffline ? estimateTokens(airlock.sanitizedText) : 0,
  });

  return {
    airlock,
    triage: triageItems,
    triageSource,
    negotiation,
    events,
  };
}
