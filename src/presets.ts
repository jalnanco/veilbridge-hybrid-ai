import type { PresetScenario } from "./types";

export const VEILBRIDGE_PRESETS: PresetScenario[] = [
  {
    id: "freelance_contract",
    label: "1. Freelance IP-Trap Contract",
    docType: "CONTRACT",
    badge: "MSA · 7 PII Entities",
    description:
      "Synthetic Master Services Agreement containing contractor tax ID, bank routing/account, home street address, email, phone, and $16,500 rate alongside aggressive IP & indemnity traps.",
    rawText: [
      "MASTER INDEPENDENT CONTRACTOR AGREEMENT (SYNTHETIC SAMPLE)",
      "",
      "This Agreement is entered into between Horizon Cloud Robotics Inc. (\"Client\") and Alex Rivera (\"Contractor\"),",
      "residing at 742 Evergreen Avenue, Suite 4B, Austin, TX 78701 (Tax/SSN: 000-48-2910, Phone: (512) 555-0194, Email: alex.rivera@example.org).",
      "",
      "SECTION 2.4 — COMPENSATION & PAYMENT TERMS",
      "Client shall compensate Contractor a project retainer of $16,500.00 wired to Routing #111000025 / Acct #8849201143.",
      "All invoices are payable Net-90 days after Client's unilateral written determination of satisfaction, and Client may withhold payment at its sole discretion.",
      "",
      "SECTION 4.2 — INTELLECTUAL PROPERTY & PRE-EXISTING TOOLS",
      "Contractor Alex Rivera hereby irrevocably assigns to Client all right, title, and interest in all deliverables AND any pre-existing libraries, personal frameworks, or diagnostic scripts used during the Engagement as work-for-hire in perpetuity.",
      "",
      "SECTION 7.1 — UNLIMITED INDEMNIFICATION",
      "Contractor shall defend and indemnify Client against any and all third-party claims, indirect losses, and consequential damages without financial cap or limitation of liability.",
    ].join("\n"),
  },
  {
    id: "hospital_bill",
    label: "2. Hospital Bill (Multimodal PNG)",
    docType: "MEDICAL_BILL",
    badge: "Multimodal PNG · 6 PII Entities",
    description:
      "Synthetic itemized Emergency Department statement + rendered PNG invoice image (`fileToGenerativePart` multimodal input) containing patient MRN, SSN, address, card, and duplicate CPT 99285 charges.",
    hasSyntheticReceiptImage: true,
    rawText: [
      "BAYSIDE GENERAL MEDICAL CENTER — ITEMIZED PATIENT STATEMENT (SYNTHETIC)",
      "Patient Name: Jordan Vance   |   Medical Record: MRN-804219   |   SSN: 000-73-5120",
      "Billing Address: 1280 Harbor Boulevard, Unit 9A, Seattle, WA 98101   |   Contact: (206) 555-0148   |   Email: jordan.vance@example.org",
      "Autopay Card on File: 4111 2222 3333 4444",
      "",
      "ITEMIZED ENCOUNTER CHARGES (EMERGENCY DEPARTMENT):",
      "01. Facility Emergency Dept Triage Fee ................................. $1,840.00",
      "02. CPT 99285 — Emergency Dept Visit Level 5 (High Severity) ........... $3,420.00",
      "03. CPT 99285 — Duplicate Emergency Dept Visit Level 5 Entry ........... $3,420.00",
      "04. Ancillary Out-of-Network ER Physician Balance Surcharge ............ $2,190.00",
      "05. Unbundled Sterile Gauze & IV Starter Supply Tray ................... $485.00",
      "",
      "TOTAL PATIENT BALANCE DUE IMMEDIATELY: $11,355.00",
    ].join("\n"),
  },
  {
    id: "prod_crash_log",
    label: "3. Prod Crash Log with Secrets",
    docType: "INCIDENT_LOG",
    badge: "DevSecOps · 6 Secrets/PII",
    description:
      "Synthetic production crash trace leaking example AWS access keys, Postgres credentials, JWT tokens, and on-call engineer contact details inside an unhandled connection-pool retry storm.",
    rawText: [
      "[2026-11-24T06:14:09.412Z] FATAL payment-ledger-worker (oncall: Marcus Thorne, marcus.thorne@example.org, +1 415-555-0172)",
      "UnhandledRejection: UpstreamPoolExhaustedError: timeout acquiring slot after 4200ms (active=100/100)",
      "  env.AWS_ACCESS_KEY_ID = AKIAIOSFODNN7EXAMPLE",
      "  env.DATABASE_URL = postgres://ledger_admin:synth_pass_9921@db-prod.internal:5432/settlements",
      "  headers.Authorization = Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfOTAxMiIsInJvbGUiOiJhZG1pbiJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "  stripeWebhookKey = sk_test_51NzSyntheticExampleKey99012345",
      "  at RetryLoop.reconnectWithoutBackoff (/srv/app/db/pool.ts:118:15) -> while (!connected) { await pool.connect(); }",
      "  settlement_batch_value = $48,920.00 (Acct #7730192844)",
    ].join("\n"),
  },
];

/**
 * Generates a crisp synthetic PNG receipt File in browser memory for multimodal `fileToGenerativePart` verification.
 */
export async function generateSyntheticInvoicePngFile(): Promise<File | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, 720, 360);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, 720, 56);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 17px monospace";
  ctx.fillText("BAYSIDE MEDICAL CENTER — ITEMIZED ER INVOICE (SYNTHETIC)", 20, 35);

  ctx.fillStyle = "#334155";
  ctx.font = "13px monospace";
  ctx.fillText("Patient: Jordan Vance   |   MRN-804219   |   SSN: 000-73-5120", 20, 84);
  ctx.fillText("1280 Harbor Boulevard, Unit 9A, Seattle, WA 98101 | (206) 555-0148", 20, 106);

  ctx.strokeStyle = "#cbd5e1";
  ctx.beginPath();
  ctx.moveTo(20, 122);
  ctx.lineTo(700, 122);
  ctx.stroke();

  const rows = [
    ["01. ER Facility Triage Fee", "$1,840.00"],
    ["02. CPT 99285 Level-5 ER Visit", "$3,420.00"],
    ["03. CPT 99285 Level-5 ER Visit (DUPLICATE)", "$3,420.00"],
    ["04. Out-of-Network Physician Surcharge", "$2,190.00"],
    ["05. Unbundled Sterile IV Supply Tray", "$485.00"],
  ];
  rows.forEach(([desc, amt], idx) => {
    const y = 152 + idx * 28;
    ctx.fillStyle = idx === 2 ? "#be123c" : "#0f172a";
    ctx.font = idx === 2 ? "bold 13px monospace" : "13px monospace";
    ctx.fillText(desc, 24, y);
    ctx.fillText(amt, 595, y);
  });

  ctx.fillStyle = "#fee2e2";
  ctx.fillRect(20, 298, 680, 42);
  ctx.fillStyle = "#991b1b";
  ctx.font = "bold 15px monospace";
  ctx.fillText("TOTAL PATIENT BALANCE DUE: $11,355.00  [LOCAL MULTIMODAL AIRLOCK]", 32, 325);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return new File([blob], "synthetic_er_invoice.png", { type: "image/png" });
}
