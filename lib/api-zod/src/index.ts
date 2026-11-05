export * from "./generated/api";
export * from "./generated/types";
// Orval names both the path validator and the query DTO `...Params` when an
// operation has path and query parameters. Keep the validator's public name and
// expose the query types explicitly; generated files remain reproducible.
export {
  RemoveConnectReadOnlyTeamBody,
  GetConnectPartnerReportParams,
  GetAdminConnectPartnerReportParams,
  GetConnectDiagnosticsParams,
  GetAdminConnectDiagnosticsParams,
} from "./generated/api";
export type {
  RemoveConnectReadOnlyTeamBody as RemoveConnectReadOnlyTeamRequest,
  GetConnectPartnerReportParams as GetConnectPartnerReportQuery,
  GetAdminConnectPartnerReportParams as GetAdminConnectPartnerReportQuery,
  GetConnectDiagnosticsParams as GetConnectDiagnosticsQuery,
  GetAdminConnectDiagnosticsParams as GetAdminConnectDiagnosticsQuery,
} from "./generated/types";
