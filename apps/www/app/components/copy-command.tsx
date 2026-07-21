"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

interface CopyCommandProperties {
  readonly command: string;
}

export const CopyCommand = ({ command }: CopyCommandProperties) => {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        //
      });
  };

  return (
    <button
      aria-label={`Copy ${command}`}
      className="group flex h-10 items-center gap-3 rounded-lg border bg-card px-4 font-mono text-sm transition-colors hover:bg-accent"
      onClick={copy}
      type="button"
    >
      <span aria-hidden="true" className="select-none text-muted-foreground">
        $
      </span>
      <code className="select-all">{command}</code>
      {copied ? (
        <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
      ) : (
        <Copy
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
    </button>
  );
};
