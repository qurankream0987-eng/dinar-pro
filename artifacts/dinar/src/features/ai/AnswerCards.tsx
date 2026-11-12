/**
 * Structured answer cards (chart, option comparison, price card, interactive choice). The model
 * writes a fenced block such as ```dinar-chart {json}```; this file validates the JSON against a
 * small closed schema and renders it with DINAR's own components. Everything is plain text: no
 * HTML, no links, no images from model output, and nothing here can buy, pay or publish. A
 * choice only sends its label as the user's next message, which the server judges as usual.
 */
import { useState } from "react";
import { textDirection } from "./rich-text";

export const ANSWER_CARD_LANGUAGES = ["dinar-chart", "dinar-options", "dinar-price", "dinar-choice"] as const;
export type AnswerCardLanguage = (typeof ANSWER_CARD_LANGUAGES)[number];
export const isAnswerCardLanguage = (language: string): language is AnswerCardLanguage =>
  (ANSWER_CARD_LANGUAGES as readonly string[]).includes(language);

/** The composer listens for this event and sends the text as the user's next message. */
export const COMPOSE_EVENT = "dinar:compose";

const str = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const list = <T,>(value: unknown, max: number, map: (item: unknown) => T | undefined): T[] =>
  Array.isArray(value) ? value.slice(0, max).map(map).filter((item): item is T => item !== undefined) : [];

type Chart = { title?: string; unit?: string; items: { label: string; value: number }[] };
type Options = { title?: string; items: { name: string; badge?: string; summary?: string; pros: string[]; cons: string[] }[] };
type Price = { title?: string; note?: string; items: { label: string; amount: string; note?: string }[] };
type Choice = { question: string; options: string[] };

export function parseAnswerCard(language: AnswerCardLanguage, code: string): Chart | Options | Price | Choice | undefined {
  let raw: any;
  try { raw = JSON.parse(code); } catch { return undefined; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  switch (language) {
    case "dinar-chart": {
      const items = list(raw.items, 12, (item: any) => {
        const label = str(item?.label, 40);
        const value = typeof item?.value === "number" && Number.isFinite(item.value) && item.value >= 0 ? item.value : undefined;
        return label && value !== undefined ? { label, value } : undefined;
      });
      return items.length >= 2 ? { title: str(raw.title, 80), unit: str(raw.unit, 16), items } : undefined;
    }
    case "dinar-options": {
      const items = list(raw.items, 6, (item: any) => {
        const name = str(item?.name, 60);
        return name ? { name, badge: str(item?.badge, 28), summary: str(item?.summary, 300), pros: list(item?.pros, 4, (p) => str(p, 120)), cons: list(item?.cons, 4, (c) => str(c, 120)) } : undefined;
      });
      return items.length >= 2 ? { title: str(raw.title, 80), items } : undefined;
    }
    case "dinar-price": {
      const items = list(raw.items, 4, (item: any) => {
        const label = str(item?.label, 50);
        const amount = str(item?.amount, 30);
        return label && amount ? { label, amount, note: str(item?.note, 80) } : undefined;
      });
      return items.length ? { title: str(raw.title, 80), note: str(raw.note, 200), items } : undefined;
    }
    case "dinar-choice": {
      const question = str(raw.question, 160);
      const options = [...new Set(list(raw.options, 6, (o) => str(o, 60)))];
      return question && options.length >= 2 ? { question, options } : undefined;
    }
  }
}

function ChartCard({ card }: { card: Chart }) {
  const max = Math.max(...card.items.map((item) => item.value), 0) || 1;
  const format = new Intl.NumberFormat("ar", { numberingSystem: "latn", maximumFractionDigits: 2 });
  return (
    <figure className="answer-card answer-chart" data-testid="answer-chart" dir="rtl">
      {card.title && <figcaption className="answer-card-title">{card.title}</figcaption>}
      <ul>
        {card.items.map((item, index) => (
          <li key={index} style={{ ["--bar" as string]: `${(item.value / max) * 100}%`, ["--delay" as string]: `${index * 70}ms` }}>
            <span className="answer-chart-label" dir={textDirection(item.label)}>{item.label}</span>
            <span className="answer-chart-track"><span className={`answer-chart-bar tone-${index % 5}`} /></span>
            <span className="answer-chart-value">{format.format(item.value)}{card.unit ? ` ${card.unit}` : ""}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function OptionsCard({ card }: { card: Options }) {
  return (
    <section className="answer-card answer-options" data-testid="answer-options" dir="rtl">
      {card.title && <h4 className="answer-card-title">{card.title}</h4>}
      <ol>
        {card.items.map((item, index) => (
          <li key={index} className="answer-option">
            <span className="answer-option-mark" aria-hidden="true">{index + 1}</span>
            <div className="answer-option-body">
              <div className="answer-option-head">
                <strong dir={textDirection(item.name)}>{item.name}</strong>
                {item.badge && <span className="answer-badge">{item.badge}</span>}
              </div>
              {item.summary && <p>{item.summary}</p>}
              {(item.pros.length > 0 || item.cons.length > 0) && (
                <dl>
                  {item.pros.length > 0 && <><dt className="is-pro">ميزة</dt><dd>{item.pros.join(" · ")}</dd></>}
                  {item.cons.length > 0 && <><dt className="is-con">حد</dt><dd>{item.cons.join(" · ")}</dd></>}
                </dl>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PriceCard({ card }: { card: Price }) {
  return (
    <section className="answer-card answer-price" data-testid="answer-price" dir="rtl">
      {card.title && <h4 className="answer-card-title">{card.title}</h4>}
      <div className="answer-price-grid" style={{ ["--cols" as string]: String(card.items.length) }}>
        {card.items.map((item, index) => (
          <div key={index} className="answer-price-cell">
            <span className="answer-price-label">{item.label}</span>
            <strong className="answer-price-amount" dir="auto">{item.amount}</strong>
            {item.note && <span className="answer-price-note">{item.note}</span>}
          </div>
        ))}
      </div>
      <p className="answer-price-foot">{card.note ? `${card.note} · ` : ""}أسعار تقديرية من المساعد، ليست عرضًا في دينار.</p>
    </section>
  );
}

function ChoiceCard({ card }: { card: Choice }) {
  const [chosen, setChosen] = useState<string>();
  return (
    <fieldset className="answer-card answer-choice" data-testid="answer-choice" dir="rtl" disabled={Boolean(chosen)}>
      <legend className="answer-card-title">{card.question}</legend>
      {card.options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={chosen === option}
          className="answer-choice-option"
          onClick={() => {
            setChosen(option);
            window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: option }));
          }}
        >
          <span className="answer-choice-dot" aria-hidden="true" />
          <span dir={textDirection(option)}>{option}</span>
        </button>
      ))}
    </fieldset>
  );
}

/**
 * A card the model fenced as ```json (or unlabelled) instead of ```dinar-…: recognised only when
 * the JSON fits one read-only card schema by its distinctive keys; otherwise it stays a code block.
 */
export function detectAnswerCardLanguage(language: string, code: string): AnswerCardLanguage | undefined {
  if (isAnswerCardLanguage(language)) return language;
  if (language && language !== "json") return undefined;
  let raw: any;
  try { raw = JSON.parse(code); } catch { return undefined; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const first = Array.isArray(raw.items) ? raw.items[0] : undefined;
  // Never the interactive choice: a tappable card needs the explicit ```dinar-choice fence.
  const guess: AnswerCardLanguage | undefined =
    first && typeof first.value === "number" && "label" in first ? "dinar-chart"
        : first && typeof first.amount === "string" && "label" in first ? "dinar-price"
          : first && typeof first.name === "string" ? "dinar-options"
            : undefined;
  return guess && parseAnswerCard(guess, code) ? guess : undefined;
}

export function AnswerCard({ language, code }: { language: AnswerCardLanguage; code: string }) {
  const card = parseAnswerCard(language, code);
  // A card still streaming (or malformed) shows a quiet placeholder, never raw JSON.
  if (!card) return <div className="answer-card answer-card-pending" aria-hidden="true" />;
  switch (language) {
    case "dinar-chart": return <ChartCard card={card as Chart} />;
    case "dinar-options": return <OptionsCard card={card as Options} />;
    case "dinar-price": return <PriceCard card={card as Price} />;
    case "dinar-choice": return <ChoiceCard card={card as Choice} />;
  }
}
