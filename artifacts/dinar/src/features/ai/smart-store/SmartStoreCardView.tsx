/**
 * Minimal reference renderer for smart store cards (docs/design/SMART-STORE-CARDS-BRIEF.md).
 * Deliberately plain: it proves the contract end to end. The visual design is Google's task; the
 * behaviour here (sections in order, nothing invented, events only, server quote) must be kept.
 */
import type { CardEvent, SmartSection, SmartStoreCard } from "@workspace/api-zod/smart-store-card";

type Send = (event: CardEvent) => void;

function Section({ section, card, send }: { section: SmartSection; card: SmartStoreCard; send?: Send }) {
  const ref = { cardId: card.cardId, revision: card.revision };
  switch (section.kind) {
    case "UNDERSTOOD_REQUEST":
      return (
        <div className="flex flex-wrap gap-2" aria-label="فهمت طلبك">
          {section.chips.map((chip) => (
            <span key={chip.id} className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs">
              {chip.label}
              {send && <button type="button" aria-label={`إزالة ${chip.label}`} onClick={() => send({ type: "REFINE_REMOVE", ...ref, chipId: chip.id })}>×</button>}
            </span>
          ))}
        </div>
      );
    case "CATEGORY_TABS":
      return (
        <div role="tablist" className="flex gap-2 overflow-x-auto">
          {section.tabs.map((tab) => (
            <button key={tab.id} type="button" role="tab" aria-selected={tab.selected} disabled={!send} className={`shrink-0 rounded-full border px-3 py-1 text-xs ${tab.selected ? "border-primary text-primary" : ""}`} onClick={() => send?.({ type: "SELECT_TAB", ...ref, tabId: tab.id })}>
              {tab.label}
            </button>
          ))}
        </div>
      );
    case "HERO_GALLERY":
      return (
        <div className="flex snap-x gap-2 overflow-x-auto">
          {section.media.map((item, index) => (
            <figure key={index} className="w-full shrink-0 snap-center">
              <img src={item.url} alt={item.alt} loading="lazy" className="aspect-[4/3] w-full rounded-lg object-cover" />
              {item.illustrative && <figcaption className="text-[10px] text-muted-foreground">صورة توضيحية</figcaption>}
            </figure>
          ))}
        </div>
      );
    case "PRODUCT_GRID":
      return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {section.products.map((product) => (
            <button key={product.id} type="button" disabled={!send || !product.available} aria-pressed={product.selected ?? false} className={`rounded-lg border p-2 text-start text-xs ${product.selected ? "border-primary" : ""} ${product.available ? "" : "opacity-50"}`} onClick={() => send?.({ type: "SELECT_PRODUCT", ...ref, productId: product.id })}>
              <img src={product.media.url} alt={product.media.alt} loading="lazy" className="mb-1 aspect-square w-full rounded object-cover" />
              <span className="block font-medium">{product.title}</span>
              <bdi>{product.available ? product.price.label : "غير متوفر"}</bdi>
            </button>
          ))}
        </div>
      );
    case "PRODUCT_DETAIL":
      return (
        <div className="space-y-1">
          <h4 className="font-semibold">{section.title}</h4>
          {section.subtitle && <p className="text-xs text-muted-foreground">{section.subtitle}</p>}
          <p className="font-bold"><bdi>{section.price.label}</bdi></p>
          {section.rating && <p className="text-xs">★ {section.rating.value.toFixed(1)} (<bdi>{section.rating.count}</bdi> تقييم)</p>}
        </div>
      );
    case "VARIANT_PICKER":
      if (section.style === "STEPPER") {
        const quantity = Number(section.options.find((option) => option.selected)?.label ?? 1) || 1;
        const productId = (card.sections.find((item) => item.kind === "PRODUCT_DETAIL") as { productId?: string } | undefined)?.productId ?? "item";
        return (
          <div className="flex items-center gap-3" aria-label={section.label}>
            <span className="text-xs">{section.label}</span>
            <button type="button" aria-label="إنقاص الكمية" disabled={!send || quantity <= 1} onClick={() => send?.({ type: "SET_QUANTITY", ...ref, productId, quantity: quantity - 1 })}>−</button>
            <bdi>{quantity}</bdi>
            <button type="button" aria-label="زيادة الكمية" disabled={!send || quantity >= 99} onClick={() => send?.({ type: "SET_QUANTITY", ...ref, productId, quantity: quantity + 1 })}>+</button>
          </div>
        );
      }
      return (
        <fieldset className="space-y-1">
          <legend className="text-xs">{section.label}</legend>
          <div className="flex flex-wrap gap-2">
            {section.options.map((option) => (
              <button key={option.id} type="button" aria-pressed={option.selected} aria-label={option.label} disabled={!send || !option.available} className={`rounded-full border px-3 py-1 text-xs ${option.selected ? "border-primary" : ""} ${option.available ? "" : "line-through opacity-50"}`} onClick={() => send?.({ type: "SELECT_OPTION", ...ref, groupId: section.groupId, optionId: option.id, selected: true })}>
                {option.color && <span aria-hidden className="me-1 inline-block size-3 rounded-full align-middle" style={{ background: option.color }} />}
                {option.label}
                {option.price && <bdi className="ms-1">{option.price.label}</bdi>}
              </button>
            ))}
          </div>
        </fieldset>
      );
    case "CUSTOMIZER":
      return (
        <fieldset className="space-y-1">
          <legend className="text-xs">{section.label}</legend>
          <div className="flex flex-wrap gap-2">
            {section.options.map((option) => (
              <label key={option.id} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs">
                <input type={section.multi ? "checkbox" : "radio"} name={section.groupId} checked={option.selected} disabled={!send} onChange={(event) => send?.({ type: "SELECT_OPTION", ...ref, groupId: section.groupId, optionId: option.id, selected: event.target.checked })} />
                {option.label}
                {option.delta && <bdi>+{option.delta.label}</bdi>}
              </label>
            ))}
          </div>
        </fieldset>
      );
    case "BUNDLE_BUILDER":
      return (
        <div className="space-y-1">
          <h4 className="text-sm font-semibold">{section.label}</h4>
          <ul className="space-y-1 text-xs">
            {section.slots.map((slot) => (
              <li key={slot.slotId} className="flex justify-between gap-2">
                <span>{slot.label}</span>
                <span>{slot.item ? <>{slot.item.title} — <bdi>{slot.item.price.label}</bdi></> : "لم يُختر بعد"}</span>
              </li>
            ))}
          </ul>
          {section.compatibility && <p className="text-xs" role="status">التوافق: {section.compatibility.status === "COMPATIBLE" ? "متوافق" : section.compatibility.status === "INCOMPATIBLE" ? "غير متوافق" : "غير متحقق منه"}{section.compatibility.note ? ` — ${section.compatibility.note}` : ""}</p>}
        </div>
      );
    case "SPECS":
      return (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {section.rows.map((row, index) => (
            <div key={index} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "POLICIES":
      return <ul className="space-y-1 text-xs">{section.items.map((item, index) => <li key={index}>{item.label}</li>)}</ul>;
    case "RECOMMENDATIONS":
      return (
        <div>
          <h4 className="text-xs">{section.label}</h4>
          <div className="flex gap-2 overflow-x-auto">{section.items.map((item) => <span key={item.id} className="shrink-0 rounded border px-2 py-1 text-xs">{item.title}</span>)}</div>
        </div>
      );
    case "MEDIA_3D":
      return null; // Level 2 (owner decision pending)
    case "TRY_ON":
      return <p className="text-xs text-muted-foreground">{section.reason}</p>;
  }
}

export function SmartStoreCardView({ card, onEvent, busy = false }: { card: SmartStoreCard; onEvent?: Send; busy?: boolean }) {
  const send = busy ? undefined : onEvent;
  return (
    <section dir="rtl" aria-label={card.store.name} data-testid="smart-store-card" data-vertical={card.vertical} data-revision={card.revision} className="mt-3 w-full min-w-0 max-w-xl space-y-4 rounded-xl border bg-card p-4 text-sm [overflow-wrap:anywhere]">
      <header className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{card.store.name}</h3>
        {card.store.sponsored && <span className="rounded-full border px-2 text-xs">ممول</span>}
      </header>
      {card.source && <p className="text-[11px] text-muted-foreground">حسب نظام المتجر — تم التحقق <time dateTime={card.source.checkedAt}>{new Date(card.source.checkedAt).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}</time></p>}
      {card.sections.map((section, index) => <Section key={`${section.kind}-${index}`} section={section} card={card} send={send} />)}
      {card.notice && <p role="status" className="text-xs">{card.notice}</p>}
      <footer className="flex items-center justify-between gap-3 border-t pt-3">
        {card.quote ? (
          <p>
            الإجمالي <bdi className="font-bold">{card.quote.total.label}</bdi>
            {!card.quote.final && <span className="ms-1 text-[11px] text-muted-foreground">(تقديري — يؤكده المتجر)</span>}
          </p>
        ) : <span />}
        <button type="button" disabled={!send || card.status !== "READY"} className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50" onClick={() => send?.({ type: "PRIMARY_ACTION", cardId: card.cardId, revision: card.revision })}>
          {card.primaryAction.label}
        </button>
      </footer>
    </section>
  );
}
