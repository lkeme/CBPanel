import { useMemo } from "react";

import type { TranslationKey } from "../../i18n";
import type { GroupEntity, TagEntity } from "../../shared/entities";
import { CreatableCombobox, CreatableTagInput } from "../ui/CreatableCombobox";

export function GroupPicker({
  groups,
  onChange,
  t,
  value,
}: {
  groups: GroupEntity[];
  onChange: (value: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  value: string;
}) {
  const cleanValue = value.trim();
  const options = useMemo(() => {
    const names = new Map<string, string>();
    for (const group of groups.filter((group) => group.status !== "disabled")) names.set(group.name, group.name);
    if (cleanValue) names.set(cleanValue, cleanValue);
    return [...names.values()].sort((left, right) => left.localeCompare(right));
  }, [cleanValue, groups]);

  return (
    <CreatableCombobox
      value={cleanValue}
      options={options}
      placeholder={t("form.groupCustomPlaceholder")}
      createLabel={t("form.createGroup")}
      emptyLabel={t("form.noGroups")}
      onChange={onChange}
    />
  );
}

export function TagPicker({
  onChange,
  tags,
  t,
  value,
}: {
  onChange: (value: string[]) => void;
  tags: TagEntity[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  value: string[];
}) {
  const selected = useMemo(() => new Set(value.map((tag) => tag.trim()).filter(Boolean)), [value]);
  const options = useMemo(() => {
    const names = new Map<string, string>();
    for (const tag of tags.filter((tag) => tag.status !== "disabled")) names.set(tag.name, tag.name);
    for (const tag of value) {
      if (tag.trim()) names.set(tag.trim(), tag.trim());
    }
    return [...names.values()].sort((left, right) => left.localeCompare(right));
  }, [tags, value]);

  function setTag(tag: string, checked: boolean) {
    const cleanTag = tag.trim();
    if (!cleanTag) return;
    const next = new Set(selected);
    if (checked) next.add(cleanTag);
    else next.delete(cleanTag);
    onChange([...next]);
  }

  return (
    <CreatableTagInput
      value={value}
      options={options}
      placeholder={t("form.tagCustomPlaceholder")}
      createLabel={t("form.createTag")}
      emptyLabel={t("form.noTags")}
      onAdd={(tag) => setTag(tag, true)}
      onRemove={(tag) => setTag(tag, false)}
    />
  );
}
