import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { iconButtonClass } from "@/ui/Button";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { ArrowUp, Camera, LoaderCircle, Mic, MicOff, Plus, Square, X } from "lucide-react";
// The camera is loaded on first use; it is not part of the chat's initial bundle.
const CameraCapture = lazy(() => import("./CameraCapture").then((module) => ({ default: module.CameraCapture })));
import { isSearchPhoto, markSearchPhoto } from "./visual-search-photo";
import { textDirection } from "./rich-text";
import { CHAT_VIDEO_TYPES, isChatVideoFile } from "@/features/listing-photo-upload";
import { transcribeAiVoiceRecording } from "./ai-api";
import { EffortPicker } from "./EffortPicker";

export type ReasoningEffort = "low" | "medium" | "high";

const WAVE_BARS = [18, 28, 42, 64, 36, 52, 84, 46, 30, 68, 94, 58, 38, 76, 48, 32, 62, 88, 54, 36, 70, 44, 26, 16];

const VoiceWaveformBadge = memo(function VoiceWaveformBadge({
  recording,
  transcribing,
  disabled,
  onClick,
}: {
  recording: boolean;
  transcribing: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-hidden="true"
      tabIndex={-1}
      data-recording={recording || undefined}
      data-transcribing={transcribing || undefined}
      className="dinar-composer-wave-pill hidden sm:inline-flex"
      title="تحدث مع جاسم بالصوت"
    >
      <svg
        width="104"
        height="24"
        viewBox="0 0 104 24"
        fill="none"
        className="dinar-composer-waveform"
        aria-hidden="true"
      >
        {WAVE_BARS.map((pct, idx) => {
          const h = Math.max(3, Math.round((pct / 100) * 20));
          const y = (24 - h) / 2;
          const x = 4 + idx * 4.1;
          const isGold = idx >= 8 && idx <= 15;
          return (
            <rect
              key={idx}
              x={x}
              y={y}
              width="2.1"
              height={h}
              rx="1.05"
              fill={isGold ? "#f3cc73" : "#38bdf8"}
              opacity={recording ? 0.96 : 0.72}
              style={
                recording
                  ? {
                      transformOrigin: `${x + 1}px 12px`,
                      animation: `dinar-wave-pulse ${520 + (idx % 5) * 110}ms ease-in-out ${(idx % 6) * 60}ms infinite alternate`,
                    }
                  : undefined
              }
            />
          );
        })}
      </svg>
    </button>
  );
});

/** Drafting stays available while DINAR works. Sending is guarded by the turn owner. */
export const ChatComposer = memo(function ChatComposer({
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

  const toggleVoiceInput = useStableCallback(async () => {
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
      setHint("سيُرسل التسجيل إلى Groq لتحويله إلى نص؛ لا يحفظ جاسم ملف الصوت.");
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
          setHint("راجع النص المحوّل، ثم أرسله إلى جاسم.");
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
  });

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
    let width = textarea.parentElement?.clientWidth;
    const parent = textarea.parentElement;
    if (parent) {
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

  /** One path for picker, paste and drop: same types, size and count limits. */
  const addFiles = (selected: File[]) => {
    if (!selected.length) return;
    if (!canUploadPhotos) {
      setHint("سجّل الدخول لإرفاق صور في المحادثة.");
      return;
    }
    const videos = selected.filter(isChatVideoFile);
    if (videos.length) {
      const video = videos[0]!;
      if (videos.length > 1 || selected.length > 1) { setHint("أرسل فيديو واحدًا في كل رسالة، من دون صور."); return; }
      if (!CHAT_VIDEO_TYPES.has(video.type) || video.size < 1 || video.size > 25 * 1024 * 1024) {
        setHint("اختر فيديو MP4 أو WebM أو MOV بحجم لا يتجاوز 25 ميغابايت.");
        return;
      }
      setHint("سيُحفظ الفيديو في محادثتك بشكل خاص. فهم محتوى الفيديو غير مفعّل بعد.");
      onPhotosChange([video]);
      return;
    }
    if (photos.some(isChatVideoFile)) photos = [];
    const valid = selected.filter(
      (file) =>
        ["image/jpeg", "image/png", "image/webp"].includes(file.type) &&
        file.size > 0 &&
        file.size <= 5 * 1024 * 1024,
    );
    const invalidCount = selected.length - valid.length;
    const remaining = 4 - photos.filter((file) => !isSearchPhoto(file)).length;
    const accepted = valid.slice(0, Math.max(0, remaining));
    if (invalidCount)
      setHint("اختر صور JPEG أو PNG أو WebP لا يتجاوز حجم كل منها 5 ميغابايت.");
    else if (valid.length > remaining)
      setHint("يمكن إرفاق أربع صور كحد أقصى.");
    else setHint("");
    if (accepted.length)
      onPhotosChange([...photos.filter((file) => !isSearchPhoto(file)), ...accepted]);
  };
  const [dragging, setDragging] = useState(false);

  return (
    <>
    {cameraOpen && (
      <Suspense fallback={null}>
      <CameraCapture
        onClose={() => {
          setCameraOpen(false);
          window.requestAnimationFrame(() => cameraButton.current?.focus());
        }}
        onConfirm={(file) => {
          setCameraOpen(false);
          onPhotosChange([markSearchPhoto(file)]);
          setHint("أضف وصفًا إن شئت، ثم أرسل الصورة إلى جاسم.");
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
              {isChatVideoFile(file) ? (
                <video
                  src={url}
                  muted
                  playsInline
                  preload="metadata"
                  aria-label="معاينة الفيديو المرفق"
                  data-testid="composer-video-preview"
                  className="h-full w-full object-cover"
                />
              ) : (
                <img
                  src={url}
                  alt={searching ? "صورة المنتج الذي تبحث عنه" : `معاينة صورة الإعلان ${index + 1}`}
                  className="h-full w-full object-cover"
                />
              )}
              <button
                type="button"
                aria-label={`إزالة الصورة ${index + 1}`}
                disabled={busy}
                onClick={() => onPhotosChange(photos.filter((_, i) => i !== index))}
                className={`${iconButtonClass("outline")} !absolute end-0.5 top-0.5`}
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          ))}
          <p className="min-w-32 text-xs leading-5 text-muted-foreground">
            {searching
              ? "سأبحث عن هذا المنتج في العروض المنشورة. صورتك خاصة بك ولا تُنشر."
              : "يمكن لجاسم اقتراح عنوان ووصف ومواصفات مرئية من الصور. راجع كل اقتراح قبل استخدامه."}
          </p>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        onChange={(event) => {
          const selected = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          addFiles(selected);
        }}
      />
      <div
        className={`ai-composer-box${dragging ? " is-dragging" : ""}${recording ? " is-recording-voice" : ""}`}
        dir="ltr"
        onDragOver={(event) => {
          if (!event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (!files.length) return;
          event.preventDefault();
          setDragging(false);
          if (!busy && !offline) addFiles(files);
        }}
      >
        <button
          type="button"
          aria-label="إرفاق صور للمحادثة"
          aria-describedby="composer-hint"
          data-testid="button-ai-attachment-info"
          disabled={busy || offline}
          onClick={() => {
            if (!canUploadPhotos) {
              setHint("سجّل الدخول لإرفاق صور في المحادثة.");
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
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (!files.length) return;
            event.preventDefault();
            if (!busy && !offline) addFiles(files);
          }}
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
          placeholder="اسأل جاسم..."
          aria-label="رسالتك إلى JassimAI"
          data-testid="input-ai-composer"
          className="block min-h-[42px] max-h-44 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-base leading-7 outline-none placeholder:text-muted-foreground"
        />
        <div className="flex shrink-0 items-center gap-1.5">
          {(!draft.trim() || recording || transcribing) && (
            <VoiceWaveformBadge
              recording={recording}
              transcribing={transcribing}
              disabled={busy || offline || transcribing}
              onClick={toggleVoiceInput}
            />
          )}
          <EffortPicker value={reasoningEffort} disabled={busy || offline} onChange={onReasoningEffortChange} />
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
              title="يوقف عرض الرد فقط؛ يتحقق جاسم من نتيجة الطلب على الخادم."
              data-testid="button-stop-ai-response" className={iconButtonClass("outline")}>
              <Square size={18} aria-hidden />
            </button>
          )}
          <button
            type="submit"
            disabled={(!draft.trim() && photos.length === 0) || busy || offline}
            aria-label={busy ? "جاسم يعمل الآن" : "إرسال الرسالة"}
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
});
