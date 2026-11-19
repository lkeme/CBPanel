import {
  Archive,
  FolderKanban,
  Layers3,
  ListChecks,
  Network,
  Plug,
  Tags,
  type LucideIcon,
} from "lucide-react";

import type { WorkbenchView } from "../registry/registryStats";

const WORKBENCH_VIEW_ICONS: Record<WorkbenchView, LucideIcon> = {
  runtimeCheck: ListChecks,
  profiles: Layers3,
  groups: FolderKanban,
  tags: Tags,
  proxies: Network,
  extensions: Plug,
  trash: Archive,
};

/** One icon per workbench view, shared by the sidebar entry and the page title. */
export function WorkbenchViewIcon({ view, size }: { view: WorkbenchView; size: number }) {
  const Icon = WORKBENCH_VIEW_ICONS[view];
  return <Icon aria-hidden="true" size={size} />;
}
