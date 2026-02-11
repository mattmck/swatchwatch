"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

const BASE_CLASSNAMES: NonNullable<ToasterProps["toastOptions"]>["classNames"] = {
  toast:
    "group toast group-[.toaster]:rounded-xl group-[.toaster]:border group-[.toaster]:border-border/70 group-[.toaster]:bg-card group-[.toaster]:text-card-foreground group-[.toaster]:shadow-[0_18px_44px_rgba(66,16,126,0.16)]",
  title: "group-[.toast]:font-semibold",
  description: "group-[.toast]:text-muted-foreground",
  actionButton:
    "group-[.toast]:bg-gradient-brand group-[.toast]:text-white group-[.toast]:border-0",
  cancelButton:
    "group-[.toast]:border group-[.toast]:border-border/70 group-[.toast]:bg-background group-[.toast]:text-foreground",
  closeButton:
    "group-[.toast]:border-border/70 group-[.toast]:bg-background/90 group-[.toast]:text-muted-foreground",
  success:
    "group-[.toast]:border-emerald-500/35 group-[.toast]:bg-emerald-500/10 group-[.toast]:text-emerald-900 dark:group-[.toast]:text-emerald-300",
  info:
    "group-[.toast]:border-brand-purple/35 group-[.toast]:bg-brand-pink-light/45 group-[.toast]:text-brand-purple-deep dark:group-[.toast]:bg-brand-purple/25 dark:group-[.toast]:text-brand-lilac",
  error:
    "group-[.toast]:border-destructive/45 group-[.toast]:bg-destructive/10 group-[.toast]:text-destructive dark:group-[.toast]:text-red-300",
};

export function Toaster(props: ToasterProps) {
  const { toastOptions, ...rest } = props;
  return (
    <Sonner
      className="toaster group"
      position="top-right"
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...BASE_CLASSNAMES,
          ...(toastOptions?.classNames ?? {}),
        },
      }}
      {...rest}
    />
  );
}
