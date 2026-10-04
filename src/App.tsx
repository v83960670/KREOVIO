import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TrendCoreWebGL from './TrendCoreWebGL';
import AuthPanel from './auth-panel';
import { ApiError, STAGE_LABELS, api, formatAge, streamSearch, type Account } from './api';
import { LiveModal, LiveTrendCard, LiveUniverse, palette, type LiveReport, type LiveTrend } from './live-report';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Crosshair,
  Globe2,
  LockKeyhole,
  Menu,
  Radio,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';

const COUNTRIES = [
  { value: 'WORLDWIDE', label: 'Worldwide' },
  { value: 'IN', label: 'India' },
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'CA', label: 'Canada' },
  { value: 'AU', label: 'Australia' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'BR', label: 'Brazil' },
  { value: 'JP', label: 'Japan' },
  { value: 'KR', label: 'South Korea' },
  { value: 'ID', label: 'Indonesia' },
];

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'bn', label: 'Bengali' },
  { value: 'es', label: 'Spanish' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
];

const SOURCES = [
  { value: 'all', label: 'All sources' },
  { value: 'search', label: 'Search interest' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'reddit', label: 'Reddit' },
  { value: 'news', label: 'News' },
  { value: 'wikipedia', label: 'Wikipedia attention' },
  { value: 'hackernews', label: 'Hacker News' },
];

const TIME_WINDOWS = [
  { value: '6h', label: 'Past 6 hours' },
  { value: '24h', label: 'Past 24 hours' },
  { value: '3d', label: 'Past 3 days' },
  { value: '7d', label: 'Past 7 days' },
  { value: '30d', label: 'Past 30 days' },
  { value: '90d', label: 'Past 90 days' },
];

type Connector = { id: string; name: string; status: string; note: string; liveStatus?: string; lastSuccessAt?: string | null; latestSignalAt?: string | null };
type ApiStatus = { mode: string; liveSearchEnabled: boolean; connectors: Connector[]; message: string; persistence?: string };
type Plan = { id: string; name: string; price: number; searches: number | null; unit: string; description: string; featured?: boolean };
type Pricing = { currency: string; configured: boolean; billingTermsConfigured?: boolean; plans: Plan[]; note: string };
type Trend = {
  id: string;
  rank: number;
  earlySignal?: boolean;
  name: string;
  score: number;
  confidence: number;
  lifecycle: string;
  category: string;
  momentum: string;
  geography: string;
  saturation: string;
  detected: string;
  description: string;
  related: string[];
  color: string;
  curve: number[];
};

const SAMPLE_TRENDS: Trend[] = [
  {
    id: 'ai-shopping-agents', rank: 1, earlySignal: true, name: 'AI shopping agents', score: 91, confidence: 84,
    lifecycle: 'Accelerating', category: 'COMMERCE / AI', momentum: '+182%', geography: 'India · example only',
    saturation: 'Low–medium', detected: '8h ago · sample',
    description: 'An illustrative topic cluster showing how autonomous assistants could compare products, hold preferences and complete parts of the shopping journey.',
    related: ['Agentic commerce', 'AI product discovery', 'Browser agents'], color: '#b19aff', curve: [14, 16, 18, 21, 19, 26, 30, 35, 42, 48, 56, 72, 91],
  },
  {
    id: 'open-source-voice-models', rank: 2, name: 'Open-source voice models', score: 78, confidence: 72,
    lifecycle: 'Rising', category: 'CREATOR TOOLS / AI', momentum: '+96%', geography: 'Worldwide · example only',
    saturation: 'Medium', detected: '1d ago · sample',
    description: 'A sample report topic for exploring how local-first speech tools and open model releases might be grouped into one monitored theme.',
    related: ['Local AI audio', 'Speech cloning safeguards', 'Real-time translation'], color: '#86ded1', curve: [14, 18, 16, 20, 24, 23, 29, 31, 37, 41, 47, 57, 78],
  },
  {
    id: 'quiet-luxury-skincare', rank: 3, name: 'Quiet luxury skincare', score: 73, confidence: 68,
    lifecycle: 'Emerging', category: 'BEAUTY / CULTURE', momentum: '+64%', geography: 'United Kingdom · example only',
    saturation: 'Medium', detected: '2d ago · sample',
    description: 'An example theme used to demonstrate topic clustering, lifecycle labels and evidence disclosure across a consumer category.',
    related: ['Barrier-first routines', 'Dermatologist-led beauty', 'Fragrance-free formulas'], color: '#f2bd8c', curve: [14, 15, 16, 16, 19, 20, 22, 27, 28, 34, 42, 49, 73],
  },
];

const SCORE_PARTS = [
  { name: 'Growth velocity', value: 30, desc: 'Movement relative to a robust historical baseline.' },
  { name: 'Cross-source confirmation', value: 20, desc: 'Independent source agreement, weighted by quality.' },
  { name: 'Acceleration', value: 15, desc: 'Whether growth itself is speeding up.' },
  { name: 'Freshness', value: 15, desc: 'How recently this acceleration episode began.' },
  { name: 'Saturation opportunity', value: 10, desc: 'Signal strength relative to observed coverage.' },
  { name: 'Geographic strength', value: 10, desc: 'Evidence of movement in the selected market.' },
];

function Brand({ compact = false }: { compact?: boolean }) {
  const markGradientId = compact ? 'kreovio-mark-footer-gradient' : 'kreovio-mark-header-gradient';
  return (
    <a className={`brand${compact ? ' brand-compact' : ''}`} href="#top" aria-label="Kreovio home">
      <svg className="brand-mark" viewBox="0 0 42 42" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={markGradientId} x1="6" y1="34" x2="36" y2="8" gradientUnits="userSpaceOnUse">
            <stop stopColor="#83ded2" />
            <stop offset=".52" stopColor="#a895ff" />
            <stop offset="1" stopColor="#e2b7fb" />
          </linearGradient>
        </defs>
        <path d="M8 29.5c5.8-.3 8.3-5.8 12.7-11.3 3.6-4.5 7.1-6.6 13.3-6.7" stroke={`url(#${markGradientId})`} strokeWidth="2.1" strokeLinecap="round" />
        <path d="M8 22.7c4.1-.2 6.2-3.3 9.2-7.1 3.1-3.9 6.6-6.6 11-7.9" stroke={`url(#${markGradientId})`} strokeOpacity=".56" strokeWidth="1.35" strokeLinecap="round" />
        <path d="M8 35c8.4-.4 12.4-6.5 17.4-12.6 4.1-5 7-6.8 10.6-7.1" stroke={`url(#${markGradientId})`} strokeOpacity=".28" strokeWidth="1.15" strokeLinecap="round" />
        <circle cx="34.4" cy="11.5" r="2.35" fill="#d8b6ff" />
        <circle cx="8" cy="29.5" r="2" fill="#86ded2" />
      </svg>
      <span className="brand-word">kreovio<span className="brand-period">.</span></span>
      {!compact && <span className="brand-divider" aria-hidden="true" />}
      {!compact && <span className="brand-product">TREND INTELLIGENCE</span>}
    </a>
  );
}

function TrendCore() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const particles = useMemo(() => {
    const count = 210;
    return Array.from({ length: count }, (_, index) => {
      const y = 1 - (index / (count - 1)) * 2;
      const radius = Math.sqrt(1 - y * y);
      const theta = Math.PI * (3 - Math.sqrt(5)) * index;
      return {
        x: Math.cos(theta) * radius,
        y,
        z: Math.sin(theta) * radius,
        radius: 1.1 + ((index * 37) % 10) / 10,
        glow: index % 17 === 0 || index % 29 === 0,
      };
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    const ctx = context;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let raf = 0;
    let disposed = false;
    let tick = 0;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.65);
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (reducedMotion) draw();
    };

    const draw = () => {
      if (disposed || canvas.parentElement?.classList.contains('has-webgl')) return;
      ctx.clearRect(0, 0, width, height);
      if (!width || !height) return;
      const time = reducedMotion ? 0 : tick;
      const cx = width * 0.5;
      const cy = height * 0.51;
      const radius = Math.min(width, height) * 0.365;
      const rotateY = time * 0.0002 + pointer.current.x * 0.2;
      const rotateX = -0.19 + pointer.current.y * 0.12;
      const cosY = Math.cos(rotateY);
      const sinY = Math.sin(rotateY);
      const cosX = Math.cos(rotateX);
      const sinX = Math.sin(rotateX);

      const aura = ctx.createRadialGradient(cx, cy, radius * 0.12, cx, cy, radius * 1.48);
      aura.addColorStop(0, 'rgba(142, 105, 224, .21)');
      aura.addColorStop(0.42, 'rgba(70, 118, 169, .09)');
      aura.addColorStop(1, 'rgba(9, 12, 20, 0)');
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, width, height);

      // Three fine orbits create depth without blocking the evidence-first content around them.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.globalCompositeOperation = 'screen';
      for (let ring = 0; ring < 3; ring += 1) {
        ctx.save();
        ctx.rotate((-0.24 + ring * 0.46) + pointer.current.x * 0.08);
        ctx.scale(1, 0.26 + ring * 0.045);
        ctx.beginPath();
        ctx.ellipse(0, 0, radius * (1.04 + ring * 0.11), radius * (1.04 + ring * 0.11), 0, 0, Math.PI * 2);
        ctx.strokeStyle = ring === 1 ? 'rgba(193, 176, 255, .24)' : 'rgba(146, 175, 224, .11)';
        ctx.lineWidth = ring === 1 ? 0.85 : 0.6;
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();

      const projected = particles.map((point, index) => {
        const x1 = point.x * cosY + point.z * sinY;
        const z1 = point.z * cosY - point.x * sinY;
        const y2 = point.y * cosX - z1 * sinX;
        const z2 = point.y * sinX + z1 * cosX;
        const perspective = 1 + z2 * 0.12;
        const x = cx + x1 * radius * perspective;
        const y = cy + y2 * radius * perspective;
        const signalPulse = point.glow ? (reducedMotion ? 0.5 : 0.5 + Math.sin(time * 0.002 + index) * 0.25) : 0;
        return { x, y, z: z2, r: point.radius * perspective * (1 + signalPulse * 0.72), signalPulse, glow: point.glow };
      });

      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < projected.length; i += 1) {
        const a = projected[i];
        if (a.z < -0.28) continue;
        for (let j = i + 1; j < Math.min(i + 12, projected.length); j += 1) {
          const b = projected[j];
          if (b.z < -0.15) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distance = Math.hypot(dx, dy);
          if (distance < radius * 0.17) {
            const alpha = (1 - distance / (radius * 0.17)) * Math.min(a.z + 0.6, b.z + 0.6) * 0.11;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(159, 174, 235, ${Math.max(0, alpha)})`;
            ctx.lineWidth = 0.55;
            ctx.stroke();
          }
        }
      }

      const core = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.32, radius * 0.05, cx, cy, radius * 0.92);
      core.addColorStop(0, 'rgba(99, 123, 179, .08)');
      core.addColorStop(0.53, 'rgba(43, 50, 89, .16)');
      core.addColorStop(0.83, 'rgba(47, 40, 78, .1)');
      core.addColorStop(1, 'rgba(19, 22, 37, .01)');
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.91, 0, Math.PI * 2);
      ctx.fillStyle = core;
      ctx.fill();

      for (const point of projected) {
        if (point.z < -0.26) continue;
        const depth = Math.max(0.12, (point.z + 1) / 2);
        const alpha = Math.min(0.92, 0.14 + depth * 0.58 + point.signalPulse * 0.27);
        ctx.beginPath();
        ctx.arc(point.x, point.y, Math.max(0.55, point.r * (0.62 + depth * 0.33)), 0, Math.PI * 2);
        ctx.fillStyle = point.glow ? `rgba(203, 192, 255, ${alpha})` : `rgba(132, 189, 211, ${alpha * 0.76})`;
        ctx.fill();
        if (point.glow && depth > 0.35) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, point.r * 3.4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(181, 157, 255, ${alpha * 0.075})`;
          ctx.fill();
        }
      }

      // The brighter nodes are a visual metaphor, not measured live topics.
      const pulseAngle = time * 0.00017;
      const signalNodes = [0.1, 1.4, 2.7, 3.8, 5.1];
      for (let index = 0; index < signalNodes.length; index += 1) {
        const angle = signalNodes[index] + pulseAngle * (index % 2 ? -1 : 1);
        const orbitScale = index % 2 ? 1.03 : 0.78;
        const x = cx + Math.cos(angle) * radius * orbitScale;
        const y = cy + Math.sin(angle) * radius * orbitScale * 0.34;
        const pulse = reducedMotion ? 1 : 0.76 + Math.sin(time * 0.003 + index) * 0.19;
        ctx.beginPath();
        ctx.arc(x, y, 3.1 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = index % 2 ? 'rgba(177, 154, 255, .92)' : 'rgba(131, 222, 210, .9)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 8 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = index % 2 ? 'rgba(177, 154, 255, .12)' : 'rgba(131, 222, 210, .1)';
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      if (!reducedMotion) {
        tick += 16;
        raf = window.requestAnimationFrame(draw);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      pointer.current = {
        x: ((event.clientX - bounds.left) / bounds.width - 0.5) * 2,
        y: ((event.clientY - bounds.top) / bounds.height - 0.5) * 2,
      };
    };
    const resetPointer = () => { pointer.current = { x: 0, y: 0 }; };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    canvas.addEventListener('pointermove', onPointerMove, { passive: true });
    canvas.addEventListener('pointerleave', resetPointer, { passive: true });
    resize();
    if (!reducedMotion) raf = window.requestAnimationFrame(draw);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', resetPointer);
    };
  }, [particles]);

  return (
    <div className="core-stage" role="img" aria-label="Illustrative three-dimensional signal visualization. No live data is connected in this preview.">
      <div className="core-stage-grid" aria-hidden="true" />
      <div className="core-ring-glow" aria-hidden="true" />
      <canvas className="trend-core-canvas" ref={canvasRef} aria-hidden="true" />
      <TrendCoreWebGL />
      <div className="core-center-mark" aria-hidden="true"><span /><span /><span /></div>
      <div className="core-label core-label-search"><span className="core-label-dot aqua" /> Search <span className="core-label-state">SIGNAL</span></div>
      <div className="core-label core-label-creator"><span className="core-label-dot violet" /> Creator activity</div>
      <div className="core-label core-label-news"><span className="core-label-dot peach" /> News</div>
      <div className="core-annotation"><span className="annotation-line" /> A visual metaphor, not live activity</div>
      <div className="core-stage-index"><span>01</span> / SIGNAL SPACE</div>
    </div>
  );
}

function MiniCurve({ values, color, wide = false }: { values: number[]; color: string; wide?: boolean }) {
  const width = wide ? 560 : 120;
  const height = wide ? 150 : 42;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - 8 - ((value - min) / Math.max(1, max - min)) * (height - 20);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = points.split(' ').at(-1)?.split(',') ?? [String(width), String(height / 2)];
  const gradientId = `curve-${color.replace(/[^a-z0-9]/gi, '')}-${wide ? 'wide' : 'mini'}`;
  return (
    <svg className={`mini-curve${wide ? ' mini-curve-wide' : ''}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Illustrative trend curve, not observed data">
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".22" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={`M ${points.replaceAll(' ', ' L ')} L ${width} ${height} L 0 ${height} Z`} fill={`url(#${gradientId})`} />
      <polyline points={points} fill="none" stroke={color} strokeWidth={wide ? 2 : 1.7} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={wide ? 4 : 2.8} fill={color} />
      {wide && <line x1={width * 0.62} x2={width * 0.62} y1="5" y2={height - 4} stroke="rgba(255,255,255,.23)" strokeDasharray="3 5" />}
    </svg>
  );
}

function TrendCard({ trend, onOpen, isSaved, onSave }: { trend: Trend; onOpen: () => void; isSaved: boolean; onSave: () => void }) {
  return (
    <article className="trend-card" style={{ '--trend-color': trend.color } as React.CSSProperties}>
      <div className="trend-card-top">
        <span className="sample-chip"><span /> SAMPLE</span>
        <button className={`icon-button save-button${isSaved ? ' is-saved' : ''}`} onClick={onSave} aria-label={isSaved ? `Remove ${trend.name} from saved examples` : `Save ${trend.name} example`} title={isSaved ? 'Remove saved example' : 'Save example'}>
          {isSaved ? <Check size={16} /> : <Bookmark size={16} />}
        </button>
      </div>
      <div className="trend-card-category"><span>RANK 0{trend.rank}</span><i />{trend.category}</div>
      <button className="trend-card-title" onClick={onOpen}>{trend.name}<ArrowUpRight size={17} aria-hidden="true" /></button>
      <div className="trend-card-status"><span className={`lifecycle-indicator ${trend.lifecycle.toLowerCase()}`} />{trend.lifecycle}<span className="status-divider" />{trend.detected}{trend.earlySignal && <span className="early-signal-chip" title="Sample label only. In live data, Early Signal requires recent acceleration, independent evidence, strong confidence and low saturation." aria-label="Illustrative Early Signal label. No live evidence is attached."><i /> EARLY SIGNAL <em>sample</em></span>}</div>
      <div className="trend-card-chart"><MiniCurve values={trend.curve} color={trend.color} /></div>
      <div className="trend-card-metrics">
        <div><span className="metric-label">SAMPLE SCORE</span><strong>{trend.score}<span className="score-out-of">/100</span></strong></div>
        <div><span className="metric-label">SAMPLE CONFIDENCE</span><strong>{trend.confidence}<span className="score-out-of">%</span></strong></div>
        <div><span className="metric-label">SATURATION</span><strong className="metric-saturation">{trend.saturation}</strong></div>
      </div>
      <div className="trend-card-footer">
        <span><TrendingUp size={14} /> {trend.momentum} <i>sample</i></span>
        <button className="text-link" onClick={onOpen}>Inspect example <ArrowRight size={14} /></button>
      </div>
    </article>
  );
}

function Universe({ trends, onOpen }: { trends: Trend[]; onOpen: (trend: Trend) => void }) {
  const positions = [
    { left: '50%', top: '47%', scale: 1.14 },
    { left: '29%', top: '32%', scale: 0.94 },
    { left: '73%', top: '69%', scale: 0.84 },
  ];
  return (
    <div className="universe-view" aria-label="Sample trend constellation. These nodes are illustrative, not live signals.">
      <div className="universe-stars" aria-hidden="true" />
      <svg className="universe-links" viewBox="0 0 900 420" preserveAspectRatio="none" aria-hidden="true">
        <path d="M450 196 C385 145 340 125 260 134" />
        <path d="M452 202 C535 255 592 279 660 292" />
        <path d="M265 134 C395 116 520 139 660 292" />
        <circle cx="450" cy="196" r="4" /><circle cx="260" cy="134" r="3" /><circle cx="660" cy="292" r="3" />
      </svg>
      <div className="universe-axis-label universe-axis-x">SEMANTIC RELATIONSHIP →</div>
      <div className="universe-axis-label universe-axis-y">ILLUSTRATIVE SIGNAL MAGNITUDE</div>
      <div className="universe-center-label"><span className="universe-core-pulse" /> SAMPLE CONSTELLATION</div>
      {trends.map((trend, index) => (
        <button
          key={trend.id}
          className={`universe-node${index === 0 ? ' universe-node-major' : ''}`}
          style={{ left: positions[index].left, top: positions[index].top, '--node-color': trend.color, '--node-scale': positions[index].scale } as React.CSSProperties}
          onClick={() => onOpen(trend)}
          aria-label={`Open illustrative sample node: ${trend.name}`}
        >
          <span className="universe-node-halo" /><span className="universe-node-orb" />
          <span className="universe-node-name">{trend.name}</span>
          <span className="universe-node-kind">SAMPLE · {trend.lifecycle.toUpperCase()}</span>
        </button>
      ))}
      <div className="universe-legend"><span><i className="legend-orb" /> Lifecycle color</span><span><i className="legend-link" /> Related topics</span></div>
    </div>
  );
}

function TrendModal({ trend, onClose }: { trend: Trend; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.trend-modal');
      const focusable = [...(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleKey);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', handleKey); document.body.classList.remove('modal-open'); };
  }, [onClose]);

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="trend-modal" role="dialog" aria-modal="true" aria-labelledby="trend-modal-title">
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close trend details"><X size={18} /></button>
        <div className="modal-eyebrow"><span className="sample-chip"><span /> ILLUSTRATIVE EXAMPLE</span><span className="modal-category">{trend.category}</span></div>
        <h2 id="trend-modal-title">{trend.name}</h2>
        <p className="modal-lede">{trend.description}</p>
        <div className="modal-warning"><CircleHelp size={17} /><span>Sample interface only. No live source evidence, market measurements or references are attached to this example.</span></div>
        <div className="modal-number-grid">
          <div><span>SAMPLE TREND SCORE</span><strong>{trend.score}<small>/100</small></strong><em>Illustrative only</em></div>
          <div><span>SAMPLE CONFIDENCE</span><strong>{trend.confidence}<small>%</small></strong><em>Not calibrated</em></div>
          <div><span>EXAMPLE LIFECYCLE</span><strong className="modal-lifecycle">{trend.lifecycle}</strong><em>Would update with snapshots</em></div>
        </div>
        <div className="modal-section-head"><div><span className="eyebrow">MOMENTUM / SAMPLE</span><h3>A curve is not evidence.</h3></div><span className="sample-only-note">Illustrative curve</span></div>
        <div className="modal-chart-wrap"><MiniCurve values={trend.curve} color={trend.color} wide /><div className="modal-chart-foot"><span>FIRST OBSERVATION · NOT AVAILABLE</span><span>LATEST OBSERVATION · NOT AVAILABLE</span></div></div>
        <div className="modal-grid-lower">
          <div className="modal-evidence-box"><span className="eyebrow">SOURCE EVIDENCE</span><p>No providers are connected in this preview.</p><span className="evidence-placeholder"><LockKeyhole size={13} /> Source references appear here after authorized data collection.</span></div>
          <div className="modal-evidence-box"><span className="eyebrow">RELATED TOPICS / SAMPLE</span><div className="related-topics">{trend.related.map((topic) => <span key={topic}>{topic}</span>)}</div></div>
        </div>
        <div className="modal-footnote"><ShieldCheck size={15} /> No virality prediction. Scores, confidence and geography in this view are placeholders.</div>
      </section>
    </div>
  );
}

function SelectField({ label, value, options, onChange, icon: Icon }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; icon: typeof Globe2 }) {
  return (
    <label className="filter-field">
      <span className="filter-field-label">{label}</span>
      <span className="filter-control"><Icon size={15} aria-hidden="true" /><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></span>
    </label>
  );
}

function App() {
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('WORLDWIDE');
  const [language, setLanguage] = useState('en');
  const [source, setSource] = useState('all');
  const [windowId, setWindowId] = useState('24h');
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [currency, setCurrency] = useState('INR');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchMessage, setSearchMessage] = useState('');
  const [searchError, setSearchError] = useState(false);
  const [reportVisible, setReportVisible] = useState(false);
  const [reportView, setReportView] = useState<'list' | 'universe'>('list');
  const [activeTrend, setActiveTrend] = useState<Trend | null>(null);
  const [savedExamples, setSavedExamples] = useState<string[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [liveReport, setLiveReport] = useState<LiveReport | null>(null);
  const [activeLive, setActiveLive] = useState<LiveTrend | null>(null);
  const [stages, setStages] = useState<string[]>([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [menuStatusOpen, setMenuStatusOpen] = useState(false);
  const finderRef = useRef<HTMLElement>(null);
  const reportRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/status').then((response) => response.json()).then((data: ApiStatus) => setStatus(data)).catch(() => {
      setStatus({ mode: 'analysis', liveSearchEnabled: false, connectors: [], message: 'The analysis API is unavailable. A search was not run and nothing was charged.' });
    });
    api<Account>('/api/auth/me').then(setAccount).catch(() => setAccount({ authenticated: false }));
  }, []);

  useEffect(() => {
    fetch(`/api/pricing?currency=${encodeURIComponent(currency)}`).then((response) => response.json()).then((data: Pricing) => setPricing(data)).catch(() => {
      setPricing(null);
    });
  }, [currency]);

  useEffect(() => {
    if (!activeTrend) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => document.querySelector<HTMLElement>('.modal-close')?.focus(), 10);
    return () => { window.clearTimeout(timer); previous?.focus(); };
  }, [activeTrend]);

  const scrollToFinder = useCallback((focusInput = false) => {
    finderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (focusInput) window.setTimeout(() => searchInputRef.current?.focus(), 550);
    setMobileMenuOpen(false);
  }, []);

  const loadExample = useCallback(() => {
    setReportVisible(true);
    setSearchMessage('');
    setSearchError(false);
    setMobileMenuOpen(false);
    window.setTimeout(() => reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }, []);

  const submitSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanQuery = query.trim();
    if (cleanQuery.length < 2) {
      setSearchError(true);
      setSearchMessage('Add a topic or niche before scanning.');
      searchInputRef.current?.focus();
      return;
    }
    if (!account?.authenticated || !account.csrf) {
      setSearchError(true);
      setSearchMessage('Sign in with a verified account before scanning. Nothing was charged.');
      return;
    }
    if (!account.emailVerified) {
      setSearchError(true);
      setSearchMessage('Verify the account before the free search can be reserved. Nothing was charged.');
      return;
    }
    setIsSubmitting(true);
    setStages([]);
    setSearchMessage('');
    setSearchError(false);
    try {
      const report = await streamSearch({ query: cleanQuery, country, language, source, timeWindow: windowId }, account.csrf, (name, data) => {
        if (name === 'source_completed') {
          const sourceId = String(data.id ?? 'source');
          const sourceStatus = String(data.status ?? '').replaceAll('_', ' ').toLowerCase();
          setStages((current) => [...current, `${sourceId}: ${sourceStatus}`]);
          return;
        }
        const label = STAGE_LABELS[name];
        if (label) setStages((current) => current.includes(label) ? current : [...current, label]);
      });
      if (!report) throw new ApiError('The search ended without a report. Nothing was charged if collection failed.', 500);
      setLiveReport(report as LiveReport);
      setSearchError(report.charged === false);
      setSearchMessage(`${String(report.message ?? 'Analysis complete.')}${report.charged ? ' One credit was committed.' : ' Your search was not charged.'}`);
      const me = await api<Account>('/api/auth/me');
      setAccount(me);
      window.setTimeout(() => reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    } catch (reason) {
      setSearchError(true);
      setSearchMessage(reason instanceof ApiError ? `${reason.message} Nothing was charged unless a report was completed.` : 'Signal interrupted. Nothing was charged.');
      api<Account>('/api/auth/me').then(setAccount).catch(() => undefined);
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleSaved = (trendId: string) => {
    setSavedExamples((current) => current.includes(trendId) ? current.filter((id) => id !== trendId) : [...current, trendId]);
  };
  const closeTrend = useCallback(() => setActiveTrend(null), []);

  const currencyOptions = [
    { value: 'INR', label: 'INR · India' },
    { value: 'USD', label: 'USD · United States' },
    { value: 'EUR', label: 'EUR · Europe' },
    { value: 'GBP', label: 'GBP · United Kingdom' },
    { value: 'CAD', label: 'CAD · Canada' },
    { value: 'AUD', label: 'AUD · Australia' },
  ];

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header" id="top">
        <div className="header-inner">
          <Brand />
          <nav className={`main-nav${mobileMenuOpen ? ' main-nav-open' : ''}`} aria-label="Main navigation">
            <a href="#finder" onClick={(event) => { event.preventDefault(); scrollToFinder(true); }}>Trend Finder</a>
            <a href="#method">Methodology</a>
            <a href="#pricing">Pricing</a>
            <button className="mobile-nav-cta" onClick={() => scrollToFinder(true)}>Start exploring <ArrowRight size={15} /></button>
          </nav>
          <div className="header-actions">
            <button className={`network-pill${menuStatusOpen ? ' network-pill-open' : ''}`} onClick={() => setMenuStatusOpen((open) => !open)} aria-expanded={menuStatusOpen} aria-controls="network-status-panel">
              <span className="network-pill-light" /><span>{status?.liveSearchEnabled ? 'Sources mixed' : 'Sources unavailable'}</span><ChevronDown size={13} />
            </button>
            <button className="header-cta" onClick={() => scrollToFinder(true)}>Explore <ArrowUpRight size={15} /></button>
            <button className="mobile-menu-toggle icon-button" aria-label={mobileMenuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)}>{mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}</button>
          </div>
        </div>
        {menuStatusOpen && (
          <div className="network-popover" id="network-status-panel">
            <div className="popover-header"><span className="status-dot muted" /> CONNECTOR STATUS <button className="icon-button" onClick={() => setMenuStatusOpen(false)} aria-label="Close connector status"><X size={15} /></button></div>
            <p>{status?.message ?? 'Checking source readiness…'}</p>
            <div className="popover-connectors">{(status?.connectors ?? []).map((connector) => <span key={connector.id}><i />{connector.name}<em>{connector.liveStatus ?? connector.status}</em></span>)}</div>
            <a href="#trust" onClick={() => setMenuStatusOpen(false)}>Read the data policy <ArrowRight size={13} /></a>
          </div>
        )}
      </header>

      <main id="main">
        <section className="hero-section" aria-labelledby="hero-title">
          <div className="hero-backdrop" aria-hidden="true"><div className="hero-aurora" /><div className="hero-grid-lines" /></div>
          <div className="hero-layout page-shell">
            <div className="hero-copy">
              <div className="eyebrow hero-eyebrow"><span className="eyebrow-signal"><span /></span> INTERNET TREND INTELLIGENCE <span className="eyebrow-index">/ 01</span></div>
              <h1 id="hero-title">See what’s<br />rising <span>before</span><br />everyone else.</h1>
              <p className="hero-subtitle">Near-live trend intelligence for people who need to know what the internet is paying attention to — with the freshness of every source shown.</p>
              <p className="hero-detail">Find the early movement. Understand why it’s moving. See the evidence behind every signal.</p>
              <div className="hero-actions">
                <button className="button button-primary" onClick={() => scrollToFinder(true)}>Find my first trend <ArrowRight size={17} /></button>
                <button className="button button-quiet" onClick={loadExample}><span className="play-icon"><ArrowDown size={15} /></span> Explore a sample report</button>
              </div>
              <div className="hero-assurance"><span><Check size={13} /> 1 complete search free</span><i /> No card required <i /> Evidence, not hype</div>
            </div>
            <div className="hero-visual-column">
              <TrendCore />
              <div className="hero-visual-caption"><span className="caption-symbol"><Activity size={14} /></span><span>THE TREND CORE<small>A visual language for signal movement</small></span><span className="caption-tail">PREVIEW</span></div>
            </div>
          </div>
          <div className="hero-bottom page-shell"><span>BUILT FOR EARLY DISCOVERY</span><span className="hero-bottom-line" /><span>NOT ANOTHER TREND LIST</span><a href="#finder">Explore the engine <ArrowDown size={14} /></a></div>
        </section>

        <section className="signal-strip" aria-label="Kreovio principles"><div className="signal-strip-inner page-shell"><span><Crosshair size={15} /> Detect the turn</span><i /> <span><Activity size={15} /> Measure momentum</span><i /> <span><ShieldCheck size={15} /> Inspect the evidence</span><i /> <span><Globe2 size={15} /> See where it moves</span></div></section>

        <section className="finder-section section-shell" id="finder" ref={finderRef} aria-labelledby="finder-title">
          <div className="section-heading finder-heading">
            <div><div className="eyebrow"><span className="section-index">01</span> THE TREND FINDER</div><h2 id="finder-title">Start with a question.<br /><span>Leave with a signal.</span></h2></div>
            <div className="section-heading-aside"><span className="engine-status"><span className="status-dot muted" /> {status?.persistence === 'pglite' ? 'LOCAL POSTGRES' : status?.persistence === 'postgres' ? 'POSTGRES' : 'CHECKING STORAGE'}</span><p>{status?.message ?? 'Source status is loaded from the server. Missing credentials stay missing. Failed scans are not charged.'}</p></div>
          </div>

          <div className="finder-layout">
            <form className="search-console" onSubmit={submitSearch} noValidate>
              <div className="console-topline"><span><Radio size={14} /> INTELLIGENCE ENGINE</span><span className="console-mode">{status?.liveSearchEnabled ? 'FRESHNESS SHOWN' : 'SOURCES LIMITED'} <i /></span></div>
              <label className="query-label" htmlFor="trend-query">What do you want to explore?</label>
              <div className={`query-input-wrap${searchError && !query.trim() ? ' input-error' : ''}`}>
                <Search size={21} aria-hidden="true" />
                <input id="trend-query" ref={searchInputRef} type="text" maxLength={100} placeholder="A topic, niche or question…" value={query} onChange={(event) => { setQuery(event.target.value); if (searchMessage) setSearchMessage(''); }} aria-describedby="query-help search-feedback" />
                <kbd>↵</kbd>
              </div>
              <p className="query-examples" id="query-help">Try <button type="button" onClick={() => setQuery('Artificial intelligence')}>Artificial intelligence</button><i /> <button type="button" onClick={() => setQuery('Creator economy')}>Creator economy</button><i /> <button type="button" onClick={() => setQuery('Sustainable fashion')}>Sustainable fashion</button></p>
              <div className="filter-divider"><span>REFINE YOUR SIGNAL</span><SlidersHorizontal size={14} /></div>
              <div className="filter-grid">
                <SelectField label="COUNTRY / REGION" value={country} options={COUNTRIES} onChange={setCountry} icon={Globe2} />
                <SelectField label="LANGUAGE" value={language} options={LANGUAGES} onChange={setLanguage} icon={ChevronRight} />
                <SelectField label="SOURCES" value={source} options={SOURCES} onChange={setSource} icon={Radio} />
                <SelectField label="TIME WINDOW" value={windowId} options={TIME_WINDOWS} onChange={setWindowId} icon={Clock3} />
              </div>
              <div className="console-actions">
                <button className="button button-primary scan-button" type="submit" disabled={isSubmitting}><span className="scan-button-icon">{isSubmitting ? <span className="button-pulse" /> : <Sparkles size={17} />}</span>{isSubmitting ? 'Collecting signals…' : 'Scan for emerging trends'}<ArrowRight size={17} /></button>
                <span className="scan-cost"><LockKeyhole size={13} /> One search · one complete analysis</span>
              </div>
              {stages.length > 0 && <ol className="search-stages" aria-label="Search progress">{stages.map((stage) => <li key={stage}>{stage}</li>)}</ol>}
              <div id="search-feedback" className={`search-feedback${searchMessage ? ' is-visible' : ''}${searchError ? ' feedback-error' : ' feedback-info'}`} aria-live="polite" role={searchError ? 'alert' : 'status'}>
                {searchMessage && <><span className="feedback-symbol">{searchError ? <CircleHelp size={15} /> : <Activity size={15} />}</span><span>{searchMessage}</span>{searchError && <span className="not-charged">NOT CHARGED</span>}</>}
              </div>
              <div className="console-footnote"><span><ShieldCheck size={14} /> Failed searches consume zero credits.</span><button type="button" onClick={() => document.getElementById('trust')?.scrollIntoView({ behavior: 'smooth' })}>How we handle evidence <ArrowUpRight size={13} /></button></div>
            </form>

            <aside className="finder-aside">
              <div className="free-search-card"><div className="free-search-icon"><Zap size={17} /></div><span className="eyebrow">YOUR FIRST SIGNAL</span><strong>One real search.<br /><em>No card required.</em></strong><p>A verified account receives one Trend Search. The balance is stored on the server. Opening a finished report does not spend another credit.</p><div className="free-search-bottom"><span><span className="status-dot" /> {account?.authenticated ? `${account.creditsAvailable ?? 0} AVAILABLE` : 'SIGN IN TO RESERVE'}</span><span>01 / 01</span></div></div>
              <AuthPanel account={account} onChange={setAccount} />
              <div className="sample-prompt-card"><span className="eyebrow">WANT TO SEE THE EXPERIENCE?</span><p>Explore an annotated sample report. Every number is clearly marked as illustrative.</p><button onClick={loadExample}>Open sample report <ArrowRight size={15} /></button></div>
            </aside>
          </div>
        </section>

        {liveReport && (
          <section className="report-section section-shell" id="report" ref={reportRef} aria-labelledby="live-report-title">
            <div className="report-section-top"><div><div className="eyebrow"><span className="section-index">02</span> TREND REPORT</div><h2 id="live-report-title">{liveReport.results.length ? <>What is moving in <span>{liveReport.query}.</span></> : <>No strong acceleration <span>detected yet.</span></>}</h2></div><button className="icon-button report-close" onClick={() => setLiveReport(null)} aria-label="Close report"><X size={17} /></button></div>
            <div className="freshness-bar">
              <span>Analysis {formatAge(liveReport.analysisCompletedAt)}</span>
              <span>Latest signal {liveReport.latestSignalAt ? formatAge(liveReport.latestSignalAt) : 'unavailable'}</span>
              <span>{liveReport.charged ? '1 credit committed' : '0 credits committed'}</span>
              <span>{liveReport.stats ? `${liveReport.stats.signalsCollected} signals · ${liveReport.stats.duplicatesRemoved} duplicates removed` : 'No collection stats'}</span>
            </div>
            <div className="source-freshness-row">{liveReport.sourceFreshness.map((source) => <div key={source.id}><strong>{source.name}</strong><em>{source.liveStatus}</em><small>{source.status.replaceAll('_', ' ')} · {formatAge(source.lastSuccessAt ?? source.latestSignalAt)}</small></div>)}</div>
            {liveReport.message && <div className="report-demo-notice"><div className="demo-notice-icon"><CircleHelp size={17} /></div><div><strong>{liveReport.code === 'INSUFFICIENT_EVIDENCE' ? 'Search could not be completed.' : 'Analysis note'}</strong><p>{liveReport.message}</p>{!!liveReport.warnings?.length && <ul className="why-list">{liveReport.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}</div></div>}
            {liveReport.results.length > 0 && (
              <>
                <div className="report-toolbar"><div><span className="report-query-icon"><Search size={14} /></span><strong>{liveReport.query}</strong><span className="report-filters">{liveReport.country} <i /> {liveReport.language} <i /> {liveReport.timeWindow}</span></div><div className="report-toolbar-actions"><div className="view-toggle" role="group" aria-label="Report view"><button className={reportView === 'list' ? 'active' : ''} onClick={() => setReportView('list')} aria-pressed={reportView === 'list'}>List</button><button className={reportView === 'universe' ? 'active' : ''} onClick={() => setReportView('universe')} aria-pressed={reportView === 'universe'}>Universe</button></div></div></div>
                {reportView === 'list' ? <div className="trend-card-grid">{liveReport.results.map((trend, index) => <LiveTrendCard key={trend.trendId} trend={trend} color={palette(index)} onOpen={() => setActiveLive(trend)} />)}</div> : <LiveUniverse trends={liveReport.results} onOpen={setActiveLive} />}
              </>
            )}
            {liveReport.topicAssessment && (
              <div className="topic-assessment"><span className="eyebrow">QUERY TOPIC · NOT RANKED AS EARLY</span><h3>{liveReport.topicAssessment.name}</h3><p>{liveReport.topicAssessment.explanation?.text}</p><span>Lifecycle {String(liveReport.topicAssessment.lifecycle).toUpperCase()} · score {liveReport.topicAssessment.score ?? 'withheld'}</span></div>
            )}
            {!!liveReport.observations?.length && (
              <div className="observation-list"><span className="eyebrow">OBSERVED, NOT SCORED</span>{liveReport.observations.map((item) => <p key={item.name}><strong>{item.name}</strong> — {item.reason}</p>)}</div>
            )}
          </section>
        )}

        {reportVisible && (
          <section className="report-section section-shell" id="report" ref={reportRef} aria-labelledby="report-title">
            <div className="report-section-top"><div><div className="eyebrow"><span className="section-index">02</span> REPORT PREVIEW</div><h2 id="report-title">A report you can <span>inspect.</span></h2></div><button className="icon-button report-close" onClick={() => setReportVisible(false)} aria-label="Close sample report"><X size={17} /></button></div>
            <div className="report-demo-notice"><div className="demo-notice-icon"><CircleHelp size={17} /></div><div><strong>Illustrative sample — not live market intelligence.</strong><p>Scores, confidence, lifecycle labels, trend curves and geographies below are fabricated UI examples only. No current sources were queried; no evidence or references are attached.</p></div><span className="sample-chip"><span /> SAMPLE DATA</span></div>
            <div className="report-toolbar"><div><span className="report-query-icon"><Search size={14} /></span><strong>Example: internet signals</strong><span className="report-filters">Sample topics <i /> illustrative metrics <i /> no live evidence</span></div><div className="report-toolbar-actions"><span className="report-meta"><span className="status-dot muted" /> EXAMPLE ONLY</span><div className="view-toggle" role="group" aria-label="Report view"><button className={reportView === 'list' ? 'active' : ''} onClick={() => setReportView('list')} aria-pressed={reportView === 'list'}><span className="list-view-glyph" /> List</button><button className={reportView === 'universe' ? 'active' : ''} onClick={() => setReportView('universe')} aria-pressed={reportView === 'universe'}><span className="universe-view-glyph" /> Universe</button></div></div></div>
            <div className="report-count-line"><span>EXAMPLE REPORT <b>—</b> 3 illustrative concepts</span><span>Historical baseline <em>not available</em></span></div>
            {reportView === 'list' ? (
              <div className="trend-card-grid">{SAMPLE_TRENDS.map((trend) => <TrendCard key={trend.id} trend={trend} onOpen={() => setActiveTrend(trend)} isSaved={savedExamples.includes(trend.id)} onSave={() => toggleSaved(trend.id)} />)}</div>
            ) : <Universe trends={SAMPLE_TRENDS} onOpen={setActiveTrend} />}
            <div className="report-bottom-note"><span><ShieldCheck size={15} /> Evidence links and historic measurements are intentionally absent from this preview.</span><button onClick={() => { setReportVisible(false); scrollToFinder(true); }}>Start a live search when available <ArrowRight size={14} /></button></div>
          </section>
        )}

        <section className="method-section section-shell" id="method" aria-labelledby="method-title">
          <div className="method-heading">
            <div><div className="eyebrow"><span className="section-index">03</span> THE KREOVIO TREND SCORE™</div><h2 id="method-title">A score is only useful<br />when you can <span>see how it’s made.</span></h2></div>
            <p>Kreovio’s trend score is an algorithmic composite—not an LLM’s opinion. Confidence stays separate, so a fast-moving signal with thin evidence is never presented as certainty.</p>
          </div>
          <div className="method-content">
            <div className="score-visual-card"><div className="score-visual-top"><span><span className="score-pulse" /> KTS-1.0 · SCORING MODEL</span><span>WEIGHTS / CONFIGURABLE</span></div><div className="score-visual-center"><div className="score-orbit" aria-hidden="true"><div /><div /><div /></div><div className="score-visual-number">—<span>/100</span></div><span className="score-visual-label">TREND SCORE</span></div><div className="score-visual-foot"><span>WITHHELD UNTIL EVIDENCE IS SUFFICIENT</span><span><CircleHelp size={13} /> Coverage threshold applies</span></div></div>
            <div className="score-breakdown">{SCORE_PARTS.map((part, index) => <div className="score-part" key={part.name}><div className="score-part-top"><span className="score-part-index">0{index + 1}</span><strong>{part.name}</strong><span className="score-part-weight">{part.value}<small> pts</small></span></div><div className="score-part-track"><span style={{ width: `${part.value * 2.65}%` }} /></div><p>{part.desc}</p></div>)}</div>
          </div>
          <div className="method-principles"><div><span>01</span><strong>Baseline first</strong><p>Compare attention with category history, not just yesterday’s count.</p></div><div><span>02</span><strong>Deduplicate stories</strong><p>A copied headline should not become a chorus of independent sources.</p></div><div><span>03</span><strong>Know what’s missing</strong><p>Thin history or failed sources lower confidence—or withhold the result.</p></div></div>
        </section>

        <section className="trust-section section-shell" id="trust" aria-labelledby="trust-title">
          <div className="trust-heading"><div><div className="eyebrow"><span className="section-index">04</span> TRUST IS THE INTERFACE</div><h2 id="trust-title">No black boxes.<br /><span>No pretend certainty.</span></h2></div><p>Every trend should earn its place. If the underlying data can’t support a useful answer, Kreovio should say so plainly.</p></div>
          <div className="trust-grid">
            <article className="trust-card"><span className="trust-number">01</span><div className="trust-icon"><Radio size={19} /></div><h3>Sources stay visible.</h3><p>Each result is designed to show its provider, timestamp, signal type and reference—so a user can inspect the reason, not just the conclusion.</p><span className="trust-card-foot"><LockKeyhole size={13} /> STATUS COMES FROM THE SERVER</span></article>
            <article className="trust-card"><span className="trust-number">02</span><div className="trust-icon trust-icon-purple"><Activity size={19} /></div><h3>Momentum isn’t popularity.</h3><p>Velocity, acceleration and lifecycle are measured against historical attention. A large number alone isn’t an early signal.</p><span className="trust-card-foot"><Check size={13} /> ALGORITHMIC SCORING</span></article>
            <article className="trust-card"><span className="trust-number">03</span><div className="trust-icon trust-icon-peach"><ShieldCheck size={19} /></div><h3>Evidence before explanation.</h3><p>AI may summarize what sources show. It does not invent metrics, choose a score or fill gaps in the record.</p><span className="trust-card-foot"><Check size={13} /> EVIDENCE-GROUNDED BY DESIGN</span></article>
          </div>
          <div className="source-readiness"><div className="source-readiness-title"><span className="eyebrow">SOURCE READINESS</span><span className="source-readiness-note"><span className="status-dot muted" /> From the server</span></div><div className="source-readiness-grid">{(status?.connectors ?? [
            { id: 'search', name: 'Search interest', status: 'NOT_CONFIGURED', liveStatus: 'NOT CONFIGURED', note: 'Waiting for a licensed search-trend key.' },
            { id: 'youtube', name: 'YouTube', status: 'NOT_CONFIGURED', liveStatus: 'NOT CONFIGURED', note: 'Waiting for an official API key.' },
            { id: 'reddit', name: 'Reddit', status: 'NOT_CONFIGURED', liveStatus: 'NOT CONFIGURED', note: 'Waiting for approved OAuth credentials.' },
            { id: 'news', name: 'News', status: 'UNAVAILABLE', liveStatus: 'UNAVAILABLE', note: 'Status loads after the API responds.' },
          ]).map((connector) => <div className="source-readiness-item" key={connector.id}><span className="source-ready-icon"><Radio size={15} /></span><span><strong>{connector.name}</strong><small>{connector.note}</small></span><span className="source-disconnected">{connector.liveStatus ?? connector.status.replaceAll('_', ' ')}</span></div>)}</div></div>
        </section>

        <section className="pricing-section section-shell" id="pricing" aria-labelledby="pricing-title">
          <div className="pricing-heading"><div><div className="eyebrow"><span className="section-index">05</span> SIMPLE BY DESIGN</div><h2 id="pricing-title">Start small.<br /><span>Keep your edge.</span></h2></div><div className="pricing-region"><label htmlFor="pricing-currency">REGION & CURRENCY</label><span className="pricing-select-wrap"><Globe2 size={15} /><select id="pricing-currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>{currencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={13} /></span></div></div>
          {pricing?.configured ? (
            <>
              <div className="pricing-cadence-note"><CircleHelp size={15} /><span>{pricing.note} Prices below are configuration previews—not a checkout quote.</span></div>
              <div className="pricing-grid">{pricing.plans.map((plan) => <article className={`pricing-card${plan.featured ? ' pricing-featured' : ''}`} key={plan.id}>
                {plan.featured && <span className="pricing-featured-label">MOST POPULAR</span>}
                <div className="pricing-card-top"><span>{plan.name.toUpperCase()}</span>{plan.id === 'free' ? <span className="plan-icon"><Zap size={15} /></span> : <span className="plan-icon"><Activity size={15} /></span>}</div>
                <div className="pricing-amount"><span className="currency-mark">₹</span>{plan.price}<small>{plan.id === 'free' ? '' : 'INR'}</small></div>
                <div className="pricing-allowance">{plan.searches === null ? 'Fair-use unlimited' : `${plan.searches} ${plan.searches === 1 ? 'search' : 'searches'}`}</div>
                <p>{plan.description}</p>
                <div className="pricing-rule" />
                <div className="pricing-features"><span><Check size={14} /> Complete trend reports</span><span><Check size={14} /> Transparent evidence</span><span><Check size={14} /> Saved trend history</span></div>
                <button className={plan.featured ? 'pricing-button pricing-button-featured' : 'pricing-button'} disabled>{plan.id === 'free' ? 'Preview only' : 'Checkout not configured'}{plan.id !== 'free' && <LockKeyhole size={13} />}</button>
              </article>)}</div>
              <div className="pricing-terms"><span><LockKeyhole size={14} /> Checkout is disabled in this preview. No payments are collected.</span><span>UPI · Cards · PayPal <em>planned, not connected</em></span></div>
            </>
          ) : (
            <div className="regional-price-empty"><div className="regional-price-icon"><Globe2 size={20} /></div><div><strong>Regional pricing not configured yet.</strong><p>{pricing?.note ?? 'Choose a supported currency to see its configured price.'} Kreovio won’t convert the India price into an arbitrary local amount.</p></div><span className="regional-price-code">{currency}</span></div>
          )}
        </section>

        <section className="closing-section"><div className="closing-orbit" aria-hidden="true"><span /><span /><span /></div><div className="closing-content"><span className="eyebrow"><span className="eyebrow-signal"><span /></span> SOMETHING IS MOVING</span><h2>See it while<br /><span>it’s still becoming.</span></h2><p>One clear question can open a new line of sight.</p><button className="button button-primary" onClick={() => scrollToFinder(true)}>Find my first trend <ArrowRight size={17} /></button><small>Freshness is shown per source. Missing credentials are not filled with estimates.</small></div></section>
      </main>

      <footer className="site-footer"><div className="footer-main page-shell"><Brand compact /><p>See what’s rising before everyone else.</p><nav aria-label="Footer navigation"><a href="#method">Methodology</a><a href="#trust">Data & trust</a><a href="#pricing">Pricing</a></nav><span className="footer-build">PREVIEW BUILD · 2026</span></div><div className="footer-bottom page-shell"><span>© 2026 Kreovio. Built for early discovery.</span><span>Evidence over hype <i /> Signal over noise</span></div></footer>
      {activeTrend && <TrendModal trend={activeTrend} onClose={closeTrend} />}
      {activeLive && <LiveModal trend={activeLive} onClose={() => setActiveLive(null)} />}
    </>
  );
}

export default App;
