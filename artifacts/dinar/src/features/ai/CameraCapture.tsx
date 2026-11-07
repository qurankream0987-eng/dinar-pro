import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, RotateCcw, X, Check } from "lucide-react";
import { buttonClass, iconButtonClass } from "@/ui/Button";

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * Photo search capture: live camera (after the browser's permission), preview, retake, cancel,
 * or a photo from the device. Every exit stops the camera tracks; nothing is uploaded here.
 */
export function CameraCapture({ onConfirm, onClose }: { onConfirm: (file: File) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"starting" | "live" | "preview" | "unavailable">("starting");
  const [message, setMessage] = useState("");
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null);

  // Each start/stop is a new session: a camera that finishes opening after the buyer already
  // chose a photo, captured, or closed the dialog is stopped at once and never shown.
  const session = useRef(0);
  const stop = useCallback(() => {
    session.current++;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  const start = useCallback(async () => {
    stop();
    const id = session.current;
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("unavailable");
      setMessage("الكاميرا غير مدعومة في هذا المتصفح. اختر صورة من جهازك.");
      return;
    }
    setState("starting");
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (id !== session.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      if (video.current) {
        video.current.srcObject = media;
        await video.current.play().catch(() => undefined);
      }
      // The buyer may have chosen a photo or closed the dialog while the preview was starting.
      if (id !== session.current) return;
      setState("live");
      setMessage("");
    } catch (error) {
      if (id !== session.current) return;
      stop();
      setState("unavailable");
      setMessage(
        error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")
          ? "لم يُسمح باستخدام الكاميرا. يمكنك السماح بها من إعدادات المتصفح، أو اختيار صورة من جهازك."
          : "تعذر فتح الكاميرا. اختر صورة من جهازك بدلًا من ذلك.",
      );
    }
  }, [stop]);

  useEffect(() => {
    void start();
    return () => stop();
  }, [start, stop]);
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const close = () => { stop(); onClose(); };
  const capture = () => {
    const element = video.current;
    if (!element || !element.videoWidth) return;
    const scale = Math.min(1, 1600 / Math.max(element.videoWidth, element.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(element.videoWidth * scale);
    canvas.height = Math.round(element.videoHeight * scale);
    canvas.getContext("2d")!.drawImage(element, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return setMessage("تعذر التقاط الصورة. حاول مجددًا.");
      const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
      stop();
      setShot({ file, url: URL.createObjectURL(file) });
      setState("preview");
    }, "image/jpeg", 0.88);
  };
  const choose = (file?: File) => {
    if (!file) return;
    if (!TYPES.includes(file.type) || file.size < 1 || file.size > MAX_BYTES)
      return setMessage("اختر صورة JPEG أو PNG أو WebP لا يتجاوز حجمها 5 ميغابايت.");
    stop();
    setShot({ file, url: URL.createObjectURL(file) });
    setState("preview");
    setMessage("");
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="البحث بصورة" dir="rtl" data-testid="camera-capture" data-state={state}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center">
      <div className="flex max-h-[100dvh] w-full max-w-md flex-col gap-3 rounded-t-2xl bg-background p-4 sm:rounded-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">ابحث بصورة</h2>
          <button type="button" aria-label="إلغاء" data-testid="camera-cancel" onClick={close} className={iconButtonClass("ghost")}><X size={18} aria-hidden /></button>
        </div>
        <div className="relative aspect-[3/4] max-h-[60dvh] w-full overflow-hidden rounded-xl bg-muted">
          <video ref={video} playsInline muted aria-label="معاينة الكاميرا" data-testid="camera-video"
            className={`h-full w-full object-cover ${state === "live" || state === "starting" ? "" : "hidden"}`} />
          {shot && state === "preview" && <img src={shot.url} alt="الصورة الملتقطة" data-testid="camera-preview" className="h-full w-full object-contain" />}
          {state === "unavailable" && <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">لا توجد معاينة كاميرا.</div>}
        </div>
        <p role="status" aria-live="polite" data-testid="camera-message" className="min-h-5 text-sm text-muted-foreground">
          {message || (state === "preview" ? "راجع الصورة. صورتك خاصة بك ولا تُنشر." : "")}
        </p>
        <input ref={fileInput} type="file" accept={TYPES.join(",")} className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="camera-file"
          onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; choose(file); }} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          {state === "preview" ? (
            <>
              <button type="button" data-testid="camera-retake" onClick={() => { setShot(null); void start(); }} className={buttonClass("secondary")}>
                <RotateCcw size={16} aria-hidden /> إعادة الالتقاط
              </button>
              <button type="button" data-testid="camera-confirm" onClick={() => shot && (stop(), onConfirm(shot.file))} className={buttonClass("primary")}>
                <Check size={16} aria-hidden /> استخدم الصورة
              </button>
            </>
          ) : (
            <>
              <button type="button" data-testid="camera-choose" onClick={() => fileInput.current?.click()} className={buttonClass("secondary")}>
                <ImagePlus size={16} aria-hidden /> من الجهاز
              </button>
              <button type="button" data-testid="camera-shutter" disabled={state !== "live"} onClick={capture} className={buttonClass("primary")}>
                <Camera size={16} aria-hidden /> التقط
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
