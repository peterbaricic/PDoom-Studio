import { Toaster as Sonner, type ToasterProps } from 'sonner';
// sonner's own stylesheet, bundled as a real CSS asset. sonner would otherwise inject this same CSS at runtime through
// a <style> tag, which the SPA CSP's style-src 'self' blocks; vite.config.ts turns that injection off in the build.
import 'sonner/dist/styles.css';

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
