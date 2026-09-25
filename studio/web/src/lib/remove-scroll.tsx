// remove-scroll.tsx: a CSP-safe stand-in for react-remove-scroll, which vite.config.ts aliases that package to in the
// build. Radix wraps every modal layer in its RemoveScroll (Dialog and so Sheet, and modal Popover, Menu and Select)
// to lock page scroll while the layer is open, and the real one does that by injecting a <style> tag
// (react-style-singleton) — which the SPA CSP's style-src 'self' blocks. This locks scroll through the CSSOM
// instead, which CSP allows, and renders its child unchanged. Radix always passes it `as={Slot}` (or uses it as a
// plain wrapper) with the ref on the child itself, so rendering the child as is keeps every ref and prop intact.
//
// What it leaves out: the real one also stops wheel and touch scrolling outside the layer and pads for the vanished
// scrollbar. The studio's layout never scrolls the page itself (AppShell is a full-height frame whose panes scroll on
// their own), so locking the root element's overflow is all there is to lock.
import { useEffect, type ReactNode } from 'react';

let locks = 0;
function lockPageScroll(): () => void {
  const root = document.documentElement;
  if (locks++ === 0) root.style.overflow = 'hidden';
  return () => {
    if (--locks === 0) root.style.overflow = '';
  };
}

export function RemoveScroll({ children, enabled = true }: { children?: ReactNode; enabled?: boolean; [prop: string]: unknown }) {
  useEffect(() => (enabled ? lockPageScroll() : undefined), [enabled]);
  return <>{children}</>;
}
