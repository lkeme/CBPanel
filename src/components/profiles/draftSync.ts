import type { BrowserProfile } from "../../shared/profile";

/**
 * What the editor should do with its draft once the selection or the stored records change.
 *
 * - `skip`: leave draft, selection and preflight untouched.
 * - `clear`: nothing is stored, so there is nothing to edit.
 * - `keep`: settle the selection on `selectedId` but leave the draft alone — it holds unsaved edits.
 * - `adopt`: rebuild the draft from `profile`.
 */
export type DraftSyncPlan =
  | { action: "skip" }
  | { action: "clear" }
  | { action: "keep"; selectedId: string }
  | { action: "adopt"; selectedId: string; profile: BrowserProfile };

/** A profile field the user can type into: everything the editor form owns. */
export type EditableProfile = Omit<BrowserProfile, "createdAt" | "id" | "updatedAt">;

/**
 * Decides whether a stored record may overwrite the draft in the editor.
 *
 * The panel re-reads the whole state every 1.8s while a session runs, so "the store changed" is no
 * signal that the user wants their form reset — usually it only means a session status moved. The draft
 * is therefore rebuilt only when it does not belong to the selected record, or when it still matches
 * that record field for field, in which case the rebuild cannot be noticed.
 *
 * Detecting a selection change needs no previous-selection bookkeeping: picking another row leaves the
 * draft carrying the previously selected id, which is exactly the mismatch that triggers a rebuild.
 */
export function planDraftSync({
  draft,
  draftIsNew,
  profiles,
  selectedId,
}: {
  draft: BrowserProfile | null;
  draftIsNew: boolean;
  profiles: BrowserProfile[] | undefined;
  selectedId: string;
}): DraftSyncPlan {
  // An unsaved new profile has no stored counterpart at all, so nothing here applies to it.
  if (draftIsNew) return { action: "skip" };
  if (!profiles?.length) return { action: "clear" };
  // A selection pointing at a record that is gone (deleted environment) falls back to the first one,
  // which is what the table shows in that situation.
  const selected = profiles.find((profile) => profile.id === selectedId) ?? profiles[0];
  if (!selected) return { action: "skip" };
  if (draft && draft.id === selected.id && hasUnsavedEdits(draft, selected)) {
    return { action: "keep", selectedId: selected.id };
  }
  return { action: "adopt", selectedId: selected.id, profile: selected };
}

/**
 * True when the draft holds a value the stored record does not.
 *
 * `updatedAt` is left out of the comparison: the save path stamps it and the server rewrites it, so a
 * refreshed record can carry a newer timestamp for a change the user never typed. Treating that as an
 * edit would mark the draft dirty forever and permanently cut the editor off from remote data. `id` and
 * `createdAt` never change for a record. What remains is exactly the fields the form writes.
 */
export function hasUnsavedEdits(draft: BrowserProfile, stored: BrowserProfile): boolean {
  return !deepEqual(editableSnapshot(draft), editableSnapshot(stored));
}

/**
 * Returning `EditableProfile` is the point: a field added to `BrowserProfile` later fails to compile
 * here until it is either compared or deliberately excluded.
 */
function editableSnapshot({
  createdAt: _createdAt,
  id: _id,
  updatedAt: _updatedAt,
  ...editable
}: BrowserProfile): EditableProfile {
  return editable;
}

/**
 * A missing key and an explicit `undefined` count as equal, because a record that travelled through the
 * API lost its `undefined` fields (`detectionChecks[].checkedAt`) while a locally built draft still has
 * them, and that difference is not an edit.
 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
