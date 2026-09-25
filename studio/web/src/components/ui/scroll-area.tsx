import * as React from 'react';

import { cn } from '@/lib/utils';

// Not Radix's ScrollArea, deliberately: its Viewport renders an inline <style> element (to hide the native
// scrollbars it replaces), which the SPA CSP's style-src 'self' blocks. This is a plain scrolling box with the same
// name and role; the thin, themed scrollbar comes from the .scroll-area rule in styles.css. It forwards its ref and
// every div prop (onScroll included) to the element that actually scrolls.
function ScrollArea({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="scroll-area" className={cn('scroll-area relative overflow-auto', className)} {...props} />;
}

export { ScrollArea };
