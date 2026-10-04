import { useEffect } from 'react';
import { ArrowUpRight, ShieldCheck, X } from 'lucide-react';
import { formatAge } from './api';

export type Evidence = {
  source: string;
  title: string;
  publisher?: string | null;
  metric?: string | null;
  value?: number | null;
  unit?: string | null;
  timestamp?: string | null;
  collectedAt?: string | null;
  reference?: string | null;
  note?: string | null;
};

export type LiveTrend = {
  trendId: string;
  episodeId?: string | null;
  rank?: number;
  name: string;
  aliases?: string[];
  score: number | null;
  scoreStatus?: string;
  scoreCoverage?: number | null;
  scoreVersion?: string;
  confidence: number | null;
  confidenceLabel?: string | null;
  lifecycle: string;
  earlySignal?: boolean;
  earlySignalReason?: string;
  velocity?: number | null;
  acceleration?: number | null;
  accelerationStatus?: string;
  freshness?: string;
  saturationState?: string;
  geographicAvailable?: boolean;
  regions?: { country: string; label: string; strength: number; rank?: number; method?: string }[];
  firstDetectedAt?: string | null;
  latestAt?: string | null;
  calculatedAt?: string | null;
  sources?: string[];
  sourceNames?: string[];
  explanation?: { text?: string };
  why?: string[];
  curve?: { t: string; value: number; metric: string }[];
  evidence?: Evidence[];
  limitations?: string[];
  related?: string[];
  current?: number | null;
  baseline?: number | null;
  unit?: string;
  provenance?: Record<string, { value: number | null; weight: number; contribution: number | null; status: string }>;
};

export type SourceFreshness = {
  id: string;
  name: string;
  status: string;
  liveStatus: string;
  lastSuccessAt?: string | null;
  latestSignalAt?: string | null;
  note?: string;
  limitations?: string[];
};

export type LiveReport = {
  id: string;
  query: string;
  country: string;
  language: string;
  timeWindow: string;
  charged: boolean;
  message?: string | null;
  code?: string;
  results: LiveTrend[];
  observations?: { name: string; evidenceCount: number; reason: string; evidence?: Evidence[] }[];
  topicAssessment?: LiveTrend | null;
  sourceFreshness: SourceFreshness[];
  analysisCompletedAt?: string;
  latestSignalAt?: string | null;
  dataFreshness?: { minSeconds: number | null; maxSeconds: number | null };
  stats?: { signalsCollected: number; duplicatesRemoved: number; clusters: number; qualified: number };
  warnings?: string[];
  algorithmVersion?: string;
};

const PALETTE = ['#b19aff', '#86ded1', '#f2bd8c', '#9eb6ff', '#e2b7fb', '#8fd0a8'];

function ObservedCurve({ values, color }: { values: { t: string; value: number }[]; color: string }) {
  if (values.length < 2) return <p className="curve-unavailable">Historical curve unavailable.</p>;
  const width = 120;
  const height = 42;
  const nums = values.map((point) => point.value);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const points = values.map((point, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - 8 - ((point.value - min) / Math.max(1, max - min)) * (height - 20);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="mini-curve" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Observed historical series">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LiveTrendCard({ trend, color, onOpen }: { trend: LiveTrend; color: string; onOpen: () => void }) {
  return (
    <article className="trend-card live-trend-card" style={{ '--trend-color': color } as React.CSSProperties}>
      <div className="trend-card-top">
        <span className="live-chip">{trend.score == null ? 'SCORE WITHHELD' : trend.scoreVersion ?? 'KTS-1.0'}</span>
        {trend.earlySignal && <span className="early-signal-chip"><i /> EARLY SIGNAL</span>}
      </div>
      <div className="trend-card-category"><span>{trend.rank ? `RANK ${String(trend.rank).padStart(2, '0')}` : 'MEASURED'}</span><i />{(trend.sourceNames ?? trend.sources ?? []).join(' · ') || 'SOURCE'}</div>
      <button className="trend-card-title" onClick={onOpen}>{trend.name}<ArrowUpRight size={17} aria-hidden="true" /></button>
      <div className="trend-card-status"><span className={`lifecycle-indicator ${String(trend.lifecycle).toLowerCase()}`} />{String(trend.lifecycle).toUpperCase()}<span className="status-divider" />{trend.freshness ?? 'FRESHNESS UNAVAILABLE'}</div>
      <div className="trend-card-chart">{trend.curve && trend.curve.length > 1 ? <ObservedCurve values={trend.curve} color={color} /> : <p className="curve-unavailable">No stored curve for this window.</p>}</div>
      <div className="trend-card-metrics">
        <div><span className="metric-label">TREND SCORE</span><strong>{trend.score == null ? '—' : trend.score}<span className="score-out-of">{trend.score == null ? '' : '/100'}</span></strong></div>
        <div><span className="metric-label">CONFIDENCE</span><strong>{trend.confidence == null ? '—' : trend.confidence}<span className="score-out-of">{trend.confidence == null ? '' : '%'}</span></strong></div>
        <div><span className="metric-label">SATURATION</span><strong className="metric-saturation">{trend.saturationState ?? 'INSUFFICIENT EVIDENCE'}</strong></div>
      </div>
      <div className="trend-card-footer">
        <span>{trend.accelerationStatus === 'unavailable' ? 'Acceleration unavailable' : `Acceleration ${trend.acceleration}`}</span>
        <button className="text-link" onClick={onOpen}>Inspect evidence <ArrowUpRight size={14} /></button>
      </div>
    </article>
  );
}

export function LiveUniverse({ trends, onOpen }: { trends: LiveTrend[]; onOpen: (trend: LiveTrend) => void }) {
  const magnitudes = trends.map((trend) => trend.curve?.at(-1)?.value ?? trend.evidence?.length ?? 1);
  const max = Math.max(...magnitudes, 1);
  return (
    <div className="universe-view" aria-label="Measured trend constellation. Node size uses observed series magnitude.">
      <div className="universe-stars" aria-hidden="true" />
      <div className="universe-axis-label universe-axis-x">RELATED ONLY WHEN EVIDENCE OVERLAPS</div>
      {trends.map((trend, index) => {
        const angle = (index / Math.max(trends.length, 1)) * Math.PI * 2 - Math.PI / 2;
        const radius = 28 + (index % 3) * 6;
        const left = 50 + Math.cos(angle) * radius;
        const top = 48 + Math.sin(angle) * radius * 0.72;
        const scale = 0.72 + (magnitudes[index] / max) * 0.5;
        return (
          <button
            key={trend.trendId}
            className="universe-node"
            style={{ left: `${left}%`, top: `${top}%`, '--node-color': PALETTE[index % PALETTE.length], '--node-scale': scale } as React.CSSProperties}
            onClick={() => onOpen(trend)}
            aria-label={`Open measured trend ${trend.name}`}
          >
            <span className="universe-node-halo" /><span className="universe-node-orb" />
            <span className="universe-node-name">{trend.name}</span>
            <span className="universe-node-kind">{String(trend.lifecycle).toUpperCase()} · {trend.score == null ? 'SCORE WITHHELD' : trend.score}</span>
          </button>
        );
      })}
    </div>
  );
}

export function LiveModal({ trend, onClose }: { trend: LiveTrend; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
  }, [onClose]);
  return (
    <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="trend-modal" role="dialog" aria-modal="true" aria-labelledby="live-trend-title">
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close trend details"><X size={18} /></button>
        <div className="modal-eyebrow"><span className="live-chip">MEASURED</span><span className="modal-category">{(trend.sourceNames ?? []).join(' · ')}</span></div>
        <h2 id="live-trend-title">{trend.name}</h2>
        <p className="modal-lede">{trend.explanation?.text || trend.why?.join(' ') || 'No grounded explanation was produced.'}</p>
        <div className="modal-number-grid">
          <div><span>TREND SCORE</span><strong>{trend.score == null ? '—' : trend.score}{trend.score != null && <small>/100</small>}</strong><em>{trend.score == null ? 'Trend Score unavailable — insufficient evidence.' : `${trend.scoreVersion} · coverage ${Math.round((trend.scoreCoverage ?? 0) * 100)}%`}</em></div>
          <div><span>CONFIDENCE</span><strong>{trend.confidence == null ? '—' : trend.confidence}{trend.confidence != null && <small>%</small>}</strong><em>{trend.confidenceLabel ?? 'unavailable'}</em></div>
          <div><span>LIFECYCLE</span><strong className="modal-lifecycle">{String(trend.lifecycle).toUpperCase()}</strong><em>{trend.freshness ?? 'Episode freshness unavailable'}</em></div>
        </div>
        <div className="live-facts">
          <span>Velocity {trend.velocity == null ? 'unavailable' : trend.velocity}</span>
          <span>Acceleration {trend.acceleration == null ? 'unavailable' : trend.acceleration}</span>
          <span>Baseline {trend.baseline == null ? 'unavailable' : `${trend.baseline} ${trend.unit ?? ''}`}</span>
          <span>Current {trend.current == null ? 'unavailable' : `${trend.current} ${trend.unit ?? ''}`}</span>
          <span>First detected {trend.firstDetectedAt ? formatAge(trend.firstDetectedAt) : 'unavailable'}</span>
          <span>Calculated {formatAge(trend.calculatedAt)}</span>
        </div>
        <div className="modal-section-head"><div><span className="eyebrow">WHY THIS CLASSIFICATION</span><h3>Evidence, not a prediction.</h3></div></div>
        <ul className="why-list">{(trend.why ?? []).map((line) => <li key={line}>{line}</li>)}</ul>
        {trend.provenance && (
          <div className="provenance-grid">
            {Object.entries(trend.provenance).map(([name, part]) => (
              <div key={name}><span>{name}</span><strong>{part.status === 'unavailable' ? 'Unavailable' : part.contribution}</strong><small>{part.weight} pts</small></div>
            ))}
          </div>
        )}
        <div className="modal-grid-lower">
          <div className="modal-evidence-box">
            <span className="eyebrow">SOURCE EVIDENCE</span>
            <ul className="evidence-list">
              {(trend.evidence ?? []).map((item, index) => (
                <li key={`${item.reference ?? item.title}-${index}`}>
                  <strong>{item.title}</strong>
                  <span>{item.source}{item.publisher ? ` · ${item.publisher}` : ''}{item.value != null ? ` · ${item.value} ${item.unit ?? item.metric ?? ''}` : ''}</span>
                  <span>{item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Timestamp unavailable'}</span>
                  {item.reference && <a href={item.reference} target="_blank" rel="noreferrer">Open reference</a>}
                </li>
              ))}
              {!trend.evidence?.length && <li>No inspectable references were returned for this result.</li>}
            </ul>
          </div>
          <div className="modal-evidence-box">
            <span className="eyebrow">GEOGRAPHY</span>
            {trend.geographicAvailable && trend.regions?.length ? trend.regions.map((region) => (
              <p key={region.country}>{region.label} — rank {region.rank ?? 'n/a'} · strength {region.strength}. Method: {region.method ?? 'observed'}.</p>
            )) : <p>Geographic strength unavailable.</p>}
            <span className="eyebrow">LIMITATIONS</span>
            {(trend.limitations ?? []).map((line) => <p key={line}>{line}</p>)}
            <p>{trend.earlySignalReason}</p>
          </div>
        </div>
        <div className="modal-footnote"><ShieldCheck size={15} /> No virality prediction. Missing dimensions were withheld, not converted to zero.</div>
      </section>
    </div>
  );
}

export function palette(index: number) {
  return PALETTE[index % PALETTE.length];
}
