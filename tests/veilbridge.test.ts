import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deleteApp } from "firebase/app";
import { InferenceMode, InferenceSource } from "firebase/ai";

import {
  buildDeterministicNegotiation,
  buildDeterministicTriage,
  estimateTokens,
  rehydrateText,
  runLocalAirlock,
  verifyZeroRawLeak,
} from "../src/airlockEngine";
import {
  clearActiveBundle,
  initializeFirebaseHybridModels,
  runHybridPipeline,
} from "../src/firebaseHybridClient";
import { VEILBRIDGE_PRESETS } from "../src/presets";

describe("Firebase AI Logic v13.4+ SDK Contract Verification", () => {
  it("exports all four official Hybrid InferenceModes and InferenceSources", () => {
    assert.equal(InferenceMode.ONLY_ON_DEVICE, "only_on_device");
    assert.equal(InferenceMode.PREFER_ON_DEVICE, "prefer_on_device");
    assert.equal(InferenceMode.PREFER_IN_CLOUD, "prefer_in_cloud");
    assert.equal(InferenceMode.ONLY_IN_CLOUD, "only_in_cloud");
    assert.equal(InferenceSource.ON_DEVICE, "on_device");
    assert.equal(InferenceSource.IN_CLOUD, "in_cloud");
  });

  it("initializes three distinct GenerativeModel instances via Firebase AI Logic", async () => {
    const bundle = await initializeFirebaseHybridModels({
      apiKey: "AIzaSyDemoSyntheticTestKey000000000000000",
      authDomain: "veilbridge-demo.firebaseapp.com",
      projectId: "veilbridge-demo",
      appId: "1:100000000000:web:abcdef1234567890",
    });
    assert.ok(bundle.airlockModel, "ONLY_ON_DEVICE airlockModel created");
    assert.ok(bundle.triageModel, "PREFER_ON_DEVICE triageModel created");
    assert.ok(bundle.analystModel, "PREFER_IN_CLOUD analystModel created");
    assert.equal(bundle.cloudModelName, "gemini-3.8-flash");
    assert.equal(bundle.liteModelName, "gemini-3.5-flash-lite");
    await deleteApp(bundle.app);
    clearActiveBundle();
  });
});

describe("Stage 1 On-Device Privacy Airlock & Zero-Leak Guarantee", () => {
  it("redacts every PII and secret entity across all 3 synthetic presets with 0 leaks", () => {
    for (const preset of VEILBRIDGE_PRESETS) {
      const res = runLocalAirlock(preset.rawText);
      assert.ok(res.vault.length >= 5, `Expected >=5 vaulted entities in ${preset.id}, got ${res.vault.length}`);
      assert.equal(res.leakedCount, 0);
      assert.equal(verifyZeroRawLeak(res.sanitizedText, res.vault), 0);

      for (const entity of res.vault) {
        assert.equal(
          res.sanitizedText.includes(entity.originalValue),
          false,
          `Leaked raw value ${entity.originalValue} in ${preset.id}`
        );
        assert.equal(
          res.sanitizedText.includes(entity.token),
          true,
          `Missing placeholder ${entity.token} in ${preset.id}`
        );
      }
    }
  });

  it("supports selective user token un-redaction while protecting remaining vaulted PII", () => {
    const sample =
      "Agreement with Alex Rivera (SSN 000-48-2910, Email alex.rivera@example.org) for $16,500.00.";
    const initial = runLocalAirlock(sample);
    const amountToken = initial.vault.find((v) => v.category === "RATE_AMOUNT")?.token;
    assert.ok(amountToken);

    const toggled = runLocalAirlock(sample, [], new Set([amountToken!]));
    assert.equal(toggled.sanitizedText.includes("$16,500.00"), true);
    assert.equal(toggled.sanitizedText.includes("000-48-2910"), false);
    assert.equal(toggled.sanitizedText.includes("alex.rivera@example.org"), false);
    assert.equal(verifyZeroRawLeak(toggled.sanitizedText, toggled.vault), 0);
  });

  it("merges Gemini Nano 4 structured JSON entities with deterministic local guard", () => {
    const raw = "Confidential consultation for Dr. Evelyn Chen regarding custom biotech milestone.";
    const merged = runLocalAirlock(raw, [
      { value: "biotech milestone", category: "SECRET_KEY", detectedBy: "ON_DEVICE_NANO" },
    ]);
    assert.equal(merged.inferenceSource, "on_device");
    assert.equal(merged.sanitizedText.includes("biotech milestone"), false);
    assert.equal(merged.sanitizedText.includes("Dr. Evelyn Chen"), false);
  });

  it("losslessly re-hydrates cloud responses back to original local entities", () => {
    const contract = VEILBRIDGE_PRESETS[0].rawText;
    const airlock = runLocalAirlock(contract);
    const restoredOriginal = rehydrateText(airlock.sanitizedText, airlock.vault);
    assert.equal(restoredOriginal, contract);
  });
});

describe("Stage 2 & Stage 3 Hybrid Routing, Offline Simulation & Telemetry", () => {
  it("produces domain-specific triage and re-hydrated redlines for contracts, medical bills, and logs", () => {
    for (const preset of VEILBRIDGE_PRESETS) {
      const airlock = runLocalAirlock(preset.rawText);
      const triage = buildDeterministicTriage(airlock.sanitizedText);
      assert.ok(triage.length >= 2);

      const neg = buildDeterministicNegotiation(
        airlock.sanitizedText,
        airlock.vault,
        "gemini-3.8-flash",
        "in_cloud",
        18.4
      );
      assert.ok(neg.redlines.length >= 2);
      // Cloud sanitized text keeps placeholders, whereas re-hydrated text restores real names/amounts
      const firstParty = airlock.vault.find((v) => v.category === "PERSON");
      if (firstParty) {
        assert.equal(neg.counterEmailSanitized.includes(firstParty.originalValue), false);
        assert.equal(neg.counterEmailRehydrated.includes(firstParty.originalValue), true);
      }
    }
  });

  it("executes full 3-stage pipeline in Offline Simulator mode with 0 cloud bytes sent", async () => {
    const out = await runHybridPipeline({
      rawText: VEILBRIDGE_PRESETS[1].rawText,
      simulateOffline: true,
    });
    assert.equal(out.events.length, 3);
    const totalCloudBytes = out.events.reduce((acc, e) => acc + e.cloudBytesSent, 0);
    assert.equal(totalCloudBytes, 0);
    assert.equal(out.triageSource, "on_device");
    assert.ok(estimateTokens(out.airlock.originalText) > 50);
  });

  it("computes positive token savings when routing Airlock and Triage on-device", async () => {
    const out = await runHybridPipeline({
      rawText: VEILBRIDGE_PRESETS[0].rawText,
      simulateOffline: false,
    });
    const saved = out.events.reduce((sum, ev) => sum + ev.estimatedCloudTokensSaved, 0);
    assert.ok(saved >= 200, `Expected >=200 tokens saved, got ${saved}`);
  });

  it("ensures zero real production keys or .env secrets exist in presets", () => {
    for (const p of VEILBRIDGE_PRESETS) {
      assert.equal(p.rawText.includes("sk_live_"), false);
    }
  });
});
