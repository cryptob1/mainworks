/**
 * Supported report formats. A format is pinned in the operator-approved bundle definition
 * beside the runner image digest, travels to the runner and the collector through the
 * dispatch grant, and is therefore covered by the signed attestation's grant digest. It is
 * never chosen by a runner input file or inferred from whatever bytes the boundary holds:
 * a report in a format the approval did not name is refused, not sniffed.
 */
export const reportFormats = ['graphyard-playwright-v1', 'junit-xml-v1'] as const;
export type ReportFormat = (typeof reportFormats)[number];
