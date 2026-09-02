import { assertReportModel } from "./report-model.js";

export function renderJson(model) {
  const report = assertReportModel(model);
  return `${JSON.stringify(report, null, 2)}\n`;
}
