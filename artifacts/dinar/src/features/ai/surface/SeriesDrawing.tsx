import { CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * The drawing half of SeriesChart, loaded only when a chart is on screen (recharts stays out of
 * the chat bundle). Points are drawn as given: no interpolation across gaps, no added points,
 * no animation when the reader asked for reduced motion. The exact figures live in the
 * accessible table beside the drawing; this layer is decorative for assistive technology.
 */
type Point = { label: string; value: number; display: string };

const TONES = ["var(--ds-chart-1)", "var(--ds-chart-2)", "var(--ds-chart-3)", "var(--ds-chart-4)", "var(--ds-chart-5)", "var(--ds-chart-6)"];
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function Tip({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="ds-series-tip" dir="rtl">
      <span dir="auto">{point.label}</span>
      <bdi dir="ltr">{point.display}</bdi>
    </div>
  );
}

export default function SeriesDrawing({ kind, points }: { kind: "LINE" | "DONUT"; points: Point[] }) {
  const animate = !reducedMotion();
  if (kind === "DONUT") {
    return (
      <div className="ds-donut">
        <ResponsiveContainer width="100%" height={180}>
          <PieChart>
            <Pie data={points} dataKey="value" nameKey="label" innerRadius="58%" outerRadius="90%" paddingAngle={1} isAnimationActive={animate} stroke="none">
              {points.map((_, index) => <Cell key={index} fill={TONES[index % TONES.length]} />)}
            </Pie>
            <Tooltip content={<Tip />} />
          </PieChart>
        </ResponsiveContainer>
        <ul className="ds-legend">
          {points.map((point, index) => (
            <li key={index}>
              <span className="ds-legend-swatch" style={{ background: TONES[index % TONES.length] }} />
              <span dir="auto" className="min-w-0 truncate">{point.label}</span>
              <bdi dir="ltr" className="tabular-nums">{point.display}</bdi>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={200}>
      {/* Time runs right-to-left in an Arabic reading order. */}
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
        <CartesianGrid stroke="var(--ds-chart-grid)" vertical={false} />
        <XAxis dataKey="label" reversed tick={{ fontSize: 11, fill: "var(--ds-chart-axis)" }} interval="preserveStartEnd" minTickGap={12} tickLine={false} />
        <YAxis orientation="right" width={44} tick={{ fontSize: 11, fill: "var(--ds-chart-axis)" }} tickFormatter={(value: number) => compact.format(value)} tickLine={false} axisLine={false} />
        <Tooltip content={<Tip />} />
        <Line type="linear" dataKey="value" stroke="var(--ds-chart-1)" strokeWidth={2.25} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={animate} />
      </LineChart>
    </ResponsiveContainer>
  );
}
