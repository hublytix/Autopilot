'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';

// One "Copy" button for one part of the reply. Uses the async Clipboard API, falling back to a
// temporary selection for browsers without it; the result is announced politely. The visible label
// stays "Copy" so the accessible name ("Copy subject") contains it.

export interface CopyButtonProps {
  /** The exact text to copy. */
  text: string;
  /** What is copied, in lower case ("subject"), for the accessible name and the announcement. */
  label: string;
}

type Status = 'idle' | 'copied' | 'failed';

function copyBySelection(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(area);
  return copied;
}

export function CopyButton({ text, label }: CopyButtonProps) {
  const [status, setStatus] = useState<Status>('idle');

  useEffect(() => {
    if (status !== 'copied') return undefined;
    const handle = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(handle);
  }, [status]);

  async function copy(): Promise<void> {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text);
        setStatus('copied');
        return;
      }
    } catch {
      // Permission denied or an insecure context: try the selection fallback.
    }
    setStatus(copyBySelection(text) ? 'copied' : 'failed');
  }

  return (
    <div className="flex flex-col gap-1">
      <Button variant="secondary" onClick={() => void copy()} aria-label={`Copy ${label}`}>
        {status === 'copied' ? 'Copied' : 'Copy'}
      </Button>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-neutral-700 dark:text-neutral-300">
        {status === 'copied' ? `The ${label} is copied.` : status === 'failed' ? `Couldn't copy the ${label}: select it and copy it by hand.` : ''}
      </p>
    </div>
  );
}
