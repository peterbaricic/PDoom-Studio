// ClaudeControls.tsx: the controls of an action that runs Claude, shared by the inspector panels and the new-version
// dialog: the model picker, and a button that's off (with the reason as its tooltip) while the Claude CLI is missing
// or signed out.
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { claudeUnavailable, useHealth } from '@/shell/HealthBanner';

// '' is the CLI's own default model; the jobs API takes `model: null` for it.
const MODELS: Array<[string, string]> = [
  ['', 'CLI default'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];

// A native <select>, not Radix's: Radix Select injects a runtime <style> tag, which the SPA CSP blocks.
export function ModelSelect({ value, onChange, disabled }: { value: string; onChange: (model: string) => void; disabled?: boolean }) {
  return (
    <label className="text-muted-foreground flex items-center gap-2 text-xs">
      Claude model
      <select
        aria-label="Claude model"
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-[3px] disabled:opacity-50"
      >
        {MODELS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

// Why actions that run Claude can't right now (the CLI missing or signed out), or null when they can.
export function useClaudeUnavailable(): string | null {
  return claudeUnavailable(useHealth().data);
}

// A button that's off for a reason while `unavailable` is set: hovering or focusing it says why. (A disabled button
// gets no pointer events, so the tooltip hangs on a focusable wrapper instead.) ClaudeButton, for a button that starts
// Claude, with the reason Claude can't run.
export function ReasonButton({ unavailable, disabled, ...props }: ComponentProps<typeof Button> & { unavailable: string | null }) {
  if (!unavailable) return <Button disabled={disabled} {...props} />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex w-fit">
          <Button disabled {...props} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{unavailable}</TooltipContent>
    </Tooltip>
  );
}

export const ClaudeButton = ReasonButton;
