"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

interface CopyButtonProperties {
  readonly text: string;
}

export const CopyButton = ({ text }: CopyButtonProperties) => {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard access can be denied; the command stays selectable.
      });
  };

  return (
    <button
      aria-label={`Copy ${text}`}
      className="text-muted-foreground transition-colors hover:text-foreground"
      onClick={copy}
      type="button"
    >
      {copied ? (
        <Check aria-hidden="true" className="size-4" />
      ) : (
        <Copy aria-hidden="true" className="size-4" />
      )}
    </button>
  );
};
