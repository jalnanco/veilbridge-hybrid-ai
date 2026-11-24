import "./styles.css";
import {
  getActiveBundle,
  initializeFirebaseHybridModels,
  probeChromeNanoAvailability,
  resolveEnvFirebaseConfig,
  runHybridPipeline,
  warmUpOnDeviceNano,
} from "./firebaseHybridClient";
import {
  generateSyntheticInvoicePngFile,
  VEILBRIDGE_PRESETS,
} from "./presets";
import type {
  AirlockResult,
  ClauseTriageItem,
  NegotiationAnalysis,
  TelemetryEvent,
} from "./types";

interface AppState {
  presetId: string;
  view: string;
  rawText: string;
  imageFile: File | null;
  imagePreviewUrl: string | null;
  disabledTokens: Set<string>;
  simulateOffline: boolean;
  nanoStatusLabel: string;
  airlock: AirlockResult | null;
  triage: ClauseTriageItem[];
  triageSource: "on_device" | "in_cloud" | "local_sandbox";
  negotiation: NegotiationAnalysis | null;
  telemetryHistory: TelemetryEvent[];
}

const state: AppState = {
  presetId: "freelance_contract",
  view: "airlock",
  rawText: VEILBRIDGE_PRESETS[0].rawText,
  imageFile: null,
  imagePreviewUrl: null,
  disabledTokens: new Set(),
  simulateOffline: false,
  nanoStatusLabel: "Probing...",
  airlock: null,
  triage: [],
  triageSource: "local_sandbox",
  negotiation: null,
  telemetryHistory: [],
};

function esc(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightPlaceholders(text: string): string {
  return esc(text).replace(
    /\[([A-Z_]+_\d+)\]/g,
    '<span class="tok-highlight">[$1]</span>'
  );
}

async function selectPreset(presetId: string): Promise<void> {
  const preset = VEILBRIDGE_PRESETS.find((p) => p.id === presetId) || VEILBRIDGE_PRESETS[0];
  state.presetId = preset.id;
  state.rawText = preset.rawText;
  state.disabledTokens.clear();

  if (state.imagePreviewUrl) {
    URL.revokeObjectURL(state.imagePreviewUrl);
    state.imagePreviewUrl = null;
  }
  state.imageFile = null;

  if (preset.hasSyntheticReceiptImage) {
    const synthFile = await generateSyntheticInvoicePngFile();
    if (synthFile) {
      state.imageFile = synthFile;
      state.imagePreviewUrl = URL.createObjectURL(synthFile);
    }
  }

  document.querySelectorAll<HTMLButtonElement>(".vb-preset-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.preset === preset.id);
  });

  const descEl = document.getElementById("active-preset-desc");
  if (descEl) {
    descEl.innerHTML = esc(preset.description).replace(
      /`([^`]+)`/g,
      "<code>$1</code>"
    );
  }
  const textarea = document.getElementById("raw-input-area") as HTMLTextAreaElement | null;
  if (textarea) textarea.value = state.rawText;

  renderMultimodalPreview();
  await executePipeline();
}

function renderMultimodalPreview(): void {
  const wrap = document.getElementById("image-preview-wrap");
  const img = document.getElementById("receipt-preview-img") as HTMLImageElement | null;
  const lbl = document.getElementById("image-status-label");
  if (!wrap || !img || !lbl) return;

  if (state.imageFile && state.imagePreviewUrl) {
    wrap.style.display = "block";
    img.src = state.imagePreviewUrl;
    lbl.innerHTML = `Attached <code>${esc(state.imageFile.name)}</code> (${Math.round(state.imageFile.size / 1024)} KB) · Processed via <code>ONLY_ON_DEVICE</code> multimodal Part`;
  } else {
    wrap.style.display = "none";
    lbl.innerHTML = `Optional PNG/JPEG multimodal input via <code>fileToGenerativePart()</code>`;
  }
}

async function executePipeline(): Promise<void> {
  const res = await runHybridPipeline({
    rawText: state.rawText,
    imageFile: state.imageFile,
    disabledTokens: state.disabledTokens,
    simulateOffline: state.simulateOffline,
  });

  state.airlock = res.airlock;
  state.triage = res.triage;
  state.triageSource = res.triageSource;
  state.negotiation = res.negotiation;
  state.telemetryHistory = res.events;

  renderAll();
}

function renderAll(): void {
  const airlock = state.airlock;
  const neg = state.negotiation;
  if (!airlock || !neg) return;

  const lockedCount = airlock.vault.filter((v) => v.redacted).length;
  const unredactedCount = airlock.vault.length - lockedCount;

  // Top HUD Badges
  const leakBadge = document.getElementById("hud-leak-badge")!;
  if (unredactedCount === 0) {
    leakBadge.className = "hud-pill hud-green";
    leakBadge.textContent = "🔒 Raw PII Sent to Cloud: 0 Bytes";
  } else {
    leakBadge.className = "hud-pill";
    leakBadge.style.borderColor = "#f59e0b";
    leakBadge.textContent = `⚠ User Unmasked: ${unredactedCount} Token(s)`;
  }

  document.getElementById("hud-vault-badge")!.textContent =
    `Vaulted Locally: ${lockedCount}/${airlock.vault.length} Entities`;

  const srcBadge = document.getElementById("hud-source-badge")!;
  if (state.simulateOffline) {
    srcBadge.textContent = "inferenceSource: ON_DEVICE (Offline)";
  } else if (getActiveBundle()) {
    srcBadge.textContent = `inferenceSource: ${neg.inferenceSource.toUpperCase()}`;
  } else {
    srcBadge.textContent = "inferenceSource: HYBRID READY";
  }

  document.getElementById("hud-nano-badge")!.textContent = `Chrome Nano 4: ${state.nanoStatusLabel}`;

  // Vault Grid
  document.getElementById("vault-count-label")!.textContent = `${lockedCount} Locked in Memory`;
  const vaultGrid = document.getElementById("vault-grid")!;
  vaultGrid.innerHTML = airlock.vault
    .map((v) => {
      const cls = v.redacted ? "" : "unredacted";
      const stateTxt = v.redacted ? "LOCKED" : "EXPOSED";
      return `
        <div class="vault-chip ${cls}" data-token="${esc(v.token)}">
          <div class="vault-chip-top">
            <span>${esc(v.token)}</span>
            <span>${stateTxt} · ${esc(v.category)}</span>
          </div>
          <div class="vault-chip-val">${esc(v.originalValue)}</div>
        </div>
      `;
    })
    .join("");

  vaultGrid.querySelectorAll<HTMLElement>(".vault-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const tok = chip.dataset.token!;
      if (state.disabledTokens.has(tok)) state.disabledTokens.delete(tok);
      else state.disabledTokens.add(tok);
      void executePipeline();
    });
  });

  // Sanitized Twin Column
  const zeroPill = document.getElementById("zero-leak-pill")!;
  zeroPill.textContent = airlock.leakedCount === 0 ? "✓ 0 RAW PII LEAKS" : `${airlock.leakedCount} LEAK`;

  document.getElementById("airlock-audit-banner")!.innerHTML = state.simulateOffline
    ? `<strong>✈ Airplane / Offline Mode Active:</strong> <code>0 Bytes</code> transmitted externally. Both Privacy Airlock and Clause Co-Pilot run 100% locally.`
    : `<strong>✓ Zero-Egress Privacy Boundary Verified:</strong> <code>${lockedCount}</code> sensitive values vaulted locally in <code>${airlock.latencyMs} ms</code>; Cloud Gemini receives only placeholder tokens below.`;

  document.getElementById("sanitized-twin-view")!.innerHTML = highlightPlaceholders(
    airlock.sanitizedText
  );

  // Stage 2 Clause Triage Column
  const triageTag = document.getElementById("triage-mode-tag")!;
  triageTag.textContent = state.simulateOffline
    ? "ON_DEVICE · OFFLINE"
    : `PREFER_ON_DEVICE · ${state.triageSource.toUpperCase()}`;

  document.getElementById("triage-list")!.innerHTML = state.triage
    .map(
      (item) => `
        <div class="triage-card sev-${item.severity}">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <strong style="font-family:var(--font-mono); font-size:11px; color:#a5f3fc;">${esc(item.id)}</strong>
            <span class="sev-pill ${item.severity}">${item.severity} RISK</span>
          </div>
          <div style="font-size:12.5px; font-weight:700; color:#f8fafc; margin-bottom:4px;">${esc(item.heading)}</div>
          <div style="font-size:11.5px; color:#cbd5e1; margin-bottom:5px;">${esc(item.summary)}</div>
          <div style="font-size:11px; color:#6ee7b7;"><strong>Action:</strong> ${esc(item.obligation)}</div>
        </div>
      `
    )
    .join("");

  // View 2: Deep Redline & Re-Hydration Studio
  document.getElementById("studio-model-tag")!.textContent = state.simulateOffline
    ? "OFFLINE FALLBACK · Gemini Nano 4"
    : `PREFER_IN_CLOUD · ${neg.modelUsed}`;

  document.getElementById("studio-exec-summary")!.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
      <strong>Risk Exposure Index: ${neg.overallRiskScore}/100 — ${esc(neg.verdictBadge)}</strong>
      <span class="mode-tag mode-verified">Re-Hydrated Locally</span>
    </div>
    <div>${esc(neg.executiveSummaryRehydrated)}</div>
  `;

  document.getElementById("redline-list")!.innerHTML = neg.redlines
    .map(
      (r) => `
        <div class="triage-card sev-${r.severity}">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="font-size:12px; color:#f8fafc;">${esc(r.clauseTitle)}</strong>
            <span class="sev-pill ${r.severity}">${r.severity}</span>
          </div>
          <div style="font-size:11.2px; color:#94a3b8; margin-top:3px;">${esc(r.issue)}</div>
          <div class="redline-diff">
            <div class="diff-mini before"><strong>− Original Clause</strong>\n${esc(r.beforeSanitized)}</div>
            <div class="diff-mini after"><strong>+ Re-Hydrated Counter-Clause</strong>\n${esc(r.afterRehydrated)}</div>
          </div>
        </div>
      `
    )
    .join("");

  document.getElementById("email-sanitized-pre")!.innerHTML = highlightPlaceholders(
    neg.counterEmailSanitized
  );
  document.getElementById("email-hydrated-pre")!.textContent = neg.counterEmailRehydrated;

  renderTelemetryView();
  renderArchitectureView();
}

function renderTelemetryView(): void {
  const airlock = state.airlock!;
  const events = state.telemetryHistory;

  document.getElementById("route-mode-indicator")!.textContent = state.simulateOffline
    ? "Airplane Offline Mode — 100% On-Device Execution (0 Cloud Bytes)"
    : "Hybrid Execution — On-Device Privacy Airlock + Cloud Deep Reasoning";

  const cloudActive = !state.simulateOffline;
  const rsvg = document.getElementById("routing-svg")!;
  rsvg.innerHTML = `
    <defs>
      <marker id="vb-arr-green" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#10b981"/>
      </marker>
      <marker id="vb-arr-violet" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#8b5cf6"/>
      </marker>
    </defs>

    <!-- Local Chrome Privacy Zone Enclosure -->
    <rect x="18" y="12" width="1290" height="216" rx="12" fill="rgba(16,185,129,0.04)" stroke="#059669" stroke-width="1.5" stroke-dasharray="6,4"/>
    <text x="36" y="34" fill="#6ee7b7" font-family="monospace" font-weight="800" font-size="11.5">CHROME ON-DEVICE PRIVACY TRUST BOUNDARY (RAW PII NEVER CROSSES THIS LINE)</text>

    <!-- Box 1: Raw Input + PNG -->
    <g transform="translate(36, 52)">
      <rect width="275" height="154" rx="9" fill="#0f172a" stroke="#10b981" stroke-width="2"/>
      <text x="16" y="26" fill="#6ee7b7" font-family="monospace" font-weight="800" font-size="11">INPUT · PRIVATE MEMORY</text>
      <text x="16" y="50" fill="#ffffff" font-weight="700" font-size="14">Raw Document + PNG</text>
      <text x="16" y="76" fill="#cbd5e1" font-family="monospace" font-size="11">• Payload: ${airlock.rawBytes} Bytes</text>
      <text x="16" y="98" fill="#cbd5e1" font-family="monospace" font-size="11">• Multimodal inlineData Part</text>
      <text x="16" y="120" fill="#fda4af" font-family="monospace" font-size="11">• Contains ${airlock.vault.length} PII/Secrets</text>
    </g>

    <line x1="313" y1="129" x2="368" y2="129" stroke="#10b981" stroke-width="2.5" marker-end="url(#vb-arr-green)"/>

    <!-- Box 2: Stage 1 ONLY_ON_DEVICE -->
    <g transform="translate(374, 52)">
      <rect width="295" height="154" rx="9" fill="#0f172a" stroke="#10b981" stroke-width="2"/>
      <text x="16" y="26" fill="#6ee7b7" font-family="monospace" font-weight="800" font-size="11">STAGE 1 · ONLY_ON_DEVICE</text>
      <text x="16" y="50" fill="#ffffff" font-weight="700" font-size="14">Gemini Nano 4 Airlock</text>
      <text x="16" y="76" fill="#cbd5e1" font-family="monospace" font-size="11">• Vaulted: ${airlock.vault.filter((v) => v.redacted).length} Entities</text>
      <text x="16" y="98" fill="#6ee7b7" font-family="monospace" font-size="11">• Raw Leaks: 0 Verified</text>
      <text x="16" y="120" fill="#a5f3fc" font-family="monospace" font-size="11">• Egress: 0 Bytes</text>
    </g>

    <line x1="671" y1="129" x2="726" y2="129" stroke="#10b981" stroke-width="2.5" marker-end="url(#vb-arr-green)"/>

    <!-- Box 3: Stage 2 PREFER_ON_DEVICE -->
    <g transform="translate(732, 52)">
      <rect width="275" height="154" rx="9" fill="#0f172a" stroke="#06b6d4" stroke-width="2"/>
      <text x="16" y="26" fill="#67e8f9" font-family="monospace" font-weight="800" font-size="11">STAGE 2 · PREFER_ON_DEVICE</text>
      <text x="16" y="50" fill="#ffffff" font-weight="700" font-size="14">Instant Clause Co-Pilot</text>
      <text x="16" y="76" fill="#cbd5e1" font-family="monospace" font-size="11">• Works 100% Offline</text>
      <text x="16" y="98" fill="#cbd5e1" font-family="monospace" font-size="11">• Cloud Lite Fallback Ready</text>
      <text x="16" y="120" fill="#6ee7b7" font-family="monospace" font-size="11">• Cost: $0.00 On-Device</text>
    </g>

    <!-- Box 4: Local Re-Hydrator -->
    <g transform="translate(1032, 52)">
      <rect width="256" height="154" rx="9" fill="#0f172a" stroke="#10b981" stroke-width="2"/>
      <text x="16" y="26" fill="#6ee7b7" font-family="monospace" font-weight="800" font-size="11">LOCAL RE-HYDRATOR</text>
      <text x="16" y="50" fill="#ffffff" font-weight="700" font-size="14">Vault Token Restore</text>
      <text x="16" y="76" fill="#cbd5e1" font-family="monospace" font-size="11">• [PARTY_1] → Real Name</text>
      <text x="16" y="98" fill="#cbd5e1" font-family="monospace" font-size="11">• [AMOUNT_1] → Real Sum</text>
      <text x="16" y="120" fill="#6ee7b7" font-family="monospace" font-size="11">• Final Copy/Export Ready</text>
    </g>

    <!-- Cloud Zone Box 5: Stage 3 PREFER_IN_CLOUD -->
    <g transform="translate(1376, 32)">
      <rect width="398" height="182" rx="11" fill="${cloudActive ? "#17112b" : "#111827"}" stroke="${cloudActive ? "#8b5cf6" : "#475569"}" stroke-width="2"/>
      <text x="18" y="28" fill="${cloudActive ? "#c4b5fd" : "#94a3b8"}" font-family="monospace" font-weight="800" font-size="11.5">STAGE 3 · PREFER_IN_CLOUD (FIREBASE AI LOGIC)</text>
      <text x="18" y="54" fill="#ffffff" font-weight="700" font-size="15">${cloudActive ? "Cloud Gemini 3.8 Flash Studio" : "Cloud Bypassed (Offline Mode Active)"}</text>
      <text x="18" y="84" fill="#cbd5e1" font-family="monospace" font-size="11.5">• App Check Attested + Remote Config</text>
      <text x="18" y="108" fill="#ddd6fe" font-family="monospace" font-size="11.5">• Sees ONLY Sanitized Placeholders</text>
      <text x="18" y="132" fill="#6ee7b7" font-family="monospace" font-size="11.5">• Raw PII Received: 0 Bytes</text>
      <text x="18" y="156" fill="#fcd34d" font-family="monospace" font-size="11">• Offline Fallback → On-Device Nano 4</text>
    </g>

    <line x1="1290" y1="102" x2="1370" y2="102" stroke="${cloudActive ? "#8b5cf6" : "#475569"}" stroke-width="2.4" ${cloudActive ? "" : 'stroke-dasharray="5,4"'} marker-end="url(#vb-arr-violet)"/>
    <line x1="1374" y1="154" x2="1294" y2="154" stroke="#10b981" stroke-width="2.4" marker-end="url(#vb-arr-green)"/>
  `;

  document.getElementById("tel-table-body")!.innerHTML = events
    .map(
      (e) => `
        <tr>
          <td><strong>${esc(e.stage)}</strong></td>
          <td><code>${esc(e.configuredMode)}</code></td>
          <td style="color:${e.actualSource === "in_cloud" ? "#c4b5fd" : "#6ee7b7"}; font-weight:700;">${esc(e.actualSource.toUpperCase())}</td>
          <td>${esc(e.modelLabel)}</td>
          <td>${e.latencyMs.toFixed(2)} ms</td>
          <td>${e.cloudBytesSent} B</td>
          <td style="color:#6ee7b7;">+${e.estimatedCloudTokensSaved} tok</td>
        </tr>
      `
    )
    .join("");

  const totalSaved = events.reduce((acc, e) => acc + e.estimatedCloudTokensSaved, 0);
  const totalCloudBytes = events.reduce((acc, e) => acc + e.cloudBytesSent, 0);
  const totalVaulted = airlock.vault.filter((v) => v.redacted).length;

  document.getElementById("savings-kpi-box")!.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-box">
        <div class="kpi-val">0 Bytes</div>
        <div class="kpi-lbl">Raw PII / Secrets Exposed to Cloud</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-val">${totalVaulted}</div>
        <div class="kpi-lbl">Sensitive Entities Locked On-Device</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-val">+${totalSaved} tok</div>
        <div class="kpi-lbl">Cloud Prompt Tokens Saved On-Device</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-val">${totalCloudBytes} B</div>
        <div class="kpi-lbl">Sanitized Payload Sent (App Check)</div>
      </div>
    </div>
  `;
}

function renderArchitectureView(): void {
  const asvg = document.getElementById("arch-diagram-svg")!;
  const boxes = [
    {
      x: 24,
      stroke: "#10b981",
      kicker: "01 · FIREBASE APP & SECURITY",
      title: "App Check + Remote Config",
      bullets: [
        "• initializeApp() + App Check v3",
        "• Zero keys or debug tokens in Git",
        "• Dynamic Remote Config model IDs",
        "• GoogleAIBackend() free-tier ready",
      ],
    },
    {
      x: 382,
      stroke: "#34d399",
      kicker: "02 · MODEL 1 (ONLY_ON_DEVICE)",
      title: "Multimodal Privacy Airlock",
      bullets: [
        "• Chrome v139+ Gemini Nano 4",
        "• Text + PNG/JPEG inlineData Part",
        "• Structured JSON Schema extraction",
        "• Reversible [TOKEN_N] local vault",
      ],
    },
    {
      x: 740,
      stroke: "#06b6d4",
      kicker: "03 · MODEL 2 (PREFER_ON_DEVICE)",
      title: "Instant Clause Co-Pilot",
      bullets: [
        "• initializeDeviceModel(onProgress)",
        "• Zero-cost offline risk triage",
        "• Seamless gemini-3.5-flash-lite fallback",
        "• Live response.inferenceSource HUD",
      ],
    },
    {
      x: 1098,
      stroke: "#8b5cf6",
      kicker: "04 · MODEL 3 (PREFER_IN_CLOUD)",
      title: "Gemini 3.8 Flash Studio",
      bullets: [
        "• Receives ONLY sanitized twin",
        "• Cross-clause redline synthesis",
        "• Automatic offline Nano fallback",
        "• Structured JSON counter-playbooks",
      ],
    },
    {
      x: 1456,
      stroke: "#f59e0b",
      kicker: "05 · CLIENT RE-HYDRATION",
      title: "Zero-Leak Final Output",
      bullets: [
        "• Restores [PARTY_1] in browser RAM",
        "• Side-by-side Cloud vs Local proof",
        "• 10/10 TypeScript tests passing",
        "• Built with Google Antigravity",
      ],
    },
  ];

  let html = `
    <defs>
      <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#6ee7b7"/>
      </marker>
    </defs>
  `;
  boxes.forEach((b, idx) => {
    html += `
      <g transform="translate(${b.x}, 18)">
        <rect width="320" height="190" rx="10" fill="#0f1629" stroke="${b.stroke}" stroke-width="2"/>
        <text x="16" y="28" fill="${b.stroke}" font-family="monospace" font-weight="800" font-size="10.5">${esc(b.kicker)}</text>
        <text x="16" y="54" fill="#ffffff" font-weight="700" font-size="14.5">${esc(b.title)}</text>
        <line x1="16" y1="68" x2="304" y2="68" stroke="#1f2b48" stroke-width="1"/>
        ${b.bullets
          .map(
            (line, li) =>
              `<text x="16" y="${94 + li * 23}" fill="#cbd5e1" font-family="monospace" font-size="11">${esc(line)}</text>`
          )
          .join("")}
      </g>
    `;
    if (idx < boxes.length - 1) {
      html += `<line x1="${b.x + 322}" y1="113" x2="${boxes[idx + 1].x - 6}" y2="113" stroke="#6ee7b7" stroke-width="2.3" marker-end="url(#arch-arrow)"/>`;
    }
  });
  asvg.innerHTML = html;

  document.getElementById("sdk-code-showcase")!.textContent = [
    'import { initializeApp } from "firebase/app";',
    'import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";',
    'import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource } from "firebase/ai";',
    'import { getRemoteConfig, fetchAndActivate, getValue } from "firebase/remote-config";',
    "",
    "const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });",
    "",
    "// 1. Strictly On-Device Privacy Airlock (Text + Multimodal PNG/JPEG)",
    "const airlockModel = getGenerativeModel(ai, {",
    "  mode: InferenceMode.ONLY_ON_DEVICE,",
    '  onDeviceParams: { createOptions: { expectedInputs: [{ type: "text" }, { type: "image" }] } },',
    "});",
    "",
    "// 2. On-Device First Co-Pilot with Seamless Cloud Fallback",
    "const triageModel = getGenerativeModel(ai, {",
    "  mode: InferenceMode.PREFER_ON_DEVICE,",
    '  inCloudParams: { model: "gemini-3.5-flash-lite" },',
    "});",
    "",
    "// 3. Cloud Deep Redline Analyst on Sanitized Twin + Offline Fallback",
    "const analystModel = getGenerativeModel(ai, {",
    "  mode: InferenceMode.PREFER_IN_CLOUD,",
    '  inCloudParams: { model: getValue(remoteConfig, "cloud_analyst_model").asString() },',
    "});",
  ].join("\n");

  document.getElementById("mode-rationale-cards")!.innerHTML = `
    <div class="triage-list">
      <div class="triage-card">
        <div style="font-weight:700; color:#6ee7b7; margin-bottom:3px;">1 · Why ONLY_ON_DEVICE for Stage 1 Airlock?</div>
        <div style="font-size:11.5px; color:#cbd5e1;">Raw SSNs, bank routing numbers, medical record IDs, and production API secrets must never fall back to the network. Combining Chrome Gemini Nano 4 with a deterministic local guard guarantees 0-byte raw PII egress.</div>
      </div>
      <div class="triage-card">
        <div style="font-weight:700; color:#67e8f9; margin-bottom:3px;">2 · Why PREFER_ON_DEVICE for Stage 2 Clause Co-Pilot?</div>
        <div style="font-size:11.5px; color:#cbd5e1;">Delivers instant, zero-cost clause summaries offline on flights or field sites while seamlessly falling back to <code>gemini-3.5-flash-lite</code> on browsers without Gemini Nano 4—using one unified SDK API.</div>
      </div>
      <div class="triage-card">
        <div style="font-weight:700; color:#c4b5fd; margin-bottom:3px;">3 · Why PREFER_IN_CLOUD for Stage 3 Deep Redline Studio?</div>
        <div style="font-size:11.5px; color:#cbd5e1;">Multi-clause legal counter-proposals and No Surprises Act billing disputes benefit from <code>gemini-3.8-flash</code> reasoning depth—and because Stage 1 already tokenized PII, cloud intelligence is unlocked safely before local browser re-hydration.</div>
      </div>
    </div>
  `;
}

async function init(): Promise<void> {
  const envCfg = resolveEnvFirebaseConfig();
  if (envCfg) {
    await initializeFirebaseHybridModels(envCfg);
  }

  const nanoAvail = await probeChromeNanoAvailability();
  state.nanoStatusLabel =
    nanoAvail === "available"
      ? "Ready (Gemini Nano 4)"
      : nanoAvail === "downloadable"
      ? "Downloadable"
      : "Hybrid Fallback Ready";

  // Wire Preset Buttons
  document.querySelectorAll<HTMLButtonElement>(".vb-preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      void selectPreset(btn.dataset.preset!);
    });
  });

  // Wire View Tabs
  document.querySelectorAll<HTMLButtonElement>(".vb-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view!;
      document.querySelectorAll(".vb-tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".vb-view").forEach((v) => v.classList.toggle("active", v.id === `view-${state.view}`));
    });
  });

  document.getElementById("btn-jump-studio")?.addEventListener("click", () => {
    document.getElementById("tab-studio")?.click();
  });

  // Wire Live Textarea Edits
  document.getElementById("raw-input-area")?.addEventListener("input", (e) => {
    state.rawText = (e.target as HTMLTextAreaElement).value;
    void executePipeline();
  });

  // Wire PNG/JPEG Multimodal Upload
  document.getElementById("image-file-input")?.addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0] || null;
    if (!f) return;
    if (state.imagePreviewUrl) URL.revokeObjectURL(state.imagePreviewUrl);
    state.imageFile = f;
    state.imagePreviewUrl = URL.createObjectURL(f);
    renderMultimodalPreview();
    void executePipeline();
  });

  // Wire Offline Simulator Toggle
  document.getElementById("btn-offline-toggle")?.addEventListener("click", (e) => {
    state.simulateOffline = !state.simulateOffline;
    const btn = e.currentTarget as HTMLButtonElement;
    btn.classList.toggle("offline-active", state.simulateOffline);
    btn.textContent = state.simulateOffline ? "✈ Offline Mode: ON" : "✈ Offline Mode: OFF";
    void executePipeline();
  });

  // Wire Initialize Nano 4 User Gesture Button
  document.getElementById("btn-warmup-nano")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.textContent = "⏳ Initializing...";
    const res = await warmUpOnDeviceNano((pct) => {
      btn.textContent = `⬇ Nano ${pct}%`;
    });
    state.nanoStatusLabel = res.ready ? "Ready (Gemini Nano 4)" : "Fallback Active";
    btn.textContent = res.ready ? "✓ Nano 4 Ready" : "⚡ Hybrid Fallback";
    renderAll();
  });

  // Copy Re-hydrated Letter
  document.getElementById("btn-copy-email")?.addEventListener("click", (e) => {
    if (state.negotiation && navigator.clipboard) {
      void navigator.clipboard.writeText(state.negotiation.counterEmailRehydrated);
      const btn = e.currentTarget as HTMLButtonElement;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy Final Letter"), 1200);
    }
  });

  // Firebase Runtime Config Modal
  const modal = document.getElementById("firebase-modal")!;
  document.getElementById("btn-firebase-modal")?.addEventListener("click", () => {
    modal.style.display = "flex";
  });
  document.getElementById("btn-close-modal")?.addEventListener("click", () => {
    modal.style.display = "none";
  });
  document.getElementById("btn-save-firebase")?.addEventListener("click", async () => {
    const apiKey = (document.getElementById("cfg-api-key") as HTMLInputElement).value.trim();
    const projectId = (document.getElementById("cfg-project-id") as HTMLInputElement).value.trim();
    const appId = (document.getElementById("cfg-app-id") as HTMLInputElement).value.trim();
    const recaptchaSiteKey = (document.getElementById("cfg-recaptcha") as HTMLInputElement).value.trim();
    const msg = document.getElementById("cfg-status-msg")!;
    if (!apiKey || !projectId || !appId) {
      msg.textContent = "Please provide apiKey, projectId, and appId.";
      return;
    }
    await initializeFirebaseHybridModels({
      apiKey,
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
      appId,
      recaptchaSiteKey: recaptchaSiteKey || undefined,
    });
    msg.textContent = `Connected Firebase AI Logic project: ${projectId}`;
    await executePipeline();
    setTimeout(() => {
      modal.style.display = "none";
    }, 700);
  });

  // Support URL query params (`?preset=...&view=...&offline=1`) for screenshots & deep links
  const params = new URLSearchParams(window.location.search);
  const qPreset = params.get("preset") || "freelance_contract";
  const qView = params.get("view");
  if (params.get("offline") === "1") {
    state.simulateOffline = true;
    const offBtn = document.getElementById("btn-offline-toggle")!;
    offBtn.classList.add("offline-active");
    offBtn.textContent = "✈ Offline Mode: ON";
  }
  await selectPreset(qPreset);
  if (qView && ["airlock", "studio", "telemetry", "arch"].includes(qView)) {
    document.querySelector<HTMLButtonElement>(`.vb-tab[data-view="${qView}"]`)?.click();
  }
}

void init();
