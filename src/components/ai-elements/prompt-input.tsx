"use client";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ChatStatus } from "ai";
import { CornerDownLeftIcon, SquareIcon, XIcon } from "lucide-react";
import type {
  ComponentProps,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
  ReactNode,
} from "react";
import { useCallback, useRef } from "react";

// ============================================================================
// QueryVault Lean Prompt Input
// ============================================================================

export interface PromptInputMessage {
  text: string;
  files?: unknown[];
}

export interface PromptInputProps extends Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> {
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}

export const PromptInput = ({ onSubmit, children, className, ...props }: PromptInputProps) => {
  const formRef = useRef<HTMLFormElement>(null);

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      const text = (formData.get("message") as string) || "";
      onSubmit({ text }, event);
    },
    [onSubmit],
  );

  return (
    <form ref={formRef} onSubmit={handleSubmit} className={cn("w-full", className)} {...props}>
      <InputGroup className="overflow-hidden">{children}</InputGroup>
    </form>
  );
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;
export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
);

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>;

export const PromptInputTextarea = ({
  onChange,
  onKeyDown,
  className,
  placeholder = "Ask anything about your documents…",
  ...props
}: PromptInputTextareaProps) => {
  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const form = event.currentTarget.form;
        if (form) {
          form.requestSubmit();
        }
      }
    },
    [onKeyDown],
  );

  return (
    <InputGroupTextarea
      name="message"
      onKeyDown={handleKeyDown}
      onChange={onChange}
      placeholder={placeholder}
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      {...props}
    />
  );
};

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("justify-between gap-1", className)}
    {...props}
  />
);

export type PromptInputHeaderProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputHeader = ({ className, ...props }: PromptInputHeaderProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("order-first flex-wrap gap-1", className)}
    {...props}
  />
);

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  status,
  onStop,
  onClick,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const isGenerating = status === "submitted" || status === "streaming";

  let Icon = <CornerDownLeftIcon className="size-4" />;

  if (status === "submitted") {
    Icon = <Spinner />;
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-4" />;
  } else if (status === "error") {
    Icon = <XIcon className="size-4" />;
  }

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (isGenerating && onStop) {
        e.preventDefault();
        onStop();
        return;
      }
      onClick?.(e);
    },
    [isGenerating, onStop, onClick],
  );

  return (
    <InputGroupButton
      aria-label={isGenerating ? "Stop" : "Submit"}
      className={cn(className)}
      onClick={handleClick}
      size={size}
      type={isGenerating && onStop ? "button" : "submit"}
      variant={variant}
      {...props}
    >
      {children ?? Icon}
    </InputGroupButton>
  );
};
