import type { WorkbenchView } from "../components/registry/registryStats";

export const DEFAULT_WORKBENCH_VIEW: WorkbenchView = "profiles";

const WORKBENCH_VIEWS: readonly WorkbenchView[] = [
  "runtimeCheck",
  "profiles",
  "groups",
  "tags",
  "proxies",
  "extensions",
  "trash",
  "system",
];

export function workbenchViewFromHash(hash: string): WorkbenchView {
  const candidate = hash.startsWith("#") ? hash.slice(1) : hash;
  return isWorkbenchView(candidate) ? candidate : DEFAULT_WORKBENCH_VIEW;
}

export function workbenchViewHash(view: WorkbenchView): string {
  return `#${view}`;
}

function isWorkbenchView(value: string): value is WorkbenchView {
  return WORKBENCH_VIEWS.includes(value as WorkbenchView);
}
