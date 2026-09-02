import { assertReportModel } from "./report-model.js";

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function rateText(rate) {
  if (rate === null) return "No data";
  const text = (rate * 100).toFixed(1).replace(/\.0$/, "");
  return `${text}%`;
}

function scorecard(label, rate, exactCounts) {
  return [
    '<article class="scorecard">',
    `<h3>${escapeHtml(label)}</h3>`,
    `<p class="rate">${escapeHtml(rateText(rate))}</p>`,
    `<p class="exact-counts">${escapeHtml(exactCounts)}</p>`,
    "</article>"
  ].join("");
}

function bucketRows(account) {
  const labels = {
    within5m: "Within 5 minutes",
    within1h: "Over 5 minutes through 1 hour",
    within24h: "Over 1 hour through 24 hours",
    over24h: "Over 24 hours"
  };
  const denominator = account.counts.repliedMessages;
  return Object.entries(labels).map(([field, label]) => {
    const count = account.replySpeed.buckets[field];
    const width = denominator === 0 ? 0 : (count / denominator) * 100;
    const widthText = width.toFixed(2);
    return [
      '<div class="bucket-row">',
      `<span>${escapeHtml(label)}</span>`,
      '<span class="bucket-track" aria-hidden="true">',
      `<span class="bucket-fill" style="width:${escapeHtml(widthText)}%"></span>`,
      "</span>",
      `<strong>${escapeHtml(count)}</strong>`,
      "</div>"
    ].join("");
  }).join("");
}

function diagnosticsTable(account) {
  const rows = [
    ["Incomplete-window leads", account.diagnostics.incompleteWindowLeads],
    ["BOOKING leads", account.diagnostics.bookingLeads],
    ["Unsupported lead types", account.diagnostics.unsupportedLeadTypes],
    ["Old unanswered messages", account.counts.oldUnansweredMessages]
  ];
  return [
    '<div class="table-wrap"><table><thead><tr><th>Diagnostic</th><th>Count</th></tr></thead><tbody>',
    rows.map(([label, count]) =>
      `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(count)}</td></tr>`
    ).join(""),
    "</tbody></table></div>",
    '<p class="fine-print">Diagnostics are orthogonal dimensions and must not be summed as unique leads.</p>'
  ].join("");
}

function capabilityTable(account) {
  const availableFields = Object.entries(account.capability.requiredFields)
    .filter(([, available]) => available)
    .map(([field]) => field)
    .join(", ");
  const rows = [
    ["Response envelope", account.capability.envelope],
    ["Required structural fields", availableFields],
    ["Pagination declaration", account.capability.pagination],
    ["Completion evidence", account.completion.method],
    ["Validated pages", account.completion.pageCount]
  ];
  return [
    '<div class="table-wrap"><table><thead><tr><th>Capability check</th><th>Result</th></tr></thead><tbody>',
    rows.map(([label, value]) =>
      `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`
    ).join(""),
    "</tbody></table></div>"
  ].join("");
}

function unansweredTable(account, privacy) {
  if (account.recentUnanswered.length === 0) {
    return '<p class="empty-state">No recent unanswered messages.</p>';
  }
  const headings = ["Account", "First contact (epoch nanoseconds)"];
  if (privacy.includeLeadIds) headings.push("Lead ID");
  if (privacy.includeMessageText) headings.push("Message snippet");
  const rows = account.recentUnanswered.map((record) => {
    const cells = [account.name, record.firstContactEpochNanoseconds];
    if (privacy.includeLeadIds) cells.push(record.leadId);
    if (privacy.includeMessageText) cells.push(record.messageText ?? "");
    return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
  }).join("");
  return [
    '<div class="table-wrap"><table><thead><tr>',
    headings.map((heading) => `<th>${escapeHtml(heading)}</th>`).join(""),
    "</tr></thead><tbody>",
    rows,
    "</tbody></table></div>"
  ].join("");
}

function trendChart(account) {
  if (account.trend.length < 2) return "";
  const width = 560;
  const height = 160;
  const padding = 20;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const points = account.trend.map((point, index) => {
    const x = padding + (usableWidth * index) / (account.trend.length - 1);
    const y = padding + usableHeight * (1 - point.totalResponsiveness);
    return {
      ...point,
      x: x.toFixed(2),
      y: y.toFixed(2)
    };
  });
  return [
    '<figure class="trend">',
    '<svg data-responsiveness-trend viewBox="0 0 560 160" role="img" ',
    `aria-label="${escapeHtml(`${account.name} aggregate responsiveness trend`)}">`,
    '<line x1="20" y1="140" x2="540" y2="140" class="axis"></line>',
    '<line x1="20" y1="20" x2="20" y2="140" class="axis"></line>',
    `<polyline points="${escapeHtml(points.map((point) =>
      `${point.x},${point.y}`).join(" "))}" class="trend-line"></polyline>`,
    points.map((point) => [
      `<circle cx="${escapeHtml(point.x)}" cy="${escapeHtml(point.y)}" r="4">`,
      `<title>${escapeHtml(`${point.asOf}: ${rateText(point.totalResponsiveness)} (${point.totalResponded} responded / ${point.totalEligible} eligible)`)}</title>`,
      "</circle>"
    ].join("")).join(""),
    "</svg>",
    `<figcaption>${escapeHtml(account.trend.length)} aggregate history points; hover a point for exact counts.</figcaption>`,
    "</figure>"
  ].join("");
}

function accountSection(account, privacy) {
  const within24 = account.replySpeed.buckets.within5m +
    account.replySpeed.buckets.within1h +
    account.replySpeed.buckets.within24h;
  const noActivity = account.counts.totalEligible === 0
    ? '<p class="empty-state prominent">No eligible activity</p>'
    : "";
  const median = account.replySpeed.medianNanoseconds === null
    ? "No data"
    : `${account.replySpeed.medianNanoseconds} ns`;
  return [
    `<section class="account" aria-labelledby="account-${escapeHtml(account.key)}">`,
    `<div class="account-heading"><div><h2 id="account-${escapeHtml(account.key)}">${escapeHtml(account.name)}</h2>`,
    `<p>${escapeHtml(account.timeZone)} · ${escapeHtml(account.metricVersion)}</p></div></div>`,
    noActivity,
    '<div class="scorecards">',
    scorecard(
      "Total responsiveness",
      account.rates.totalResponsiveness,
      `${account.counts.totalResponded} responded / ${account.counts.totalEligible} eligible`
    ),
    scorecard(
      "Calls connected",
      account.rates.callsConnected,
      `${account.counts.connectedCalls} connected / ${account.counts.eligiblePhoneCalls} eligible calls`
    ),
    scorecard(
      "Messages replied",
      account.rates.messagesReplied,
      `${account.counts.repliedMessages} replied / ${account.counts.eligibleMessages} eligible messages`
    ),
    scorecard(
      "Replies within 24 hours",
      account.rates.repliedWithin24Hours,
      `${within24} within 24 hours / ${account.counts.eligibleMessages} eligible messages`
    ),
    '<article class="scorecard"><h3>Median reply time</h3>',
    `<p class="rate median">${escapeHtml(median)}</p>`,
    `<p class="exact-counts">${escapeHtml(account.counts.repliedMessages)} replied messages</p></article>`,
    "</div>",
    trendChart(account),
    '<div class="details-grid"><article><h3>Reply-speed distribution</h3>',
    bucketRows(account),
    "</article><article><h3>Diagnostics</h3>",
    diagnosticsTable(account),
    "</article></div>",
    '<article><h3>Recent unanswered messages</h3>',
    unansweredTable(account, privacy),
    "</article>",
    '<article><h3>Connector capability and completion</h3>',
    capabilityTable(account),
    "</article>",
    "</section>"
  ].join("");
}

export function renderHtml(model) {
  const report = assertReportModel(model);
  const modeBanner = report.mode === "synthetic"
    ? "Synthetic demonstration data"
    : "Private report";
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>LSA Responsiveness Tracker</title>',
    "<style>",
    ":root{color-scheme:light;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f8fb;color:#172033}",
    "*{box-sizing:border-box}body{margin:0;background:#f6f8fb;color:#172033}main,header,footer{max-width:1180px;margin:0 auto;padding:24px}",
    "header{padding-top:40px}.banner{display:inline-block;padding:8px 12px;border-radius:999px;background:#dbeafe;color:#1e3a8a;font-weight:700}.banner.synthetic{background:#fef3c7;color:#78350f}",
    "h1{font-size:clamp(2rem,5vw,3.5rem);line-height:1;margin:18px 0 12px}h2{margin:0;font-size:1.7rem}h3{margin:0 0 12px;font-size:1rem}p{line-height:1.5}",
    ".account{background:white;border:1px solid #dbe2ea;border-radius:18px;padding:24px;margin:0 0 24px;box-shadow:0 10px 30px rgba(30,41,59,.06)}.account-heading{display:flex;justify-content:space-between;gap:16px}.account-heading p{margin:6px 0 0;color:#5b6473}",
    ".scorecards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:22px 0}.scorecard{border:1px solid #dbe2ea;border-radius:14px;padding:18px;background:#fbfdff}.rate{font-size:2rem;font-weight:760;margin:8px 0;color:#0f4c81}.rate.median{font-size:1.2rem;overflow-wrap:anywhere}.exact-counts{font-size:.9rem;color:#5b6473;margin:0}",
    ".details-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:22px;margin:22px 0}.details-grid>article,section.account>article{border-top:1px solid #e4e8ee;padding-top:20px;margin-top:20px}",
    ".bucket-row{display:grid;grid-template-columns:minmax(150px,1fr) minmax(80px,2fr) 36px;gap:10px;align-items:center;margin:10px 0;font-size:.9rem}.bucket-track{height:10px;background:#e7edf4;border-radius:999px;overflow:hidden}.bucket-fill{display:block;height:100%;background:#2f80ed;border-radius:999px}",
    ".table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{text-align:left;padding:10px;border-bottom:1px solid #e4e8ee;vertical-align:top}th{color:#445064;background:#f8fafc}",
    ".empty-state{padding:14px;border-radius:10px;background:#f1f5f9;color:#475569}.empty-state.prominent{font-size:1.1rem;font-weight:700}.fine-print,figcaption,footer{font-size:.85rem;color:#5b6473}",
    ".trend{margin:18px 0}.trend svg{display:block;width:100%;height:auto;background:#f8fafc;border:1px solid #e4e8ee;border-radius:12px}.axis{stroke:#cbd5e1;stroke-width:1}.trend-line{fill:none;stroke:#2563eb;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.trend circle{fill:#1d4ed8}",
    ".methodology{background:#eef6ff;border-left:4px solid #2f80ed;padding:18px;border-radius:8px}.methodology p{margin:.45rem 0}",
    "@media(max-width:640px){main,header,footer{padding:16px}.account{padding:16px}.bucket-row{grid-template-columns:1fr 30px}.bucket-track{grid-column:1/-1;grid-row:2}}",
    "</style></head><body>",
    "<header>",
    `<span class="banner ${escapeHtml(report.mode === "synthetic" ? "synthetic" : "private")}">${escapeHtml(modeBanner)}</span>`,
    "<h1>LSA Responsiveness Tracker</h1>",
    `<p>As of ${escapeHtml(report.asOf)} · ${escapeHtml(report.windowDays)}-day window · generated ${escapeHtml(report.generatedAt)}</p>`,
    "</header><main>",
    report.accounts.map((account) => accountSection(account, report.privacy)).join(""),
    '<section class="methodology"><h2>Methodology and privacy</h2>',
    `<p>${escapeHtml(report.caveats.metric)}</p>`,
    `<p>${escapeHtml(report.caveats.phone)}</p>`,
    `<p>${escapeHtml(report.caveats.privacy)}</p>`,
    "</section></main>",
    "<footer>LSA Responsiveness Tracker · local, aggregate-first reporting</footer>",
    "</body></html>\n"
  ].join("");
}
