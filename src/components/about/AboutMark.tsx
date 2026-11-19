import { AppMark } from "../app/AppMark";

/**
 * The About page's brand mark, in its own module so the page itself stays free of bundler-only
 * `.svg` imports and can be rendered by plain Node tests.
 */
export function AboutMark({ className }: { className: string }) {
  return <AppMark className={className} />;
}
