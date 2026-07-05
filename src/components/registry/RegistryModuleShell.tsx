import type { ReactNode } from "react";

import { ModuleHeader } from "../runtime/ModuleHeader";

export function RegistryModuleShell({
  body,
  children,
  icon,
  title,
  toolbar,
}: {
  body: string;
  children: ReactNode;
  icon: ReactNode;
  title: string;
  toolbar?: ReactNode;
}) {
  return (
    <section className="module-surface">
      <ModuleHeader icon={icon} title={title} body={body} />
      {toolbar && <div className="module-toolbar">{toolbar}</div>}
      {children}
    </section>
  );
}

export function RegistryModuleEmpty({
  body,
  className = "",
  title,
}: {
  body: string;
  className?: string;
  title: string;
}) {
  return (
    <div className={`module-empty ${className}`.trim()}>
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}
