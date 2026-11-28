import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { AnswerCard, detectAnswerCardLanguage } from "./AnswerCards";
import { isLiveInteractiveCardLanguage, LiveInteractiveCard } from "./LiveInteractiveCards";
import { inlineText, parseRichText, textDirection, type Inline, type RichBlock } from "./rich-text";

function InlineText({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "bold" ? (
          <strong key={index} className="font-semibold">{part.text}</strong>
        ) : part.kind === "italic" ? (
          <em key={index}>{part.text}</em>
        ) : part.kind === "code" ? (
          <code key={index} dir="ltr" className="ai-inline-code">{part.text}</code>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

const dirOf = (...parts: Inline[][]) => textDirection(parts.map(inlineText).join(" "));

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  return (
    <figure className="ai-code-block" data-testid="message-code-block" dir="ltr">
      <figcaption className="ai-code-caption">
        <span>{language || "code"}</span>
        <button
          type="button"
          className="ai-code-copy"
          aria-label="نسخ الكود"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied("done");
            } catch {
              setCopied("failed");
            }
            window.setTimeout(() => setCopied("idle"), 1800);
          }}
        >
          {copied === "done" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          <span dir="rtl">{copied === "done" ? "نُسخ" : copied === "failed" ? "تعذّر النسخ" : "نسخ"}</span>
        </button>
      </figcaption>
      <pre tabIndex={0} aria-label={`كود ${language}`.trim()}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function Lines({ lines }: { lines: Inline[][] }) {
  return (
    <>
      {lines.map((line, index) => (
        <span key={index}>
          <InlineText parts={line} />
          {index < lines.length - 1 && <br />}
        </span>
      ))}
    </>
  );
}

/** DINAR's own heading mark (replaces emoji): a small gold diamond. */
function HeadingMark() {
  return (
    <svg className="ai-rich-mark" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M6 .8 11.2 6 6 11.2.8 6Z" fill="currentColor" opacity=".22" />
      <path d="M6 3.2 8.8 6 6 8.8 3.2 6Z" fill="currentColor" />
    </svg>
  );
}

function Block({ block }: { block: RichBlock }) {
  switch (block.kind) {
    case "code":
      {
        if (isLiveInteractiveCardLanguage(block.language)) {
          return <LiveInteractiveCard language={block.language} code={block.code} />;
        }
        const card = detectAnswerCardLanguage(block.language, block.code);
        if (card) return <AnswerCard language={card} code={block.code} />;
      }
      return <CodeBlock language={block.language} code={block.code} />;
    case "heading":
      return block.level === 3 ? (
        <h3 dir={dirOf(block.inline)} className="ai-rich-heading"><HeadingMark /><InlineText parts={block.inline} /></h3>
      ) : (
        <h4 dir={dirOf(block.inline)} className="ai-rich-subheading"><HeadingMark /><InlineText parts={block.inline} /></h4>
      );
    case "list": {
      const items = block.items.map((item, index) => <li key={index}><InlineText parts={item} /></li>);
      const dir = dirOf(...block.items);
      return block.ordered ? <ol dir={dir} className="ai-rich-list ai-rich-ordered">{items}</ol> : <ul dir={dir} className="ai-rich-list">{items}</ul>;
    }
    case "table":
      return (
        <div className="ai-rich-table" role="region" aria-label="جدول" tabIndex={0} dir={dirOf(...block.header)}>
          <table>
            <thead>
              <tr>{block.header.map((cell, index) => <th key={index} dir={dirOf(cell)}><InlineText parts={cell} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, index) => <td key={index} dir={dirOf(cell)}><InlineText parts={cell} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "quote":
      return <blockquote dir={dirOf(...block.lines)} className="ai-rich-quote"><Lines lines={block.lines} /></blockquote>;
    case "rule":
      return <hr className="ai-rich-rule" />;
    case "paragraph":
      return <p dir={dirOf(...block.lines)}><Lines lines={block.lines} /></p>;
  }
}

/** An assistant answer with readable structure; text is never interpreted as HTML. */
export function RichText({ body }: { body: string }) {
  return (
    <div className="ai-rich-text" data-testid="rich-text">
      {parseRichText(body).map((block, index) => <Block key={index} block={block} />)}
    </div>
  );
}
