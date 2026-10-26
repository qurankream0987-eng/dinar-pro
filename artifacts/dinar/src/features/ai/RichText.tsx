import { useState } from "react";
import { Check, Copy } from "lucide-react";
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

function Block({ block }: { block: RichBlock }) {
  switch (block.kind) {
    case "code":
      return <CodeBlock language={block.language} code={block.code} />;
    case "heading":
      return block.level === 3 ? (
        <h3 dir={dirOf(block.inline)} className="ai-rich-heading"><InlineText parts={block.inline} /></h3>
      ) : (
        <h4 dir={dirOf(block.inline)} className="ai-rich-subheading"><InlineText parts={block.inline} /></h4>
      );
    case "list": {
      // One direction for the whole list keeps every marker on the same side.
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
