import appIconLightUrl from "../../assets/app-icon-light.svg";
import appIconUrl from "../../assets/app-icon.svg";

export function AppMark({
  className,
  dragRegion = false,
}: {
  className: string;
  dragRegion?: boolean;
}) {
  const dragProps = dragRegion ? { "data-tauri-drag-region": "" } : {};
  return (
    <span className={className} aria-hidden="true" {...dragProps}>
      <img alt="" className="app-icon-light" draggable={false} src={appIconLightUrl} />
      <img alt="" className="app-icon-dark" draggable={false} src={appIconUrl} />
    </span>
  );
}
