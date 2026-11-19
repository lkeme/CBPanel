import { AboutMark } from "./AboutMark";
import { AboutContent, type AboutContentProps } from "./AboutContent";

/**
 * The About tab as the app mounts it: the page plus the real brand mark. Kept as a thin wrapper so
 * the page module itself has no bundler-only asset import and stays renderable in plain Node tests.
 */
export function AboutTab(props: Omit<AboutContentProps, "renderMark">) {
  return <AboutContent {...props} renderMark={(className) => <AboutMark className={className} />} />;
}
