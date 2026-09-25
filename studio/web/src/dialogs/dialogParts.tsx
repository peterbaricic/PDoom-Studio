// dialogParts.tsx: what the version dialogs share: the version being acted on (from the versions list), and the
// title and id fields of a new version (New version, Remix), where the id follows the title as a slug until it's
// edited by hand.
import { useId, useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { Job, Version } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isValidVersionId, slug } from './slug';

// The version as the sidebar lists it, or undefined while the list loads (or when there's no such version).
export function useVersion(versionId: string | undefined) {
  const versions = useQuery({ queryKey: ['versions'], queryFn: () => api.get<Version[]>('/api/versions') });
  return { version: versions.data?.find(v => v.id === versionId), loaded: !!versions.data };
}

export const versionName = (v: Version) => v.title || v.id;

// Promote and Delete wait for the version's jobs (they're refused while one is queued or running): when those can't
// be read, the dialog's button stays off, and this says why, with Retry.
export function JobsError({ jobs }: { jobs: UseQueryResult<Job[]> }) {
  if (!jobs.error || jobs.data) return null;
  return (
    <div role="alert" className="text-destructive flex items-center gap-2 text-sm">
      <span className="flex-1">{`Couldn't check this version's jobs: ${jobs.error.message}`}</span>
      <Button type="button" size="sm" variant="outline" disabled={jobs.isFetching} onClick={() => void jobs.refetch()}>
        Retry
      </Button>
    </div>
  );
}

export function useTitleAndId(initialTitle = '') {
  const [title, setTitleValue] = useState(initialTitle);
  const [id, setIdValue] = useState(() => slug(initialTitle));
  const [idEdited, setIdEdited] = useState(false);
  return {
    title,
    id,
    idValid: isValidVersionId(id),
    setTitle(t: string) {
      setTitleValue(t);
      if (!idEdited) setIdValue(slug(t));
    },
    setId(v: string) {
      setIdEdited(true);
      setIdValue(v);
    },
  };
}

export type TitleAndId = ReturnType<typeof useTitleAndId>;

// A labelled field: the label names the control for screen readers (and tests), the note sits under it.
export function Field({ label, note, children }: { label: string; note?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children(id)}
      {note && <div className="text-muted-foreground text-xs">{note}</div>}
    </div>
  );
}

// `taken`: the server said this id is in use (shown on the id field until it's edited).
export function TitleAndIdFields({ fields, taken, disabled }: { fields: TitleAndId; taken?: boolean; disabled?: boolean }) {
  const { title, id, idValid } = fields;
  const idNote = !id
    ? title
      ? 'The id comes from the title: give it one with some letters or digits in it.'
      : 'Made from the title; you can change it.'
    : !idValid
      ? 'An id is lowercase letters, digits and hyphens (at most 41), starting with a letter or digit.'
      : `The version's address: /versions/${id}`;
  return (
    <>
      <Field label="Title">
        {htmlId => <Input id={htmlId} value={title} disabled={disabled} autoFocus onChange={e => fields.setTitle(e.target.value)} />}
      </Field>
      <Field label="Id" note={idNote}>
        {htmlId => (
          <Input
            id={htmlId}
            value={id}
            disabled={disabled}
            aria-invalid={!!id && (!idValid || taken) ? true : undefined}
            spellCheck={false}
            className="font-mono"
            onChange={e => fields.setId(e.target.value)}
          />
        )}
      </Field>
    </>
  );
}
