import { assertReportModel } from "./report-model.js";

function formulaSafe(value) {
  const text = String(value);
  return /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  return `"${formulaSafe(value).replaceAll('"', '""')}"`;
}

export function renderCsv(model) {
  const report = assertReportModel(model);
  if (!report.privacy.writeActionCsv) return null;

  const headers = ["account", "first_contact_epoch_nanoseconds"];
  if (report.privacy.includeLeadIds) headers.push("lead_id");
  if (report.privacy.includeMessageText) headers.push("message_text");

  const rows = [headers];
  for (const account of report.accounts) {
    for (const record of account.recentUnanswered) {
      const row = [account.name, record.firstContactEpochNanoseconds];
      if (report.privacy.includeLeadIds) row.push(record.leadId);
      if (report.privacy.includeMessageText) row.push(record.messageText ?? "");
      rows.push(row);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
