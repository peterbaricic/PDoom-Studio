// JobsIndicator.tsx: "Jobs: N running · M queued" across every version, in the header; opens the jobs drawer.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { JobsDrawer, jobsQuery } from './JobsDrawer';

export function JobsIndicator() {
  const [open, setOpen] = useState(false);
  const { data: jobs = [] } = useQuery(jobsQuery());
  const running = jobs.filter(j => j.status === 'running').length;
  const queued = jobs.filter(j => j.status === 'queued').length;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {running > 0 && <LoaderCircleIcon aria-hidden className="animate-spin" />}
        {`Jobs: ${running} running · ${queued} queued`}
      </Button>
      <JobsDrawer open={open} onOpenChange={setOpen} />
    </>
  );
}
