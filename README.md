# VeilBridge — Zero-Leak On-Device PII Airlock & Hybrid Document Analyst

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](LICENSE)
[![Firebase AI Logic](https://img.shields.io/badge/Firebase%20AI%20Logic-v13.4.0%20Hybrid%20SDK-8b5cf6.svg)](src/firebaseHybridClient.ts)
[![Tests: 10/10 Passing](https://img.shields.io/badge/Tests-10%2F10%20Passing-06b6d4.svg)](tests/veilbridge.test.ts)

> **Review sensitive contracts, medical bills, and incident logs with cloud-grade Gemini intelligence—without a single byte of raw personal data ever leaving Chrome, powered by Firebase AI Logic Hybrid Inference.**
>
> - **Live Interactive Web App**: **[https://jalnanco.github.io/veilbridge-hybrid-ai/](https://jalnanco.github.io/veilbridge-hybrid-ai/)**
> - **Platform**: **Web (Chrome Desktop v139+ with Gemini Nano 4 + Universal Cloud/Local Hybrid Fallback)**
> - **Built For**: **Google `#BuildHybridAI 2026` Hackathon**

---

## Why Hybrid Inference Is Essential Here (Value Proposition)

Freelancers, tenants, patients, and software engineers routinely hesitate to paste contracts, itemized hospital statements, or production crash dumps into cloud AI assistants because doing so transmits **names, SSNs, bank routing/account numbers, street addresses, medical record IDs, and live API secrets** over the network. Conversely, relying *solely* on a compact on-device model limits context size (9,216 tokens) and multi-clause legal/negotiation reasoning depth.

**VeilBridge** turns **Firebase AI Logic's Hybrid Inference SDK (`firebase/ai`)** into a **3-Stage Privacy Airlock & Negotiation Workbench** where on-device and cloud models each do what only they can do:

1. **Stage 1 — Privacy Airlock (`InferenceMode.ONLY_ON_DEVICE`, Gemini Nano 4 Text + Multimodal PNG/JPEG)**:
   Extracts and tokenizes PII/secrets strictly inside Chrome into a local reversible vault (`[PARTY_1]`, `[TAX_ID_1]`, `[ACCT_1]`, `[SECRET_KEY_1]`, `[AMOUNT_1]`). **Zero bytes of raw PII ever cross the network.**
2. **Stage 2 — Instant Risk Triage Co-Pilot (`InferenceMode.PREFER_ON_DEVICE`)**:
   Runs instant, zero-cost clause & billing risk triage on-device (even 100% offline in Airplane Mode!), seamlessly falling back to `gemini-3.5-flash-lite` on browsers without Gemini Nano 4—with zero branching in UI code.
3. **Stage 3 — Deep Redline & Negotiation Studio (`InferenceMode.PREFER_IN_CLOUD`, `gemini-3.8-flash`)**:
   Sends **only the PII-sanitized placeholder twin** (protected by **Firebase App Check** and dynamically configured via **Firebase Remote Config**) to `gemini-3.8-flash` for cross-clause redlines and dispute letters, then **re-hydrates** `[PARTY_1]` and `[AMOUNT_1]` back to real values strictly inside browser RAM.

---

## How We Used Firebase AI Logic (`src/firebaseHybridClient.ts`)

All AI inference in VeilBridge runs through the official **`firebase` v13.4.0** Web SDK (`firebase/app`, `firebase/app-check`, `firebase/remote-config`, and `firebase/ai`):

- **`GoogleAIBackend` + `App Check` + `Remote Config`**: Initializes `getAI(app, { backend: new GoogleAIBackend() })`, enforces `ReCaptchaV3Provider` App Check attestation when configured (never committing debug tokens or `.env` files to Git), and reads `cloud_analyst_model` (`gemini-3.8-flash`) and `fallback_lite_model` (`gemini-3.5-flash-lite`) via `firebase/remote-config`.
- **Three Per-Feature `GenerativeModel` Instances**:
  - `airlockModel`: `getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams: { createOptions: { expectedInputs: [{ type: "text" }, { type: "image" }] } } })`
  - `triageModel`: `getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, inCloudParams: { model: "gemini-3.5-flash-lite" } })` + `triageModel.initializeDeviceModel(onProgress)` triggered on user gesture.
  - `analystModel`: `getGenerativeModel(ai, { mode: InferenceMode.PREFER_IN_CLOUD, inCloudParams: { model: "gemini-3.8-flash" } })`
- **Live `response.inferenceSource` Telemetry HUD**: Every response inspects `result.response.inferenceSource` (`InferenceSource.ON_DEVICE` vs `InferenceSource.IN_CLOUD`) and surfaces exact latency, cloud byte count, vaulted entity count, and saved cloud prompt tokens.

---

## Quick Start & Testing Instructions

### 1. Try Instantly in Browser (Zero Setup Required)
Open **[https://jalnanco.github.io/veilbridge-hybrid-ai/](https://jalnanco.github.io/veilbridge-hybrid-ai/)**:
- Switch across the **3 Synthetic Scenarios**:
  1. `Freelance IP-Trap Contract` (sweeping background-IP assignment, uncapped indemnity, Net-90 terms)
  2. `Hospital Bill (Multimodal PNG)` (generates a synthetic PNG ER invoice in `<canvas>` passed via `fileToGenerativePart()` to inspect duplicate `CPT 99285` coding)
  3. `Prod Crash Log with Secrets` (scrubs synthetic AWS/Postgres/JWT secrets before root-cause triage)
- Click any **Local Vault Chip** (`[PARTY_1]`, `[TAX_ID_1]`) to inspect or toggle redaction in real time.
- Toggle **`✈ Offline Mode: ON`** in the header to verify 100% offline local resilience (`0 Bytes` sent to cloud).
- Open **`02 · Deep Redline & Local Re-Hydration`** to compare **Raw Cloud Output (Placeholder Tokens Only)** side by side with the **Locally Re-Hydrated Final Letter**.

### 2. Local Development, Unit Tests & Live Firebase Project Connection
```bash
git clone https://github.com/jalnanco/veilbridge-hybrid-ai.git
cd veilbridge-hybrid-ai
npm install

# Run all 10 TypeScript unit & Firebase AI Logic SDK integration tests
npm test

# Start local Vite dev server (http://localhost:5173)
npm run dev

# Production TypeScript type-check & bundle build
npm run build
```
To connect your own live Firebase AI Logic project (`GoogleAIBackend`), copy `.env.example` to `.env` (git-ignored) or click **`⚙ Firebase Config`** in the top bar at runtime. For Chrome Desktop (`v139+`) on-device **Gemini Nano 4**, enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` (and Gemma 4 Built-in AI flag), restart Chrome, and click **`⚡ Initialize Nano 4`**.

---

## License

Released under the [MIT License](LICENSE). All sample names, identifiers, and keys in `src/presets.ts` are 100% synthetic RFC/documentation placeholders.
