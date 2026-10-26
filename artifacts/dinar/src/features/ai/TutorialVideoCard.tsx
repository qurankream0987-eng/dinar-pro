import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { TutorialPayload } from "@workspace/api-zod/conversation-runtime";
import { Button } from "@/ui/Button";
import { recordTutorialLearningEvent } from "./ai-api";

export function TutorialVideoCard({
  tutorial,
  active,
  onSend,
}: {
  tutorial: TutorialPayload;
  active: boolean;
  onSend?: (message: string) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const recordedMilestones = useRef(new Set<number>());
  const openedTutorialId = useRef<string | null>(null);
  const step = tutorial.steps[stepIndex] ?? tutorial.steps[0]!;

  const record = (eventType: Parameters<typeof recordTutorialLearningEvent>[0]["eventType"], milestonePercent?: 25 | 50 | 75 | 100) => {
    void recordTutorialLearningEvent({
      tutorialId: tutorial.id,
      eventType,
      ...(milestonePercent === undefined ? {} : { milestonePercent }),
    }).then((saved) => {
      if (!saved) setHistoryUnavailable(true);
    });
  };

  useEffect(() => {
    if (!active || openedTutorialId.current === tutorial.id) return;
    openedTutorialId.current = tutorial.id;
    record("TUTORIAL_OPENED");
  // Inactive historical cards rendered during transcript reload are not opened events.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tutorial.id]);

  useEffect(() => {
    if (!playing || tutorial.steps.length < 2) return;
    const timer = window.setInterval(() => {
      setStepIndex((index) => {
        if (index >= tutorial.steps.length - 1) {
          setPlaying(false);
          return index;
        }
        const next = index + 1;
        const percent = Math.round((next / (tutorial.steps.length - 1)) * 100);
        const milestone = ([25, 50, 75, 100] as const).find(
          (value) => percent >= value && !recordedMilestones.current.has(value),
        );
        if (milestone) {
          recordedMilestones.current.add(milestone);
          record("PLAYBACK_PROGRESS_MILESTONE", milestone);
        }
        return next;
      });
    }, 1900);
    return () => window.clearInterval(timer);
  }, [playing, tutorial.steps.length]);

  return (
    <section
      dir="rtl"
      className="ai-surface mt-3 max-w-xl space-y-4 rounded-xl border border-border bg-card p-4"
      data-testid="tutorial-video-card"
      data-tutorial-id={tutorial.id}
      aria-label={tutorial.title}
    >
      <header className="space-y-1">
        <h3 className="font-semibold">{tutorial.title}</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          {tutorial.caption}
        </p>
      </header>

      <div
        className="relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-background to-amber-500/10 p-4"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">
            شرح صامت · خطوة {stepIndex + 1} من {tutorial.steps.length}
          </span>
          <span className="flex gap-1" aria-hidden="true">
            {tutorial.steps.map((item, index) => (
              <span
                key={item.title}
                className={`h-1.5 w-5 rounded-full ${
                  index === stepIndex ? "bg-primary" : "bg-muted-foreground/25"
                }`}
              />
            ))}
          </span>
        </div>
        <div
          className="mx-auto flex min-h-28 max-w-sm flex-col justify-center rounded-lg border border-border/70 bg-background/90 p-4 text-center transition-all duration-500"
          data-testid="tutorial-animation-frame"
        >
          <span className="mx-auto mb-2 grid h-9 w-9 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
            {stepIndex + 1}
          </span>
          <h4 className="font-semibold">{step.title}</h4>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {step.description}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            if (stepIndex >= tutorial.steps.length - 1) setStepIndex(0);
            recordedMilestones.current.clear();
            record("PLAYBACK_STARTED");
            setPlaying(true);
          }}
          aria-label="تشغيل الشرح"
        >
          تشغيل
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setStepIndex(0);
            recordedMilestones.current.clear();
            record("PLAYBACK_STARTED");
            setPlaying(true);
          }}
          aria-label="إعادة الشرح"
        >
          <RotateCcw aria-hidden="true" className="ms-1 h-4 w-4" />
          إعادة
        </Button>
        {active && onSend && (
          <>
            <Button size="sm" onClick={() => {
              record("CONTINUATION_TRIGGERED");
              onSend("فهمت");
            }}>
              فهمت
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                record("CONTINUATION_TRIGGERED");
                onSend("تخطي");
              }}
            >
              تخطي
            </Button>
          </>
        )}
      </div>
      {historyUnavailable && (
        <p role="status" className="text-xs text-muted-foreground">
          تعذر حفظ سجل التعلم الآن؛ يمكنك متابعة الشرح.
        </p>
      )}
    </section>
  );
}
