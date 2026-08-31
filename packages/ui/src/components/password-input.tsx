"use client";

import { Eye, EyeSlash } from "@gravity-ui/icons";
import { Button } from "@heroui/react/button";
import { InputGroup } from "@heroui/react/input-group";
import { useState, type ComponentProps } from "react";

type PasswordInputProps = Omit<ComponentProps<typeof InputGroup.Input>, "type">;

export function PasswordInput({ className, ...props }: PasswordInputProps) {
  const [isVisible, setIsVisible] = useState(false);
  const actionLabel = isVisible ? "Hide password" : "Show password";

  return (
    <InputGroup fullWidth>
      <InputGroup.Input
        {...props}
        type={isVisible ? "text" : "password"}
        className={className}
      />
      <InputGroup.Suffix className="pe-0">
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
