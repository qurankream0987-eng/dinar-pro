import { resolveAssetUrl } from "@/asset-url";
import { cn } from "@/lib/utils";

type DinarMarkProps = {
  size?: number;
  alt?: string;
  className?: string;
};

/** The single UI entry point for the DINAR vector mark. */
export function DinarMark({
  size = 38,
  alt = "",
  className,
}: DinarMarkProps) {
  return (
    <img
      src={resolveAssetUrl("/brand/dinar-mark.svg")}
      width={size}
      height={size}
      alt={alt}
      draggable={false}
      className={cn("shrink-0 object-contain", className)}
    />
  );
}