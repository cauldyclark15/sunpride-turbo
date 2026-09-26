"use client";

import { Eye, EyeSlash } from "@gravity-ui/icons";
import { Button } from "@heroui/react/button";
import { InputGroup } from "@heroui/react/input-group";
import { useState, type ComponentProps } from "react";

type PasswordInputProps = Omit<ComponentProps<typeof InputGroup.Input>, "type">;

/**
 * Password field with a show/hide toggle. The calm-workspace field outline
 * (PATTERNS.md) lives on the group so the input and the eye button read as a
 * single 40px control; `className` is applied to the group.
 */
export function PasswordInput({ className = "", ...props }: PasswordInputProps) {
  const [isVisible, setIsVisible] = useState(false);
  const actionLabel = isVisible ? "Hide password" : "Show password";

  return (
    <InputGroup
      fullWidth
      className={`h-10 min-h-10 rounded-[10px] !border !border-border bg-surface shadow-none ${className}`}
    >
      <InputGroup.Input
        {...props}
        type={isVisible ? "text" : "password"}
        className="h-full"
      />
      <InputGroup.Suffix className="pe-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label={actionLabel}
          aria-pressed={isVisible}
          onPress={() => setIsVisible((visible) => !visible)}
          className="text-muted hover:text-foreground"
        >
          {isVisible ? (
            <EyeSlash aria-hidden="true" className="size-4" />
          ) : (
            <Eye aria-hidden="true" className="size-4" />
          )}
        </Button>
      </InputGroup.Suffix>
    </InputGroup>
  );
}
