import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { SurfaceSection } from "@workspace/api-zod/surface-composition";

/**
 * Data primitives of the shared card vocabulary: a semantic table and a recorded-points chart.
 * They display the validated section exactly: a missing cell reads «غير متوفر» (never zero),
 * sorting reorders a copy, and the chart draws only the given points. Every chart also carries
 * the same figures as an accessible table, so the numbers never depend on the drawing.
 */
type Table = Omit<Extract<SurfaceSection, { type: "table" }>, "type">;
type Series = Omit<Extract<SurfaceSection, { type: "series" }>, "type">;

export const UNAVAILABLE = "غير متوفر";

export function DataTable({ label, caption, columns, rows, source }: Table) {
  const [sort, setSort] = useState<{ column: number; direction: "asc" | "desc" }>();
  const ordered = useMemo(() => {
    if (!sort) return rows;
    const factor = sort.direction === "asc" ? 1 : -1;
    // Rows without a sortable value keep their place at the end, in source order.
    return [...rows].sort((a, b) => {
      const left = a.cells[sort.column]?.sort;
      const right = b.cells[sort.column]?.sort;
      if (left === undefined && right === undefined) return 0;
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return (left - right) * factor;
    });
  }, [rows, sort]);
  if (!rows.length) return <p className="ds-text ds-muted" data-testid="ds-table-empty">لا توجد صفوف لعرضها.</p>;
  return (
    <figure className="ds-table-wrap" data-testid="ds-table">
      <div className="ds-table-scroll" role="region" aria-label={label} tabIndex={0}>
        <table className="ds-table">
          <caption className={caption ? "ds-table-caption" : "sr-only"}>{caption ?? label}</caption>
          <thead>
            <tr>
              {columns.map((column, index) => {
                const active = sort?.column === index;
                const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
                return (
                  <th key={column.key} scope="col" data-kind={column.kind} aria-sort={column.sortable ? ariaSort : undefined}>
                    {column.sortable ? (
                      <button
                        type="button"
                        className="ds-table-sort"
                        data-testid={`ds-sort-${column.key}`}
                        onClick={() => setSort(active && sort.direction === "asc" ? { column: index, direction: "desc" } : { column: index, direction: "asc" })}
                      >
                        <span>{column.label}</span>
                        {active ? (sort.direction === "asc" ? <ArrowUp size={13} aria-hidden /> : <ArrowDown size={13} aria-hidden />) : <ArrowUpDown size={13} aria-hidden />}
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => (
              <tr key={row.key} data-row={row.key}>
                {row.cells.map((cell, index) => {
                  const kind = columns[index]?.kind ?? "TEXT";
                  const content = cell.display === null
                    ? <span className="ds-table-missing">{UNAVAILABLE}</span>
                    : kind === "TEXT" ? <span dir="auto">{cell.display}</span> : <bdi dir="ltr">{cell.display}</bdi>;
                  return index === 0
                    ? <th key={index} scope="row" data-kind={kind}>{content}</th>
                    : <td key={index} data-kind={kind}>{content}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {source && <figcaption className="ds-text ds-muted">المصدر: {source}</figcaption>}
    </figure>
  );
}

const SeriesDrawing = lazy(() => import("./SeriesDrawing"));

/** A drawing that fails (or a browser without SVG support) leaves the figures table in place. */
class DrawingBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

export function SeriesChart({ kind, label, unit, period, source, points }: Series) {
  const summary = kind === "LINE"
    ? `${label}: ${points.length} نقاط من ${points[0]!.label} إلى ${points.at(-1)!.label}`
    : `${label}: توزيع على ${points.length} أجزاء`;
  return (
    <figure className="ds-series" data-testid={`ds-series-${kind.toLowerCase()}`} data-kind={kind} aria-label={summary}>
      <figcaption className="ds-series-head">
        <span className="ds-series-title">{label}</span>
        {(period || unit) && <span className="ds-text ds-muted">{[period, unit].filter(Boolean).join(" · ")}</span>}
      </figcaption>
      <div className="ds-series-canvas" aria-hidden>
        <DrawingBoundary>
          <Suspense fallback={<div className="ds-series-loading" data-testid="ds-series-loading" />}>
            <SeriesDrawing kind={kind} points={points} />
          </Suspense>
        </DrawingBoundary>
      </div>
      <details className="ds-series-data">
        <summary>الأرقام</summary>
        <table className="ds-table" data-testid="ds-series-table">
          <caption className="sr-only">{summary}</caption>
          <tbody>
            {points.map((point, index) => (
              <tr key={index}>
                <th scope="row" dir="auto">{point.label}</th>
                <td><bdi dir="ltr">{point.display}</bdi></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {source && <p className="ds-text ds-muted">المصدر: {source}</p>}
    </figure>
  );
}
