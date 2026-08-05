import type { ReactNode } from "react";

export function ModuleHeader({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <header className="module-header">
      <span>{icon}</span>
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
    </header>
  );
}
