import { Button } from "@/ui/Button";

/**
 * DINAR NEXT G2: one party's view of a buyer–seller thread, exactly as the server rebuilt it.
 * Each message shows who wrote it and how (their own words, or a DINAR draft they approved);
 * DINAR facts and system status are labelled separately. Display only: sending is always the
 * author's own confirmation in the conversation.
 */
export { normalizeInquiry, type InquiryPayload } from "./inquiry-types";
import type { InquiryPayload } from "./inquiry-types";

const DRAFT_STATUS: Record<string, string> = {
  PENDING: "بانتظار موافقتك — لم يُرسل بعد",
  CONFIRMED: "أُرسلت بعد موافقتك",
  CANCELLED: "أُلغيت؛ لم يُرسل شيء",
  EXPIRED: "انتهت صلاحيتها؛ لم يُرسل شيء",
  REJECTED: "لم تُرسل؛ لم يتغير شيء",
  EXECUTING: "قيد الإرسال",
};
const clock = (value: string | null) => (value ? new Date(value).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" }) : "");

function Chip({ children, tone = "muted" }: { children: string; tone?: "muted" | "primary" }) {
  return <span className={`inline-flex max-w-full rounded-full px-2 py-0.5 text-[11px] leading-5 ${tone === "primary" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{children}</span>;
}

export function InquirySurface({ inquiry, active, onSend }: { inquiry: InquiryPayload; active: boolean; onSend?: (text: string) => void }) {
  const send = active ? onSend : undefined;
  const title = inquiry.view === "DRAFT" ? "مراجعة الرسالة قبل الإرسال" : inquiry.view === "LIST" ? "رسائل البيع والشراء" : inquiry.view === "INCOMING" ? "رسالة وصلتك عبر جاسم" : inquiry.view === "STATUS" ? "محادثة الاستفسار" : "استفسار";
  return (
    <section dir="rtl" aria-label={title} data-testid="inquiry-surface" data-view={inquiry.view} className="ai-surface mt-3 min-w-0 max-w-xl space-y-3 rounded-xl border border-border bg-card p-4 text-sm [overflow-wrap:anywhere]">
      <h3 className="flex flex-wrap items-center justify-between gap-2 font-semibold">
        <span>{title}</span>
        {inquiry.listing && <span className="min-w-0 truncate text-xs font-normal text-muted-foreground" dir="auto">{inquiry.listing.title}</span>}
      </h3>
      {inquiry.fact && (
        <p className="rounded-lg border border-border bg-background p-2 text-xs" data-testid="inquiry-fact">
          <Chip tone="primary">معلومة من سجل جاسم</Chip> <bdi>{inquiry.fact.text}</bdi>
        </p>
      )}
      {inquiry.notice && <p role="status">{inquiry.notice}</p>}
      {inquiry.view === "DRAFT" && (
        <div className="space-y-2" data-testid="inquiry-draft">
          <blockquote className="rounded-lg bg-muted/40 p-3 leading-7" dir="auto">{inquiry.body}</blockquote>
          {inquiry.provenanceLabel && <Chip>{inquiry.provenanceLabel}</Chip>}
          <ul className="list-inside list-disc text-xs text-muted-foreground">{inquiry.lines?.map((line, index) => <li key={index}>{line}</li>)}</ul>
          <p role="status" data-testid="inquiry-draft-status">{DRAFT_STATUS[inquiry.status ?? ""] ?? "راجع حالة الرسالة"}</p>
          {inquiry.status === "PENDING" && send && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => send("أرسل")} data-testid="inquiry-send">أرسل</Button>
              <Button size="sm" variant="ghost" onClick={() => send("إلغاء")}>إلغاء</Button>
            </div>
          )}
        </div>
      )}
      {inquiry.messages && (
        <ol className="space-y-2" aria-label="الرسائل">
          {inquiry.messages.map((message) => (
            <li key={message.id} data-testid="inquiry-message" data-author={message.authorRole} data-provenance={message.provenance} className={`space-y-1 rounded-lg p-3 ${message.mine ? "bg-primary/5" : "border border-border bg-background"}`}>
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><b className="text-foreground">{message.authorLabel}</b><Chip>{message.provenanceLabel}</Chip><span>{clock(message.createdAt)}</span></p>
              <p className="leading-7" dir="auto">{message.body}</p>
              {message.mine && <p className="text-[11px] text-muted-foreground">{message.readAt ? "قرأها الطرف الآخر" : message.deliveredAt ? "وصلت إلى محادثته في جاسم ولم تُفتح بعد" : "أُرسلت"}</p>}
            </li>
          ))}
        </ol>
      )}
      {inquiry.statusLabel && <p role="status" className="text-xs" data-testid="inquiry-status">{inquiry.statusLabel}</p>}
      {inquiry.view === "INCOMING" && inquiry.awaitingMe && send && <p className="text-xs text-muted-foreground">اكتب ردك في المحادثة، وسأعرضه عليك قبل إرساله كما هو.</p>}
      {inquiry.items && (
        <ul className="space-y-2" aria-label="المحادثات">
          {inquiry.items.map((item) => (
            <li key={item.inquiryId} className="rounded-lg border border-border p-3" data-testid="inquiry-item">
              <p className="flex flex-wrap justify-between gap-2"><span className="font-medium" dir="auto">{item.listingTitle}</span><Chip tone={item.awaitingMe ? "primary" : "muted"}>{item.awaitingMe ? "بانتظار ردك" : item.statusLabel}</Chip></p>
              {item.lastMessage && <p className="mt-1 truncate text-xs text-muted-foreground" dir="auto">{item.lastMessage.authorLabel}: {item.lastMessage.body}</p>}
            </li>
          ))}
          {!inquiry.items.length && <li role="status">لا توجد رسائل بعد.</li>}
        </ul>
      )}
      {inquiry.notification && <p className="text-xs text-muted-foreground" data-testid="inquiry-notification">{inquiry.notification.label}</p>}
      {inquiry.privacyNote && <p className="text-xs text-muted-foreground">{inquiry.privacyNote}</p>}
    </section>
  );
}
