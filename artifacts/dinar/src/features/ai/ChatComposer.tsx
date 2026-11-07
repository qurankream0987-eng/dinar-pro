import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { iconButtonClass } from "@/ui/Button";
import { ArrowUp, Camera, LoaderCircle, Mic, MicOff, Plus, Square, X } from "lucide-react";
// The camera is loaded on first use; it is not part of the chat's initial bundle.
const CameraCapture = lazy(() => import("./CameraCapture").then((module) => ({ default: module.CameraCapture })));
import { isSearchPhoto, markSearchPhoto } from "./visual-search-photo";
import { textDirection } from "./rich-text";
import { transcribeAiVoiceRecording } from "./ai-api";

export type ReasoningEffort = "low" | "medium" | "high";

/** Drafting stays available while DINAR works. Sending is guarded by the turn owner. */
export function ChatComposer({
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  photos,
  onPhotosChange,
  canUploadPhotos,
  busy,
  offline,
  reasoningEffort,
  onReasoningEffortChange,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  photos: File[];
  onPhotosChange: (files: File[]) => void;
  canUploadPhotos: boolean;
  busy: boolean;
  offline: boolean;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraButton = useRef<HTMLButtonElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const recordingTimer = useRef<number | undefined>(undefined);
  const voiceBase = useRef("");
  const [hint, setHint] = useState("");
  const [recording, setRecording] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const searching = photos.some(isSearchPhoto);
  const [transcribing, setTranscribing] = useState(false);
  const [previews, setPreviews] = useState<Array<{ file: File; url: string }>>(
    [],
  );
  useEffect(() => {
    const next = photos.map((file) => ({
      file,
      url: URL.createObjectURL(file),
    }));
    setPreviews(next);
    return () => next.forEach(({ url }) => URL.revokeObjectURL(url));
  }, [photos]);

  useEffect(() => () => {
    window.clearTimeout(recordingTimer.current);
    if (recorder.current) {
      recorder.current.onstop = null;
      if (recorder.current.state !== "inactive") recorder.current.stop();
    }
    mediaStream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    if (busy || offline) {
      window.clearTimeout(recordingTimer.current);
      const active = recorder.current;
      if (active) {
        active.onstop = null;
        if (active.state !== "inactive") active.stop();
        recorder.current = null;
      }
      mediaStream.current?.getTracks().forEach((track) => track.stop());
      mediaStream.current = null;
      setRecording(false);
    }
  }, [busy, offline]);

  const toggleVoiceInput = async () => {
    if (recorder.current) {
      window.clearTimeout(recordingTimer.current);
      recorder.current.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setHint("تسجيل الصوت غير مدعوم في هذا المتصفح. يمكنك كتابة رسالتك.");
      return;
    }
    try {
      setHint("سيُرسل التسجيل إلى Groq لتحويله إلى نص؛ لا يحفظ DINAR ملف الصوت.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStream.current = stream;
      const supportedTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ];
      const mimeType = supportedTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const active = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunks.current = [];
      voiceBase.current = draft.trimEnd();
      active.ondataavailable = (event) => {
        if (event.data.size) audioChunks.current.push(event.data);
      };
      active.onerror = () => {
        active.onstop = null;
        recorder.current = null;
        mediaStream.current?.getTracks().forEach((track) => track.stop());
        mediaStream.current = null;
        setHint("تعذر تسجيل الصوت. تحقق من الميكروفون وحاول مجددًا.");
        setRecording(false);
      };
      active.onstop = async () => {
        recorder.current = null;
        mediaStream.current?.getTracks().forEach((track) => track.stop());
        mediaStream.current = null;
        setRecording(false);
        const audio = new Blob(audioChunks.current, {
          type: active.mimeType || mimeType || "audio/webm",
        });
        audioChunks.current = [];
        if (!audio.size) {
          setHint("لم يُلتقط صوت. حاول التسجيل مجددًا.");
          return;
        }
        if (audio.size > 10 * 1024 * 1024) {
          setHint("التسجيل كبير جدًا. أعد المحاولة بمقطع أقصر.");
          return;
        }
        setTranscribing(true);
        setHint("أحوّل التسجيل إلى نص عربي…");
        try {
          const transcript = await transcribeAiVoiceRecording(audio);
          onDraftChange(
            [voiceBase.current, transcript].filter(Boolean).join(voiceBase.current ? " " : ""),
          );
          setHint("راجع النص المحوّل، ثم أرسله إلى DINAR.");
        } catch (error) {
          setHint(error instanceof Error ? error.message : "تعذر تحويل التسجيل إلى نص.");
        } finally {
          setTranscribing(false);
        }
      };
      recorder.current = active;
      active.start();
      setRecording(true);
      recordingTimer.current = window.setTimeout(() => {
        if (recorder.current?.state === "recording") {
          setHint("وصل التسجيل إلى الحد الأقصى، جارٍ تحويله إلى نص.");
          recorder.current.stop();
        }
      }, 60_000);
    } catch (error) {
      mediaStream.current?.getTracks().forEach((track) => track.stop());
      mediaStream.current = null;
      setRecording(false);
      setHint(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "لم يُسمح باستخدام الميكروفون. راجع إذن الميكروفون في المتصفح."
          : "تعذر بدء التسجيل. تحقق من إذن الميكروفون.",
      );
    }
  };

  useLayoutEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = "auto";
      const height = textarea.scrollHeight;
      textarea.style.height = `${Math.max(44, Math.min(height, 176))}px`;
      textarea.style.overflowY = height > 176 ? "auto" : "hidden";
    };
    resize();
    // Watch width changes rather than textarea height to avoid resize feedback.
    let width = textarea.parentElement?.clientWidth;
    const parent = textarea.parentElement;
    if (parent) {
      // Re-measure on the next frame: resizing the textarea inside the callback grows the
      // observed box in the same frame on narrow screens (a ResizeObserver loop).
      let frame = 0;
      const widthObserver = new ResizeObserver(() => {
        if (parent.clientWidth === width) return;
        width = parent.clientWidth;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(resize);
      });
      widthObserver.observe(parent);
      return () => {
        cancelAnimationFrame(frame);
        widthObserver.disconnect();
      };
    }
    return undefined;
  }, [draft]);

  return (
    <>
    {cameraOpen && (
      <Suspense fallback={null}>
      <CameraCapture
        onClose={() => {
          setCameraOpen(false);
          // Focus returns to the control that opened the camera.
          window.requestAnimationFrame(() => cameraButton.current?.focus());
        }}
        onConfirm={(file) => {
          setCameraOpen(false);
          // One search photo per message; it replaces listing photos rather than mixing with them.
          onPhotosChange([markSearchPhoto(file)]);
          setHint("أضف وصفًا إن شئت، ثم أرسل الصورة إلى DINAR.");
          input.current?.focus();
        }}
      />
      </Suspense>
    )}
    <form
      dir="rtl"
      className="dinar-chat-composer ai-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      aria-label="إرسال رسالة"
    >
      {previews.length > 0 && (
        <div
          dir="rtl"
          className="mx-auto mb-2 flex max-w-3xl items-center gap-2 overflow-x-auto px-1"
          aria-label={searching ? "صورة البحث المرفقة" : "صور الإعلان المرفقة"}
        >
          {previews.map(({ file, url }, index) => (
            <div
              key={`${file.name}-${file.lastModified}-${index}`}
              className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted"
            >
              <img
                src={url}
                alt={searching ? "صورة المنتج الذي تبحث عنه" : `معاينة صورة الإعلان ${index + 1}`}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                aria-label={`إزالة الصورة ${index + 1}`}
                disabled={busy}
                onClick={() => onPhotosChange(photos.filter((_, i) => i !== index))}
                className={`${iconButtonClass("outline")} absolute end-0.5 top-0.5`}
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          ))}
          <p className="min-w-32 text-xs leading-5 text-muted-foreground">
            {searching
              ? "سأبحث عن هذا المنتج في العروض المنشورة. صورتك خاصة بك ولا تُنشر."
              : "يمكن لـDINAR اقتراح عنوان ووصف ومواصفات مرئية من الصور. راجع كل اقتراح قبل استخدامه."}
          </p>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        onChange={(event) => {
          const selected = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (!selected.length) return;
          const valid = selected.filter(
            (file) =>
              ["image/jpeg", "image/png", "image/webp"].includes(file.type) &&
              file.size > 0 &&
              file.size <= 5 * 1024 * 1024,
          );
          const invalidCount = selected.length - valid.length;
          const remaining = 4 - photos.length;
          const accepted = valid.slice(0, remaining);
          if (invalidCount)
            setHint("اختر صور JPEG أو PNG أو WebP لا يتجاوز حجم كل منها 5 ميغابايت.");
          else if (valid.length > remaining)
            setHint("يمكن إرفاق أربع صور كحد أقصى.");
          else setHint("");
          if (accepted.length)
            onPhotosChange([...photos.filter((file) => !isSearchPhoto(file)), ...accepted]);
        }}
      />
      <div className="ai-composer-box" dir="ltr">
        <button
          type="button"
          aria-label="إضافة صور للإعلان"
          aria-describedby="composer-hint"
          data-testid="button-ai-attachment-info"
          disabled={busy || offline}
          onClick={() => {
            if (!canUploadPhotos) {
              setHint("سجّل الدخول لإضافة صور إلى مسودة الإعلان.");
              return;
            }
            fileInput.current?.click();
          }}
          className={`${iconButtonClass("ghost")} dinar-composer-attachment`}
        >
          <Plus size={20} aria-hidden />
        </button>
        <button
          type="button"
          ref={cameraButton}
          aria-label="ابحث بصورة"
          aria-haspopup="dialog"
          data-testid="button-ai-camera"
          disabled={busy || offline}
          onClick={() => {
            if (!canUploadPhotos) {
              setHint("سجّل الدخول للبحث بصورة.");
              return;
            }
            setCameraOpen(true);
          }}
          className={`${iconButtonClass("ghost")} dinar-composer-attachment`}
        >
          <Camera size={20} aria-hidden />
        </button>
        <textarea
          ref={input}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229 &&
              window.matchMedia("(pointer: fine)").matches
            ) {
              event.preventDefault();
              if (!busy && !offline) onSubmit();
            }
          }}
          rows={1}
          maxLength={4000}
          dir={textDirection(draft) ?? "rtl"}
          placeholder="اسأل دينار..."
          aria-label="رسالتك إلى DINAR AI"
          data-testid="input-ai-composer"
          className="block min-h-[42px] max-h-44 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-base leading-7 outline-none placeholder:text-muted-foreground"
        />
        <div className="flex shrink-0 items-center gap-1">
          <select
            aria-label="مستوى التفكير"
            value={reasoningEffort}
            disabled={busy || offline}
            onChange={(event) =>
              onReasoningEffortChange(event.target.value as ReasoningEffort)
            }
            className="dinar-composer-effort"
          >
            <option value="low">خفيف</option>
            <option value="medium">متوسط</option>
            <option value="high">أعمق</option>
          </select>
          <button
            type="button"
            aria-label={recording ? "إيقاف التسجيل الصوتي" : transcribing ? "جارٍ تحويل التسجيل" : "بدء التسجيل الصوتي"}
            aria-pressed={recording}
            title="يُرسل التسجيل إلى Groq للتفريغ العربي، ثم تراجع النص قبل إرساله."
            disabled={busy || offline || transcribing}
            onClick={toggleVoiceInput}
            className={`${iconButtonClass("ghost")} dinar-composer-mic ${recording ? "is-recording" : ""}`}
          >
            {transcribing ? <LoaderCircle size={19} className="animate-spin" aria-hidden /> : recording ? <MicOff size={19} aria-hidden /> : <Mic size={19} aria-hidden />}
          </button>
          {onStop && busy && (
            <button type="button" onClick={onStop} aria-label="إيقاف عرض الرد"
              title="يوقف عرض الرد فقط؛ يتحقق DINAR من نتيجة الطلب على الخادم."
              data-testid="button-stop-ai-response" className={iconButtonClass("outline")}>
              <Square size={18} aria-hidden />
            </button>
          )}
          <button
            type="submit"
            disabled={(!draft.trim() && photos.length === 0) || busy || offline}
            aria-label={busy ? "دينار يعمل الآن" : "إرسال الرسالة"}
            data-testid="button-send-ai-message"
            aria-busy={busy || undefined}
            data-ready={Boolean((draft.trim() || photos.length) && !busy && !offline)}
            className={`${iconButtonClass("solid")} dinar-composer-send`}
          >
            {busy ? (
              <LoaderCircle size={20} className="animate-spin" aria-hidden />
            ) : (
              <ArrowUp size={20} strokeWidth={2.2} aria-hidden />
            )}
          </button>
        </div>
      </div>
      <p
        id="composer-hint"
        role="status"
        className={
          hint
            ? "basis-full px-3 pb-2 text-xs leading-6 text-muted-foreground"
            : "sr-only"
        }
      >
        {hint}
      </p>
      {!hint && <p className="ai-composer-helper">راجع تفاصيل الإجراء قبل تأكيده.</p>}
    </form>
    </>
  );
}
