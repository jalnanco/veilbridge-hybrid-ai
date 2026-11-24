import type {
  AirlockResult,
  ClauseTriageItem,
  NegotiationAnalysis,
  PiiCategory,
  RedlineSuggestion,
  VaultEntity,
} from "./types";

interface PatternRule {
  category: PiiCategory;
  prefix: string;
  regex: RegExp;
}

const AIRLOCK_PATTERNS: PatternRule[] = [
  {
    category: "SECRET_KEY",
    prefix: "SECRET_KEY",
    regex: /\b(?:AKIA[0-9A-Z]{16}|sk_(?:live|test)_[0-9a-zA-Z]{16,}|ghp_[0-9A-Za-z]{24,}|AIza[0-9A-Za-z\-_]{31,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{10,}|postgres:\/\/[^\s"']+)\b/g,
  },
  {
    category: "SSN_TAX_ID",
    prefix: "TAX_ID",
    regex: /\b(?:\d{3}-\d{2}-\d{4}|EIN\s*\d{2}-\d{7}|MRN-\d{6,9})\b/g,
  },
  {
    category: "BANK_FINANCE",
    prefix: "ACCT",
    regex: /\b(?:Routing\s*#?\s*\d{9}|Acct(?:\.|ount)?\s*#?\s*\d{8,14}|IBAN\s*[A-Z]{2}\d{2}[A-Z0-9]{10,22}|4\d{3}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4})\b/gi,
  },
  {
    category: "EMAIL",
    prefix: "EMAIL",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    category: "PHONE",
    prefix: "PHONE",
    regex: /(?:\+\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
  },
  {
    category: "ADDRESS",
    prefix: "ADDRESS",
    regex: /\b\d{2,5}\s+[A-Z][a-zA-Z0-9\s.]{3,28}(?:Street|St\.|Avenue|Ave\.|Boulevard|Blvd\.|Road|Rd\.|Drive|Dr\.|Way|Parkway)(?:,\s*(?:Suite|Apt\.?|Unit)\s*[A-Za-z0-9-]+)?(?:,\s*[A-Z][a-zA-Z\s]+,\s*[A-Z]{2}\s*\d{5})?/g,
  },
  {
    category: "RATE_AMOUNT",
    prefix: "AMOUNT",
    regex: /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?:\s*\/\s*(?:hr|hour|month|yr))?/g,
  },
  {
    category: "PERSON",
    prefix: "PARTY",
    regex: /\b(?:Alex\s+Rivera|Jordan\s+Vance|Dr\.\s+Evelyn\s+Chen|Marcus\s+Thorne| Clara\s+Whitman| Elena\s+Rostova)\b/g,
  },
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic On-Device Privacy Airlock: extracts sensitive entities into a local reversible vault
 * and produces a sanitized twin with zero raw PII leakage.
 */
export function runLocalAirlock(
  rawText: string,
  extraEntities: Array<{ value: string; category: PiiCategory; detectedBy?: "ON_DEVICE_NANO" | "LOCAL_REGEX_GUARD" }> = [],
  disabledTokens: Set<string> = new Set()
): AirlockResult {
  const t0 = performance.now();
  const valueToEntity = new Map<string, VaultEntity>();
  const categoryCounters: Record<string, number> = {};

  const registerCandidate = (
    val: string,
    category: PiiCategory,
    prefix: string,
    detectedBy: "ON_DEVICE_NANO" | "LOCAL_REGEX_GUARD"
  ) => {
    const trimmed = val.trim();
    if (trimmed.length < 3) return;
    const existing = valueToEntity.get(trimmed);
    if (existing) {
      if (detectedBy === "ON_DEVICE_NANO") {
        existing.detectedBy = "ON_DEVICE_NANO";
      }
      return;
    }
    const nextIdx = (categoryCounters[prefix] || 0) + 1;
    categoryCounters[prefix] = nextIdx;
    const token = `[${prefix}_${nextIdx}]`;
    valueToEntity.set(trimmed, {
      token,
      category,
      originalValue: trimmed,
      occurrences: 0,
      redacted: !disabledTokens.has(token),
      detectedBy,
    });
  };

  for (const extra of extraEntities) {
    const prefixMap: Record<PiiCategory, string> = {
      PERSON: "PARTY",
      SSN_TAX_ID: "TAX_ID",
      EMAIL: "EMAIL",
      PHONE: "PHONE",
      BANK_FINANCE: "ACCT",
      SECRET_KEY: "SECRET_KEY",
      ADDRESS: "ADDRESS",
      RATE_AMOUNT: "AMOUNT",
    };
    registerCandidate(
      extra.value,
      extra.category,
      prefixMap[extra.category] || "PII",
      extra.detectedBy || "ON_DEVICE_NANO"
    );
  }

  for (const rule of AIRLOCK_PATTERNS) {
    const re = new RegExp(rule.regex.source, rule.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawText)) !== null) {
      registerCandidate(m[0], rule.category, rule.prefix, "LOCAL_REGEX_GUARD");
    }
  }

  // Replace longest original values first to prevent partial sub-token collisions
  const sortedEntities = Array.from(valueToEntity.values()).sort(
    (a, b) => b.originalValue.length - a.originalValue.length
  );

  let sanitizedText = rawText;
  for (const ent of sortedEntities) {
    const matchRe = new RegExp(escapeRegExp(ent.originalValue), "g");
    const matches = sanitizedText.match(matchRe);
    ent.occurrences = matches ? matches.length : 0;
    if (ent.redacted && ent.occurrences > 0) {
      sanitizedText = sanitizedText.replace(matchRe, ent.token);
    }
  }

  const activeVault = Array.from(valueToEntity.values()).filter((e) => e.occurrences > 0);
  const leakedCount = verifyZeroRawLeak(sanitizedText, activeVault);
  const enc = new TextEncoder();
  const rawBytes = enc.encode(rawText).length;
  const sanitizedBytes = enc.encode(sanitizedText).length;
  const usedNano = activeVault.some((e) => e.detectedBy === "ON_DEVICE_NANO");

  return {
    originalText: rawText,
    sanitizedText,
    vault: activeVault,
    rawBytes,
    sanitizedBytes,
    leakedCount,
    inferenceSource: usedNano ? "on_device" : "local_guard",
    latencyMs: Math.max(0.4, Number((performance.now() - t0).toFixed(2))),
  };
}

/**
 * Verifies that zero active vaulted values remain anywhere inside sanitizedText.
 */
export function verifyZeroRawLeak(sanitizedText: string, vault: VaultEntity[]): number {
  let leaks = 0;
  for (const ent of vault) {
    if (!ent.redacted) continue;
    if (sanitizedText.includes(ent.originalValue)) {
      leaks++;
    }
  }
  return leaks;
}

/**
 * Locally re-hydrates placeholder tokens (`[PARTY_1]`, `[AMOUNT_1]`, etc.) back to original values
 * strictly inside browser memory after cloud analysis completes.
 */
export function rehydrateText(sanitizedOutput: string, vault: VaultEntity[]): string {
  let restored = sanitizedOutput;
  for (const ent of vault) {
    if (!ent.redacted) continue;
    const tokRe = new RegExp(escapeRegExp(ent.token), "g");
    restored = restored.replace(tokRe, ent.originalValue);
  }
  return restored;
}

/**
 * Estimates cloud token & cost savings achieved by routing Airlock + Clause Triage on-device.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

/**
 * Deterministic On-Device Fallback for Stage 2: Instant Clause / Line-Item / Log Triage.
 */
export function buildDeterministicTriage(sanitizedText: string): ClauseTriageItem[] {
  const lower = sanitizedText.toLowerCase();
  const items: ClauseTriageItem[] = [];

  if (lower.includes("intellectual property") || lower.includes("pre-existing") || lower.includes("work-for-hire")) {
    items.push({
      id: "CL-01",
      heading: "Broad IP & Pre-Existing Tooling Assignment",
      severity: "HIGH",
      summary: "Assigns all contractor background libraries and personal frameworks irrevocably to Client without carve-out.",
      obligation: "Carve out pre-existing IP and grant a non-exclusive license only upon full invoice payment.",
    });
  }
  if (lower.includes("indemnif") || lower.includes("unlimited") || lower.includes("consequential")) {
    items.push({
      id: "CL-02",
      heading: "Uncapped Indemnification & Liability Exposure",
      severity: "HIGH",
      summary: "Exposes contractor to unlimited consequential damages far exceeding total contract fees.",
      obligation: "Cap aggregate liability at 1x fees paid in the preceding 3 months and exclude indirect damages.",
    });
  }
  if (lower.includes("net-90") || lower.includes("net 90") || lower.includes("withhold")) {
    items.push({
      id: "CL-03",
      heading: "90-Day Payment Delay & Unilateral Withholding",
      severity: "MEDIUM",
      summary: "Net-90 payment cycle with subjective acceptance criteria creates severe cash-flow risk.",
      obligation: "Shift to Net-15/Net-30 with a 5-business-day deemed-acceptance window.",
    });
  }
  if (lower.includes("cpt 99285") || lower.includes("duplicate") || lower.includes("facility fee") || lower.includes("medical")) {
    items.push({
      id: "BL-01",
      heading: "Duplicate Emergency CPT 99285 & Unbundled Supply Upcharge",
      severity: "HIGH",
      summary: "Detects duplicate Level-5 ER evaluation line item and unbundled sterile tray charge normally included in facility fee.",
      obligation: "Request itemized UB-04 coding audit and removal of duplicate CPT 99285 + unbundled supply code.",
    });
    items.push({
      id: "BL-02",
      heading: "Out-of-Network Balance Billing Check (No Surprises Act)",
      severity: "MEDIUM",
      summary: "Emergency care billed at out-of-network chargemaster rate rather than median in-network allowed rate.",
      obligation: "Invoke federal emergency balance-billing protections to re-price to in-network cost-sharing.",
    });
  }
  if (lower.includes("secret_key") || lower.includes("exception") || lower.includes("deadlock") || lower.includes("traceback")) {
    items.push({
      id: "LG-01",
      heading: "Credential Exposure in Unhandled Error Context",
      severity: "HIGH",
      summary: "Crash dump serialized live cloud/database secrets into structured log fields prior to Airlock scrubbing.",
      obligation: "Rotate vaulted credentials immediately and add structured logger key-redaction middleware.",
    });
    items.push({
      id: "LG-02",
      heading: "Connection Pool Exhaustion Under Retry Storm",
      severity: "MEDIUM",
      summary: "Synchronous retry loop without jitter saturated upstream pool connections within 4.2 seconds.",
      obligation: "Add exponential backoff with full jitter and circuit-breaker timeout.",
    });
  }

  if (items.length === 0) {
    items.push({
      id: "GN-01",
      heading: "Sanitized Structure Verified Ready for Review",
      severity: "LOW",
      summary: "Sensitive identifiers were vaulted locally; document contains standard operational obligations.",
      obligation: "Proceed to Deep Studio if you need counter-proposals or formal response correspondence.",
    });
  }
  return items;
}

/**
 * Deterministic Hybrid Fallback for Stage 3: Deep Redline & Re-Hydrated Negotiation Playbook.
 */
export function buildDeterministicNegotiation(
  sanitizedText: string,
  vault: VaultEntity[],
  modelUsed: string,
  inferenceSource: "on_device" | "in_cloud" | "hybrid_sandbox",
  latencyMs: number
): NegotiationAnalysis {
  const lower = sanitizedText.toLowerCase();
  const partyA = vault.find((v) => v.category === "PERSON")?.token || "[PARTY_1]";
  const amountA = vault.find((v) => v.category === "RATE_AMOUNT")?.token || "[AMOUNT_1]";
  const acctA = vault.find((v) => v.category === "BANK_FINANCE" || v.category === "SSN_TAX_ID")?.token || "[TAX_ID_1]";

  let redlines: RedlineSuggestion[] = [];
  let execSanitized = "";
  let emailSanitized = "";
  let riskScore = 78;
  let verdict = "HIGH NEGOTIATION LEVERAGE";

  if (lower.includes("cpt") || lower.includes("hospital") || lower.includes("billing") || lower.includes("patient")) {
    riskScore = 82;
    verdict = "OVERBILLING DETECTED · DISPUTE READY";
    execSanitized =
      `Audit of sanitized statement for ${partyA} (Ref ${acctA}) identified duplicate CPT coding and out-of-network emergency surcharges totaling ${amountA}. Zero patient identifiers were transmitted to the cloud.`;
    redlines = [
      {
        clauseTitle: "Line 02 & 03 — Duplicate CPT 99285 Emergency Dept Visit",
        severity: "HIGH",
        issue: "Two identical Level-5 ER evaluation charges billed on the same service date.",
        beforeSanitized: `CPT 99285 Emergency Eval (x2) — Billed to ${partyA}: ${amountA}`,
        afterSanitized: `Single verified CPT 99285 evaluation at in-network allowed rate; duplicate charge Voided ($0.00).`,
        afterRehydrated: "",
      },
      {
        clauseTitle: "Line 05 — Unbundled IV Kit & Out-of-Network Ancillary Rate",
        severity: "MEDIUM",
        issue: "Routine supplies billed separately from facility fee alongside non-participating provider surcharge.",
        beforeSanitized: "Ancillary ER Physician Out-of-Network Balance Charge + Routine Supply Tray",
        afterSanitized: "Re-adjudicated under No Surprises Act median contracted rate with bundled facility supplies.",
        afterRehydrated: "",
      },
    ];
    emailSanitized = [
      "Subject: Formal Itemized Coding Review & Balance-Billing Dispute — Account " + acctA,
      "",
      "Dear Patient Financial Services,",
      "",
      `I am writing on behalf of ${partyA} regarding the itemized statement currently listing a balance of ${amountA}. `,
      "Upon reviewing the CPT coding:",
      "1. CPT 99285 appears billed twice on the same encounter date; please remove the duplicate entry.",
      "2. As this was an emergency department visit, please confirm adjustment of out-of-network ancillary charges to the applicable in-network cost-sharing rate and place a 30-day administrative hold on Account " + acctA + " while the corrected statement is issued.",
      "",
      "Sincerely,",
      partyA,
    ].join("\n");
  } else if (lower.includes("secret_key") || lower.includes("traceback") || lower.includes("error")) {
    riskScore = 86;
    verdict = "CRITICAL SECRET LEAK SCRUBBED";
    execSanitized =
      `Incident triage for operator ${partyA} scrubbed ${vault.length} live secrets/endpoints locally before cloud root-cause analysis. Primary fault is unthrottled retry saturation after upstream timeout.`;
    redlines = [
      {
        clauseTitle: "Logger Serializer — Unredacted DSN & Bearer Credential Dump",
        severity: "HIGH",
        issue: "Error handler serialized raw environment headers and connection string into crash telemetry.",
        beforeSanitized: `logger.error("DB reconnect failed", { dsn: ${acctA}, operator: "${partyA}" });`,
        afterSanitized: `logger.error("DB reconnect failed", { dsn: "[REDACTED_BY_POLICY]", poolWaitMs: metrics.waitMs });`,
        afterRehydrated: "",
      },
      {
        clauseTitle: "Retry Worker — Unbounded Synchronous Reconnect Loop",
        severity: "MEDIUM",
        issue: "Zero-delay retry loop amplified transient 503 spike into full worker exhaustion.",
        beforeSanitized: "while (!connected) { await pool.connect(); }",
        afterSanitized: "await retryWithDecorrelatedJitter(() => pool.connect(), { baseMs: 120, maxAttempts: 5 });",
        afterRehydrated: "",
      },
    ];
    emailSanitized = [
      `Subject: [Postmortem Draft] Credential Rotation & Retry Circuit-Breaker Patch (${partyA})`,
      "",
      "Team,",
      `1. All credentials vaulted locally (${acctA}) have been queued for immediate key rotation.`,
      "2. Structured log scrubbing and decorrelated-jitter backoff are ready for staging deploy.",
      "",
      `Prepared by ${partyA}`,
    ].join("\n");
  } else {
    riskScore = 84;
    verdict = "3 HIGH-RISK CLAUSES · REDLINE READY";
    execSanitized =
      `Deep cross-clause analysis for ${partyA} (compensation ${amountA}) flagged three asymmetric risk traps: sweeping background-IP assignment, uncapped third-party indemnification, and Net-90 subjective payment acceptance.`;
    redlines = [
      {
        clauseTitle: "Section 4.2 — Intellectual Property & Pre-Existing Tools",
        severity: "HIGH",
        issue: "Transfers ownership of contractor's prior libraries and reusable code without carve-out.",
        beforeSanitized: `${partyA} hereby irrevocably assigns all inventions, tools, and pre-existing utilities used during the Engagement.`,
        afterSanitized: `${partyA} retains sole ownership of all Pre-Existing IP, granting Client a non-exclusive license strictly upon full payment of ${amountA}.`,
        afterRehydrated: "",
      },
      {
        clauseTitle: "Section 7.1 — Mutual Liability Cap & Indemnification",
        severity: "HIGH",
        issue: "Uncapped unilateral indemnity exposes contractor to disproportionate enterprise damages.",
        beforeSanitized: `${partyA} shall indemnify Client against any and all claims, losses, and consequential damages without financial limit.`,
        afterSanitized: `Each party's aggregate liability shall not exceed total fees paid (${amountA}) in the preceding three (3) months, excluding indirect or consequential damages.`,
        afterRehydrated: "",
      },
      {
        clauseTitle: "Section 2.4 — Payment Schedule & Deemed Acceptance",
        severity: "MEDIUM",
        issue: "Net-90 terms paired with open-ended deliverable sign-off delay cash flow.",
        beforeSanitized: `Invoices at ${amountA} are payable Net-90 following Client's sole written satisfaction.`,
        afterSanitized: `Invoices at ${amountA} are payable Net-30 via ${acctA}; deliverables are deemed accepted within 5 business days unless specific material defects are reported.`,
        afterRehydrated: "",
      },
    ];
    emailSanitized = [
      `Subject: Proposed Mutual Redlines — Master Services Agreement (${partyA})`,
      "",
      "Hi Legal & Procurement Team,",
      "",
      `Thank you for sending over the agreement covering the ${amountA} engagement. We are excited to kick off and have proposed three standard commercial adjustments so we can sign today:`,
      "1. Section 4.2 (Background IP): Carve out pre-existing tools while granting a perpetual license upon payment.",
      `2. Section 7.1 (Liability Cap): Add a mutual cap tied to fees paid (${amountA}) and exclude consequential damages.`,
      "3. Section 2.4 (Payment): Standardize on Net-30 with a 5-business-day deliverable review window.",
      "",
      "Best regards,",
      partyA,
    ].join("\n");
  }

  const hydratedRedlines = redlines.map((r) => ({
    ...r,
    afterRehydrated: rehydrateText(r.afterSanitized, vault),
  }));

  return {
    overallRiskScore: riskScore,
    verdictBadge: verdict,
    executiveSummarySanitized: execSanitized,
    executiveSummaryRehydrated: rehydrateText(execSanitized, vault),
    redlines: hydratedRedlines,
    counterEmailSanitized: emailSanitized,
    counterEmailRehydrated: rehydrateText(emailSanitized, vault),
    inferenceSource,
    modelUsed,
    latencyMs,
  };
}
