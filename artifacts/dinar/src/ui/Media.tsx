import { useEffect, useState } from "react";
import { ImageOff, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveAssetUrl } from "@/asset-url";
import { initials } from "@/lib/format";
import { DinarMark, DinarWordmark } from "@/ui/DinarMark";

/**
 * The single image strategy for offers: fixed-ratio box (set by the parent),
 * object-cover, lazy, skeleton while loading, branded fallback when missing or broken.
 */
export function SmartImage({
  src,
  alt,
  fallbackIcon: FallbackIcon = ImageOff,
  className,
  eager,
  testId,
}: {
  src?: string | null;
  alt: string;
  fallbackIcon?: LucideIcon;
  className?: string;
  eager?: boolean;
  testId?: string;
}) {
  const [state, setState] = useState<"loading" | "ok" | "error">(
    src ? "loading" : "error",
  );
  const url = src ? resolveAssetUrl(src) : "";
  useEffect(() => setState(src ? "loading" : "error"), [src]);
  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden bg-muted",
        className,
      )}
    >
      {state !== "error" && url && (
        <img
          src={url}
          alt={alt}
          data-testid={testId}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => setState("ok")}
          onError={() => setState("error")}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-300",
            state === "ok" ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {state === "loading" && (
        <div aria-hidden className="skeleton absolute inset-0" />
      )}
      {state === "error" && (
        <div
          role="img"
          aria-label={alt}
          className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_30%_20%,hsl(var(--primary-soft)),hsl(var(--muted))_70%)]"
        >
          <FallbackIcon
            size={36}
            strokeWidth={1.5}
            className="text-primary-soft-foreground/55"
            aria-hidden
          />
        </div>
      )}
    </div>
  );
}

export function Avatar({
  name,
  src,
  size = 40,
  className,
}: {
  name?: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [src]);
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border-0 bg-primary-soft font-bold text-primary-soft-foreground",
        className,
      )}
    >
      {src && !imageFailed ? (
        <img
          src={src}
          alt=""
          onError={() => setImageFailed(true)}
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/** Local ISO-code flag assets, with a textual country-code fallback. */
export function Flag({
  code,
  size = 20,
  className,
}: {
  code?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [code]);
  if (!code || failed)
    return <span aria-hidden className={className}>{code ?? "🌐"}</span>;
  return (
    <img
      aria-hidden
      alt=""
      width={size}
      height={Math.round(size * 0.75)}
      src={`${import.meta.env.BASE_URL}flags/${code.toLowerCase()}.svg`}
      onError={() => setFailed(true)}
      className={cn("shrink-0 rounded-sm object-cover", className)}
    />
  );
}

/** Canonical DINAR AI mark and wordmark. */
export function BrandMark({
  size = 36,
  wordmark = true,
  className,
}: {
  size?: number;
  wordmark?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <DinarMark size={size} alt={wordmark ? "" : "DINAR AI"} />
      {wordmark && (
        <DinarWordmark className="text-lg" />
      )}
    </span>
  );
}
