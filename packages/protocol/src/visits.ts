const visitPath = "/visits";

export const visitContract = {
  method: "POST",
  path: visitPath,
  url: `/api${visitPath}`,
  maxBodyBytes: 2048,
  maxPathLength: 1024,
  maxReferrerHostLength: 253,
  maxUtmLength: 256,
  meta: { name: "tetraboard-visit", content: "enabled" },
} as const;

export type VisitInput = {
  path: string;
  referrerHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
};
