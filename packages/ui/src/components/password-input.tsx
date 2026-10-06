"use client";

import { Eye, EyeSlash } from "@gravity-ui/icons";
import { Button } from "@heroui/react/button";
import { InputGroup } from "@heroui/react/input-group";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type Ref,
} from "react";
import {
  INITIAL_PASSWORD_VISIBILITY,
  passwordInputType,
  passwordToggleLabel,
  shouldRehidePassword,
  togglePasswordVisibility,
} from "./password-visibility";

type PasswordInputProps = Omit<ComponentProps<typeof InputGroup.Input>, "type">;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/**
 * Password field with a show/hide (eye) toggle. Hidden by default; the eye
 * button's accessible name is "Show password" / "Hide password". The text is
 * hidden again when the person leaves the screen (tab hidden, page left or
 * restored from history), when the form is sent, and on unmount. The value is
 * never read, logged or stored by this component; spell check and
 * autocorrect stay off so a visible password is not sent to a spelling
 * service.
 *
 * The calm-workspace field outline (PATTERNS.md) lives on the group so the
 * input and the eye button read as a single 40px control; `className` is
 * applied to the group.
 */
export function PasswordInput({
  className = "",
  ref,
  ...props
}: PasswordInputProps) {
  const [isVisible, setIsVisible] = useState(INITIAL_PASSWORD_VISIBILITY);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const actionLabel = passwordToggleLabel(isVisible);

  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  useEffect(() => {
    const hide = () => {
      // Switch the DOM type synchronously too, so the browser never handles a
      // submitted or cached page with the password showing as plain text.
      if (inputRef.current) inputRef.current.type = "password";
      setIsVisible(false);
    };
    const onVisibility = () => {
      if (
        shouldRehidePassword({
          kind: "visibilitychange",
          hidden: document.visibilityState === "hidden",
        })
      ) {
        hide();
      }
    };
    const onPageHide = () => {
      if (shouldRehidePassword({ kind: "pagehide" })) hide();
    };
    const onPageShow = () => {
      if (shouldRehidePassword({ kind: "pageshow" })) hide();
    };
    const form = inputRef.current?.form ?? null;
    const onSubmit = () => {
      if (shouldRehidePassword({ kind: "submit" })) hide();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    form?.addEventListener("submit", onSubmit, { capture: true });
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      form?.removeEventListener("submit", onSubmit, { capture: true });
    };
  }, []);

  return (
    <InputGroup
      fullWidth
      className={`h-10 min-h-10 rounded-[10px] !border !border-border bg-surface shadow-none ${className}`}
    >
      <InputGroup.Input
        {...props}
        ref={setInputRef}
        type={passwordInputType(isVisible)}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="none"
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
          onPress={() => setIsVisible(togglePasswordVisibility)}
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
