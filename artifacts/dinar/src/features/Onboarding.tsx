import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowLeft, ShoppingBag, Sparkles, Store } from "lucide-react";
import { useAccount } from "@/account/Account";
import { cn } from "@/lib/utils";
import { storage } from "@/lib/storage";
import { Button } from "@/ui/Button";
import { BrandMark } from "@/ui/Media";

const KEY = "bdinar-onboarded";
export const shouldOnboard = () => storage.get(KEY) !== "1";

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { market, verifying } = useAccount();
  const [step, setStep] = useState(0);
  const finish = () => {
    storage.set(KEY, "1");
    onDone();
  };
  const steps = [
    {
      art: <ShoppingBag size={44} strokeWidth={1.6} aria-hidden />,
      title: "اشترِ بالكمية التي تريدها",
      body: "كل عرض يُباع بالوحدة. اختر العدد، والإجمالي واضح أمامك قبل أي خطوة.",
    },
    {
      art: <Store size={44} strokeWidth={1.6} aria-hidden />,
      title: "وبِع من الحساب نفسه",
      body: "منتج، خدمة، ملف رقمي أو جلسة — اعرضه في دقائق وحدد ما تشمله الوحدة.",
    },
    {
      art: <Sparkles size={40} strokeWidth={1.7} aria-hidden />,
      title: "تحدث مع جاسم مباشرة",
      body: `اسأل جاسم للمقارنة أو الطلب، وتظهر الأسعار بعملة سوق ${market?.countryNameAr ?? "الكويت"} بوضوح قبل التأكيد.`,
    },
  ];
  const s = steps[step];
  const last = step === steps.length - 1;

  return (
    <DialogPrimitive.Root open={!verifying} onOpenChange={(o) => !o && finish()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sheet-overlay" />
        <DialogPrimitive.Content
          dir="rtl"
          data-testid="screen-onboarding"
          className="fixed inset-0 z-[var(--z-modal)] flex flex-col overflow-hidden bg-card animate-fade focus:outline-none md:inset-auto md:left-1/2 md:top-1/2 md:h-auto md:w-[400px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:shadow-lg"
        >
          <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-ink px-6 pb-10 pt-[calc(env(safe-area-inset-top,0px)+56px)] text-ink-foreground md:flex-none md:pt-12">
            <span aria-hidden className="absolute -end-20 -top-20 h-64 w-64 rounded-full border-[32px] border-accent/15" />
            <span aria-hidden className="absolute -bottom-24 -start-16 h-56 w-56 rounded-full border-[28px] border-white/5" />
            <div className="absolute start-5 top-[calc(env(safe-area-inset-top,0px)+16px)]">
              <BrandMark size={32} className="[&_span]:!text-ink-foreground" />
            </div>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="absolute end-4 top-[calc(env(safe-area-inset-top,0px)+14px)] rounded-full px-3 py-1.5 text-sm font-semibold text-ink-foreground/80 hover:bg-white/10"
                data-testid="button-skip-onboarding"
              >
                تخطٍّ
              </button>
            </DialogPrimitive.Close>
            <div key={step} className="relative flex h-24 w-24 animate-rise items-center justify-center rounded-full bg-accent text-accent-foreground shadow-[0_0_0_12px_hsl(var(--accent)/0.15)]">
              {s.art}
            </div>
          </div>
          <div className="px-6 pb-[calc(env(safe-area-inset-bottom,0px)+24px)] pt-8">
            <div key={step} className="min-h-[104px] animate-rise text-center">
              <DialogPrimitive.Title className="text-2xl font-bold">{s.title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mx-auto mt-2 max-w-xs text-md leading-7 text-muted-foreground">
                {s.body}
              </DialogPrimitive.Description>
            </div>
            <div className="my-6 flex justify-center gap-1.5" aria-hidden>
              {steps.map((_, i) => (
                <span key={i} className={cn("h-2 rounded-full transition-all", i === step ? "w-6 bg-primary" : "w-2 bg-border-strong")} />
              ))}
            </div>
            <Button
              size="lg"
              block
              variant={last ? "gold" : "primary"}
              onClick={() => (last ? finish() : setStep(step + 1))}
              data-testid="button-onboarding-next"
            >
              {last ? "ابدأ التسوق" : "التالي"}
              <ArrowLeft size={18} aria-hidden />
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
