import type { TranslationKey } from "../../i18n";

export type ProfileColumnId =
  | "select"
  | "name"
  | "status"
  | "group"
  | "tags"
  | "proxy"
  | "ip"
  | "mode"
  | "startUrl"
  | "updatedAt"
  | "actions";

export const columnLabels: Record<ProfileColumnId, TranslationKey> = {
  select: "table.columns",
  name: "table.name",
  status: "table.status",
  group: "table.group",
  tags: "table.tags",
  proxy: "table.proxy",
  ip: "table.ip",
  mode: "table.mode",
  startUrl: "table.startUrl",
  updatedAt: "table.updatedAt",
  actions: "table.actions",
};
