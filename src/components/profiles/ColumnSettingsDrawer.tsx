import { useEffect, useRef, useState } from "react";
import { Check, GripVertical, RotateCcw } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { DEFAULT_PROFILE_COLUMNS, type AppSettings, type AppSettingsPatch, type ProfileColumnConfig } from "../../shared/settings";
import { Drawer } from "../ui/form-controls";
import { columnLabels, type ProfileColumnId } from "./columns";

export function ColumnSettingsDrawer({
  close,
  settings,
  saveSettings,
  t,
}: {
  close: () => void;
  settings: AppSettings;
  saveSettings: (patch: AppSettingsPatch) => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [dragState, setDragState] = useState<{ draggedId: string; overId: string } | null>(null);
  const dragStateRef = useRef<typeof dragState>(null);

  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  function setCurrentDragState(next: typeof dragState) {
    dragStateRef.current = next;
    setDragState(next);
  }

  function saveColumns(columns: ProfileColumnConfig[]) {
    void saveSettings({ table: { ...settings.table, columns } });
  }

  const visibleConfigColumns = settings.table.columns
    .filter((column) => column.id !== "select")
    .sort((left, right) => {
      if (left.id === "actions") return 1;
      if (right.id === "actions") return -1;
      return left.order - right.order;
    });

  function sortableColumns() {
    return settings.table.columns.filter((column) => column.id !== "select" && column.id !== "actions");
  }

  function applyColumnOrder(orderedIds: string[]) {
    const orderById = new Map<string, number>();
    orderById.set("select", 0);
    orderedIds.forEach((id, index) => orderById.set(id, (index + 1) * 10));
    orderById.set("actions", (orderedIds.length + 1) * 10);
    saveColumns(
      settings.table.columns
        .map((column) => ({ ...column, order: orderById.get(column.id) ?? column.order }))
        .sort((left, right) => left.order - right.order),
    );
  }

  function moveColumn(columnId: string, direction: -1 | 1) {
    const ids = sortableColumns().map((column) => column.id);
    const index = ids.indexOf(columnId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) return;
    const next = [...ids];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    applyColumnOrder(next);
  }

  function dragColumn(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const ids = sortableColumns().map((column) => column.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    applyColumnOrder(next);
  }

  function startDrag(columnId: string) {
    if (columnId === "actions") return;
    setCurrentDragState({ draggedId: columnId, overId: columnId });
  }

  function finishDrag() {
    const current = dragStateRef.current;
    if (current) {
      dragColumn(current.draggedId, current.overId);
    }
    setCurrentDragState(null);
  }

  useEffect(() => {
    if (!dragState) return undefined;
    document.body.classList.add("is-column-dragging");

    function handlePointerMove(event: PointerEvent) {
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".column-config-row[data-column-id]");
      const overId = row?.dataset.columnId;
      if (!overId || overId === "actions") return;
      setDragState((current) => {
        const next = current ? { ...current, overId } : current;
        dragStateRef.current = next;
        return next;
      });
    }

    function handlePointerUp() {
      finishDrag();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setCurrentDragState(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.classList.remove("is-column-dragging");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [dragState?.draggedId]);

  return (
    <Drawer title={t("table.columnSettings")} close={close} t={t}>
      <div className="settings-stack">
        <section className="settings-section">
          <div className="settings-section-head">
            <h2>{t("table.columnVisibilityWidth")}</h2>
            <button
              className="command subtle"
              onClick={() => saveColumns(DEFAULT_PROFILE_COLUMNS)}
              type="button"
            >
              <RotateCcw size={16} aria-hidden="true" />
              {t("table.resetColumns")}
            </button>
          </div>
          <div className="column-config-list">
            {visibleConfigColumns
              .map((column) => {
                const fixed = column.id === "actions";
                const sortable = !fixed;
                const label = t(columnLabels[column.id as ProfileColumnId]);
                const dragging = dragState?.draggedId === column.id;
                const dragOver = Boolean(sortable && dragState && dragState.overId === column.id && dragState.draggedId !== column.id);
                return (
                  <div
                    className={`column-config-row ${fixed ? "fixed" : ""} ${dragging ? "dragging" : ""} ${dragOver ? "drag-over" : ""}`}
                    data-column-id={column.id}
                    key={column.id}
                  >
                    <span
                      aria-disabled={!sortable}
                      aria-label={sortable ? t("table.dragColumn") : t("table.requiredColumn")}
                      className={`column-drag-handle ${sortable ? "" : "is-disabled"}`}
                      onKeyDown={(event) => {
                        if (!sortable) return;
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          moveColumn(column.id, -1);
                        }
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          moveColumn(column.id, 1);
                        }
                      }}
                      onPointerDown={(event) => {
                        if (!sortable || event.button !== 0) return;
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        startDrag(column.id);
                      }}
                      role="button"
                      tabIndex={sortable ? 0 : -1}
                      title={sortable ? t("table.dragColumn") : t("table.requiredColumn")}
                    >
                      <GripVertical size={16} aria-hidden="true" />
                    </span>
                    <div className="column-config-main">
                      <button
                        className="column-toggle"
                        disabled={fixed}
                        onClick={() =>
                          saveColumns(
                            settings.table.columns.map((item) =>
                              item.id === column.id ? { ...item, visible: !item.visible } : item,
                            ),
                          )
                        }
                        type="button"
                      >
                        <span className={`checkmark ${column.visible ? "checked" : ""}`}>
                          {column.visible && <Check size={14} aria-hidden="true" />}
                        </span>
                        <span>
                          <strong>{label}</strong>
                          <small>{fixed ? t("table.requiredColumn") : t(column.visible ? "table.visible" : "table.hidden")}</small>
                        </span>
                      </button>
                    </div>
                    <label className="column-width-field">
                      <span>
                        {t("table.columnWidth", { column: label })}
                      </span>
                      <input
                        aria-label={t("table.columnWidth", { column: label })}
                        min={64}
                        max={360}
                        type="number"
                        value={column.width ?? 120}
                        onChange={(event) =>
                          saveColumns(
                            settings.table.columns.map((item) =>
                              item.id === column.id ? { ...item, width: Number(event.target.value) } : item,
                            ),
                          )
                        }
                      />
                    </label>
                  </div>
                );
              })}
          </div>
        </section>
      </div>
    </Drawer>
  );
}
