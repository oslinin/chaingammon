import React from "react";

// ─── Board state ──────────────────────────────────────────────────────────────
const OPENING = [
  -2,  0,  0,  0,  0, +5,
   0, +3,  0,  0,  0, -5,
  +5,  0,  0,  0, -3,  0,
  -5,  0,  0,  0,  0, +2,
];

// ─── Types ────────────────────────────────────────────────────────────────────
interface StageTheme {
  frame: string; frameEdge: string; felt: string;
  pointA: string; pointB: string;
  checker1: string; checker2: string; checkerBorder: string;
  pointNumber: string; bar: string;
}

interface StageData {
  id: string; eraNum: string; era: string; period: string; locale: string;
  name: string; epithet: string; role: string; signature: string;
  accent: string;
  Scene: () => React.JSX.Element;
  Med: () => React.JSX.Element;
  theme: StageTheme;
}

// ─── Board primitives ─────────────────────────────────────────────────────────
function Checker({ theme, side, size = 16 }: { theme: StageTheme; side: string; size?: number }) {
  const fill = side === "+" ? theme.checker1 : theme.checker2;
  return (
    <span style={{
      display: "inline-block", width: size, height: size, borderRadius: 999, flexShrink: 0,
      background: `radial-gradient(circle at 35% 30%, color-mix(in srgb, ${fill} 55%, white) 0%, ${fill} 38%, color-mix(in srgb, ${fill} 88%, black) 78%, color-mix(in srgb, ${fill} 62%, black) 100%)`,
      border: `1px solid ${theme.checkerBorder}`,
    }} />
  );
}

function Stack({ count, theme, flip, size }: { count: number; theme: StageTheme; flip: boolean; size: number }) {
  if (count === 0) return null;
  const side = count > 0 ? "+" : "−";
  const fill = side === "+" ? theme.checker1 : theme.checker2;
  const n = Math.abs(count);
  const visible = Math.min(n, 5);
  const overflow = n - visible;
  const OVERLAP = -Math.round(size * 0.45);
  return (
    <div style={{ display: "flex", alignItems: "center", flexDirection: flip ? "column-reverse" : "column", paddingTop: flip ? 0 : 3, paddingBottom: flip ? 3 : 0 }}>
      {Array.from({ length: visible }).map((_, i) => (
        <span key={i} style={{ display: "block", marginTop: flip ? 0 : (i === 0 ? 0 : OVERLAP), marginBottom: flip ? (i === 0 ? 0 : OVERLAP) : 0 }}>
          <Checker theme={theme} side={side} size={size} />
        </span>
      ))}
      {overflow > 0 && (
        <span style={{ marginTop: flip ? 0 : 2, marginBottom: flip ? 2 : 0, fontFamily: "var(--cg-font-mono)", fontSize: 8, fontWeight: 700, color: theme.checkerBorder, background: fill, border: `1px solid ${theme.checkerBorder}`, padding: "0 3px", borderRadius: 2, lineHeight: 1.2 }}>+{overflow}</span>
      )}
    </div>
  );
}

function PointTri({ theme, count, flip, dark, size }: { theme: StageTheme; count: number; flip: boolean; dark: boolean; size: number }) {
  return (
    <div style={{ position: "relative", width: "100%", height: 100, display: "flex", flexDirection: flip ? "column-reverse" : "column", alignItems: "center" }}>
      <span style={{ position: "absolute", inset: 0, background: dark ? theme.pointA : theme.pointB, clipPath: flip ? "polygon(50% 0, 0 100%, 100% 100%)" : "polygon(50% 100%, 0 0, 100% 0)" }} />
      <div style={{ position: "relative", zIndex: 1 }}>
        <Stack count={count} theme={theme} flip={flip} size={size} />
      </div>
    </div>
  );
}

function BoardHalf({ nums, flip, theme, sz }: { nums: number[]; flip: boolean; theme: StageTheme; sz: number }) {
  return (
    <div style={{ display: "flex", background: theme.felt }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", flex: 1 }}>
        {nums.slice(0, 6).map((pt, i) => <PointTri key={pt} theme={theme} count={OPENING[pt - 1]} flip={flip} dark={(i % 2) === (flip ? 1 : 0)} size={sz} />)}
      </div>
      <div style={{ width: 14, background: theme.bar, borderLeft: `1px solid ${theme.frame}`, borderRight: `1px solid ${theme.frame}` }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", flex: 1 }}>
        {nums.slice(6).map((pt, i) => <PointTri key={pt} theme={theme} count={OPENING[pt - 1]} flip={flip} dark={((i + 1) % 2) === (flip ? 1 : 0)} size={sz} />)}
      </div>
    </div>
  );
}

function BoardRail({ nums, theme }: { nums: number[]; theme: StageTheme }) {
  return (
    <div style={{ background: theme.felt, display: "grid", gridTemplateColumns: "repeat(6, 1fr) 14px repeat(6, 1fr)", padding: "3px 0" }}>
      {nums.slice(0, 6).map(n => <span key={n} style={{ textAlign: "center", fontFamily: "var(--cg-font-mono)", fontSize: 9, color: theme.pointNumber, lineHeight: 1 }}>{n}</span>)}
      <span />
      {nums.slice(6).map(n => <span key={n} style={{ textAlign: "center", fontFamily: "var(--cg-font-mono)", fontSize: 9, color: theme.pointNumber, lineHeight: 1 }}>{n}</span>)}
    </div>
  );
}

function StageBoard({ theme, medallion }: { theme: StageTheme; medallion: React.ReactNode }) {
  const top = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const bot = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  return (
    <div style={{ background: theme.frame, border: `2px solid ${theme.frameEdge}`, borderRadius: 6, overflow: "hidden", boxShadow: "0 12px 28px -8px rgba(0,0,0,0.7), 0 4px 8px -2px rgba(0,0,0,0.5)", width: "100%" }}>
      <BoardRail nums={top} theme={theme} />
      <BoardHalf nums={top} flip={false} theme={theme} sz={15} />
      <div style={{ position: "relative", height: 44, background: theme.bar, borderTop: `2px solid ${theme.frame}`, borderBottom: `2px solid ${theme.frame}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {medallion}
      </div>
      <BoardHalf nums={bot} flip={true} theme={theme} sz={15} />
      <BoardRail nums={bot} theme={theme} />
    </div>
  );
}

// ─── Scenic backdrops ─────────────────────────────────────────────────────────

function PersianScene() {
  return (
    <svg viewBox="0 0 380 480" preserveAspectRatio="xMidYMid slice" style={{ width: "100%", height: "100%" }}>
      <defs>
        <linearGradient id="ps-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#7A2418" />
          <stop offset="38%" stopColor="#C46A2E" />
          <stop offset="65%" stopColor="#D9924A" />
          <stop offset="100%" stopColor="#7A4A28" />
        </linearGradient>
        <radialGradient id="ps-sun" cx="50%" cy="22%" r="22%">
          <stop offset="0%"   stopColor="#FBD894" />
          <stop offset="60%"  stopColor="#E89A48" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#E89A48" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="380" height="480" fill="url(#ps-sky)" />
      <circle cx="190" cy="100" r="50" fill="#FBD894" />
      <rect width="380" height="480" fill="url(#ps-sun)" />
      <path d="M0,360 Q90,330 180,346 T380,338 L380,480 L0,480 Z" fill="#6B3318" />
      <path d="M0,406 Q120,378 220,396 T380,392 L380,480 L0,480 Z" fill="#2A1208" />
      {([[20,20],[340,20],[20,440],[340,440]] as [number,number][]).map(([x,y], i) => (
        <g key={i} transform={`translate(${x},${y})`} fill="none" stroke="#E8B85A" strokeWidth="0.8" opacity="0.6">
          <path d="M0,10 L10,0 L20,10 L10,20 Z" />
          <path d="M5,10 L10,5 L15,10 L10,15 Z" />
        </g>
      ))}
    </svg>
  );
}

function RomanScene() {
  return (
    <svg viewBox="0 0 380 480" preserveAspectRatio="xMidYMid slice" style={{ width: "100%", height: "100%" }}>
      <defs>
        <linearGradient id="rs-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#3A2A38" />
          <stop offset="40%"  stopColor="#5A3A48" />
          <stop offset="100%" stopColor="#1A0E0E" />
        </linearGradient>
        <linearGradient id="rs-marble" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#E8E1CF" />
          <stop offset="50%"  stopColor="#C8BFAA" />
          <stop offset="100%" stopColor="#A89878" />
        </linearGradient>
        <linearGradient id="rs-banner" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#9A1F18" />
          <stop offset="100%" stopColor="#5A0F08" />
        </linearGradient>
      </defs>
      <rect width="380" height="480" fill="url(#rs-bg)" />
      <rect x="0" y="0" width="380" height="68" fill="url(#rs-banner)" />
      <rect x="0" y="64" width="380" height="4" fill="#1F0F18" />
      {([18, 314] as number[]).map((x, i) => (
        <g key={i}>
          <rect x={x - 6} y="80"  width="60" height="10" fill="#E8E1CF" />
          <rect x={x - 4} y="90"  width="56" height="6"  fill="#A89878" />
          <rect x={x}     y="96"  width="48" height="320" fill="url(#rs-marble)" />
          {[0,1,2,3,4,5,6].map(k => (
            <rect key={k} x={x + 4 + k * 6} y="98" width="1.5" height="316" fill="#7F7058" opacity="0.55" />
          ))}
          <rect x={x - 4} y="416" width="56" height="6"  fill="#A89878" />
          <rect x={x - 6} y="422" width="60" height="10" fill="#E8E1CF" />
        </g>
      ))}
      <rect x="0" y="432" width="380" height="48" fill="#1A0E08" />
      <rect x="0" y="432" width="380" height="1"  fill="#5A4232" />
    </svg>
  );
}

function AsianScene() {
  const blossom = (cx: number, cy: number, r: number, key: string) => (
    <g key={key} transform={`translate(${cx},${cy})`}>
      {[0, 72, 144, 216, 288].map(a => (
        <ellipse key={a} cx="0" cy={-r} rx={r * 0.7} ry={r} transform={`rotate(${a})`} fill="#F4D8DC" stroke="#A86060" strokeWidth="0.4" />
      ))}
      <circle cx="0" cy="0" r={r * 0.35} fill="#E8B85A" />
    </g>
  );
  return (
    <svg viewBox="0 0 380 480" preserveAspectRatio="xMidYMid slice" style={{ width: "100%", height: "100%" }}>
      <defs>
        <radialGradient id="as-bg" cx="50%" cy="40%" r="70%">
          <stop offset="0%"   stopColor="#3A1F22" />
          <stop offset="60%"  stopColor="#1A0E10" />
          <stop offset="100%" stopColor="#080404" />
        </radialGradient>
      </defs>
      <rect width="380" height="480" fill="url(#as-bg)" />
      <g stroke="#3A1A0E" strokeWidth="3" fill="none" strokeLinecap="round">
        <path d="M-10,90 Q60,80 130,110 T230,140" />
        <path d="M55,82  Q70,60 85,55" />
        <path d="M110,98 Q130,80 155,82" />
      </g>
      {blossom(70,  56, 7, "b1")}
      {blossom(160, 80, 6, "b2")}
      {blossom(95, 100, 5, "b3")}
      {blossom(200,138, 8, "b4")}
      <g stroke="#3A1A0E" strokeWidth="3" fill="none" strokeLinecap="round">
        <path d="M390,400 Q320,420 250,400 T160,378" />
        <path d="M280,402 Q260,422 240,432" />
      </g>
      {blossom(320, 408, 7, "b5")}
      {blossom(260, 392, 5, "b6")}
      {blossom(220, 410, 6, "b7")}
      {([[40,200,1.5],[60,260,1],[330,180,1.2],[300,300,0.9],[20,360,1]] as [number,number,number][]).map(([x,y,r], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill="#E8B85A" opacity="0.7" />
      ))}
    </svg>
  );
}

function TavernScene() {
  return (
    <svg viewBox="0 0 380 480" preserveAspectRatio="xMidYMid slice" style={{ width: "100%", height: "100%" }}>
      <defs>
        <linearGradient id="ts-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#1A0E08" />
          <stop offset="50%"  stopColor="#3A2014" />
          <stop offset="100%" stopColor="#2A1408" />
        </linearGradient>
        <radialGradient id="ts-fire" cx="20%" cy="78%" r="34%">
          <stop offset="0%"   stopColor="#E8923A" stopOpacity="0.45" />
          <stop offset="60%"  stopColor="#9A4A18" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="380" height="480" fill="url(#ts-bg)" />
      {[0, 96, 192, 288, 384].map((y, i) => (
        <g key={i}>
          <line x1="0" y1={y} x2="380" y2={y} stroke="#1A0E08" strokeWidth="2" />
          <line x1="0" y1={y + 1.5} x2="380" y2={y + 1.5} stroke="#5A3220" strokeWidth="0.5" opacity="0.6" />
        </g>
      ))}
      {([[20,8],[360,8],[20,104],[360,104],[20,200],[360,200],[20,296],[360,296],[20,392],[360,392]] as [number,number][]).map(([x,y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="3" fill="#C49830" />
          <circle cx={x - 0.6} cy={y - 0.6} r="1" fill="#F4D49A" />
        </g>
      ))}
      <rect width="380" height="480" fill="url(#ts-fire)" />
      {Array.from({ length: 32 }).map((_, i) => {
        const y = i * 15 + 4;
        const len = 60 + (i % 3) * 30;
        const x = (i * 47) % 380;
        return <line key={i} x1={x} y1={y} x2={x + len} y2={y + 1} stroke="#1A0E04" strokeWidth="0.5" opacity="0.35" />;
      })}
    </svg>
  );
}

function DecoScene() {
  return (
    <svg viewBox="0 0 380 480" preserveAspectRatio="xMidYMid slice" style={{ width: "100%", height: "100%" }}>
      <defs>
        <radialGradient id="ds-bg" cx="50%" cy="58%" r="80%">
          <stop offset="0%"   stopColor="#2A1A0E" />
          <stop offset="55%"  stopColor="#150A04" />
          <stop offset="100%" stopColor="#050302" />
        </radialGradient>
        <linearGradient id="ds-ray" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#C49830" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#C49830" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="380" height="480" fill="url(#ds-bg)" />
      {Array.from({ length: 16 }).map((_, i) => (
        <polygon key={i} transform={`translate(190 -40) rotate(${(i / 16) * 360})`} points="0,0 -8,260 8,260" fill="url(#ds-ray)" />
      ))}
      <path d="M40,30 Q190,2 340,30" stroke="#C49830" strokeWidth="1.5" fill="none" opacity="0.85" />
      <path d="M60,42 Q190,18 320,42" stroke="#C49830" strokeWidth="0.6" fill="none" opacity="0.55" />
      <g stroke="#C9BEA8" strokeWidth="1.2" fill="none" opacity="0.18" strokeLinecap="round">
        <path d="M30,460 Q40,420 28,388 Q14,360 30,330 Q44,304 26,278" />
        <path d="M44,452 Q56,418 48,394" />
      </g>
      {([[8,8,1],[372,8,-1]] as [number,number,number][]).map(([x,y,dir], i) => (
        <g key={i}>
          <polyline points={`${x},${y+30} ${x},${y} ${x+30*dir},${y}`} stroke="#C49830" strokeWidth="1" fill="none" opacity="0.7" />
          <polyline points={`${x+6*dir},${y+30} ${x+6*dir},${y+6} ${x+30*dir},${y+6}`} stroke="#C49830" strokeWidth="0.6" fill="none" opacity="0.5" />
        </g>
      ))}
    </svg>
  );
}

function NeuralScene() {
  return (
    <svg viewBox="0 0 380 480" preserveAspectRatio="xMidYMid slice" style={{ width: "100%", height: "100%" }}>
      <defs>
        <radialGradient id="ns-glow1" cx="20%" cy="20%" r="40%">
          <stop offset="0%"   stopColor="#3DD672" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#3DD672" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ns-glow2" cx="80%" cy="85%" r="40%">
          <stop offset="0%"   stopColor="#E63B4A" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#E63B4A" stopOpacity="0" />
        </radialGradient>
        <pattern id="ns-grid" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#1A2A1F" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect width="380" height="480" fill="#050608" />
      <rect width="380" height="480" fill="url(#ns-grid)" />
      <rect width="380" height="480" fill="url(#ns-glow1)" />
      <rect width="380" height="480" fill="url(#ns-glow2)" />
      {[80, 230, 380].map((y, i) => <rect key={i} x="0" y={y} width="380" height="0.6" fill="#3DD672" opacity="0.18" />)}
      {([[40,40,"#3DD672"],[340,80,"#3DD672"],[60,420,"#E63B4A"],[330,440,"#E63B4A"],[200,30,"#E8C07E"]] as [number,number,string][]).map(([x,y,c], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="6" fill={c} opacity="0.18" />
          <circle cx={x} cy={y} r="2" fill={c} />
        </g>
      ))}
      <text x="14" y="468" fontFamily="JetBrains Mono, monospace" fontSize="9" fill="#3DD672" opacity="0.7">gnubg › eq +0.214 · 3-ply</text>
    </svg>
  );
}

// ─── Center medallions ────────────────────────────────────────────────────────

function Med({ size = 32, children }: { size?: number; children: React.ReactNode }) {
  return (
    <div style={{ width: size, height: size, position: "relative" }}>
      <svg viewBox="0 0 32 32" width={size} height={size}>{children}</svg>
    </div>
  );
}

function PersianMedallion() {
  return (
    <Med size={36}>
      <circle cx="16" cy="16" r="15" fill="#1A0E08" stroke="#C49830" strokeWidth="0.5" />
      {Array.from({ length: 8 }).map((_, i) => (
        <ellipse key={i} cx="16" cy="6" rx="2" ry="6" transform={`rotate(${i * 45} 16 16)`} fill="#3FA8B0" stroke="#C49830" strokeWidth="0.3" />
      ))}
      <circle cx="16" cy="16" r="4" fill="#C4423A" stroke="#C49830" strokeWidth="0.4" />
      <circle cx="16" cy="16" r="1.6" fill="#E8B85A" />
    </Med>
  );
}

function RomanMedallion() {
  return (
    <Med size={34}>
      <circle cx="16" cy="16" r="14" fill="#C49830" />
      <circle cx="16" cy="16" r="11" fill="#1A0E08" />
      {Array.from({ length: 10 }).map((_, i) => (
        <ellipse key={i} cx="16" cy="3.5" rx="1" ry="2.4" transform={`rotate(${(i / 10) * 360} 16 16)`} fill="#7D9B4A" />
      ))}
      <text x="16" y="20" textAnchor="middle" fontFamily="serif" fontSize="9" fontWeight="700" fill="#C49830">SPQR</text>
    </Med>
  );
}

function AsianMedallion() {
  return (
    <Med size={36}>
      <circle cx="16" cy="16" r="14" fill="#0A0606" stroke="#C49830" strokeWidth="0.4" />
      {[0, 72, 144, 216, 288].map((a, i) => (
        <ellipse key={i} cx="16" cy="9" rx="3" ry="4.5" transform={`rotate(${a} 16 16)`} fill="#E8B85A" />
      ))}
      <circle cx="16" cy="16" r="2" fill="#C4423A" />
    </Med>
  );
}

function TudorRose() {
  return (
    <Med size={36}>
      <circle cx="16" cy="16" r="15" fill="#0A0604" />
      {[0, 72, 144, 216, 288].map((a, i) => (
        <path key={i} d="M16,4 C20,6 21,10 16,14 C11,10 12,6 16,4 Z" transform={`rotate(${a} 16 16)`} fill="#7A1F18" stroke="#A89878" strokeWidth="0.4" />
      ))}
      {[36, 108, 180, 252, 324].map((a, i) => (
        <path key={i} d="M16,8 C18,10 18,13 16,15 C14,13 14,10 16,8 Z" transform={`rotate(${a} 16 16)`} fill="#E8E1CF" stroke="#A89878" strokeWidth="0.3" />
      ))}
      <circle cx="16" cy="16" r="1.5" fill="#C49830" />
    </Med>
  );
}

function DecoCube() {
  return (
    <Med size={32}>
      <rect x="4" y="4" width="24" height="24" rx="3" fill="#E8C07E" stroke="#7A4A1F" strokeWidth="1" />
      <rect x="5" y="5" width="22" height="22" rx="2" fill="none" stroke="#A87530" strokeWidth="0.4" />
      <text x="16" y="20" textAnchor="middle" fontFamily="Instrument Serif, serif" fontSize="13" fontWeight="700" fill="#2A1208">64</text>
    </Med>
  );
}

function NeuralChip() {
  return (
    <Med size={34}>
      <circle cx="16" cy="16" r="14" fill="#0A0E08" stroke="#3DD672" strokeWidth="0.6" />
      <circle cx="16" cy="16" r="10" fill="none" stroke="#3DD672" strokeWidth="0.4" opacity="0.6" />
      <path d="M10,10 L22,22 M22,10 L10,22" stroke="#3DD672" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2" fill="#3DD672" />
    </Med>
  );
}

// ─── Stage data ───────────────────────────────────────────────────────────────

const STAGES: StageData[] = [
  {
    id: "persian", eraNum: "I", era: "Nard", period: "c. 1500 CE", locale: "Isfahan · Persia",
    name: "Bozorgmehr", epithet: "the Wise", role: "The Patient Weaver",
    signature: "“Time is the great unmaker. I have all of it.”",
    accent: "#E8B85A", Scene: PersianScene, Med: PersianMedallion,
    theme: { frame: "#5A1F18", frameEdge: "#3A1208", felt: "#0E5560", pointA: "#3FA8B0", pointB: "#C4423A", checker1: "#3FA8B0", checker2: "#C4423A", checkerBorder: "#1A0E08", pointNumber: "#E8DCB4", bar: "#3A1208" },
  },
  {
    id: "roman", eraNum: "II", era: "Tabula", period: "c. 50 CE", locale: "Rome",
    name: "Claudius Marcellus", epithet: "Senator", role: "The Aggressive Gladiator",
    signature: "“Three dice. No mercy.”",
    accent: "#E8E1CF", Scene: RomanScene, Med: RomanMedallion,
    theme: { frame: "#B8902E", frameEdge: "#7A5A14", felt: "#EDE6D8", pointA: "#7A1F18", pointB: "#C4A56A", checker1: "#D4B370", checker2: "#F0E5D0", checkerBorder: "#5A4020", pointNumber: "#5A4020", bar: "#9A1F18" },
  },
  {
    id: "asian", eraNum: "III", era: "Shuanglu", period: "Tang–Song · 9th c.", locale: "Chang’an",
    name: "Meiling", epithet: "Lady of the Court", role: "The Hidden Dagger",
    signature: "“Lose the opening. Win the trap.”",
    accent: "#E8B85A", Scene: AsianScene, Med: AsianMedallion,
    theme: { frame: "#0A0A0A", frameEdge: "#000", felt: "#15110E", pointA: "#E8E1CF", pointB: "#1F1A14", checker1: "#3A8F5A", checker2: "#E8E1CF", checkerBorder: "#0A0A0A", pointNumber: "#C9BEA8", bar: "#0A0A0A" },
  },
  {
    id: "tavern", eraNum: "IV", era: "Backgammon", period: "1660s", locale: "London",
    name: "Charles Cavendish", epithet: "Lord", role: "The Iron Anchor",
    signature: "“Hold the bar. Drink the ale.”",
    accent: "#C49830", Scene: TavernScene, Med: TudorRose,
    theme: { frame: "#3A2A1C", frameEdge: "#1A0E08", felt: "#6B4A30", pointA: "#C4A075", pointB: "#2A1A10", checker1: "#E8D4A8", checker2: "#3A2010", checkerBorder: "#1A0E08", pointNumber: "#E8D4A8", bar: "#2A1A10" },
  },
  {
    id: "manhattan", eraNum: "V", era: "Doubling Cube", period: "1925", locale: "New York",
    name: "“Ace” Montgomery", epithet: "High Roller", role: "The Psychological Predator",
    signature: "“Double. Your move.”",
    accent: "#E8C07E", Scene: DecoScene, Med: DecoCube,
    theme: { frame: "#4A2A18", frameEdge: "#1A0E08", felt: "#A87848", pointA: "#7A1F18", pointB: "#1A0E08", checker1: "#E8B040", checker2: "#1A0E08", checkerBorder: "#2A1208", pointNumber: "#2A1208", bar: "#2A1208" },
  },
  {
    id: "neural", eraNum: "VI", era: "Neural Net", period: "gnubg · 2000s", locale: "Anywhere",
    name: "Elena “Zero” Vance", epithet: "Grandmaster", role: "The Math Engine",
    signature: "“Equity +0.214. Take.”",
    accent: "#3DD672", Scene: NeuralScene, Med: NeuralChip,
    theme: { frame: "#050608", frameEdge: "#000", felt: "#0E1014", pointA: "#1A4F2A", pointB: "#4F1A1F", checker1: "#3DD672", checker2: "#E63B4A", checkerBorder: "#050608", pointNumber: "#3DD672", bar: "#050608" },
  },
];

// ─── Stage card components ────────────────────────────────────────────────────

function EraBadge({ stage }: { stage: StageData }) {
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: 2, padding: "6px 10px", background: "rgba(10,8,6,0.94)", border: `1px solid color-mix(in srgb, ${stage.accent} 45%, transparent)`, borderRadius: 4, minWidth: 0 }}>
      <span style={{ display: "flex", alignItems: "baseline", gap: 8, fontFamily: "var(--cg-font-display)", fontSize: 18, fontWeight: 400, color: stage.accent, lineHeight: 1, letterSpacing: "-0.01em" }}>
        <span style={{ fontStyle: "italic" }}>{stage.eraNum}</span>
        <span style={{ color: "#FBF5EA" }}>{stage.era}</span>
      </span>
      <span style={{ fontFamily: "var(--cg-font-mono)", fontSize: 9, color: "#C9BEA8", letterSpacing: "0.06em" }}>{stage.period}</span>
    </div>
  );
}

function ChampionPlate({ stage }: { stage: StageData }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 10px", background: "rgba(10,8,6,0.94)", border: `1px solid color-mix(in srgb, ${stage.accent} 45%, transparent)`, borderRadius: 4, alignItems: "flex-end", textAlign: "right", maxWidth: 200 }}>
      <span style={{ fontFamily: "var(--cg-font-sans)", fontSize: 9, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: stage.accent, lineHeight: 1 }}>{stage.epithet}</span>
      <span style={{ fontFamily: "var(--cg-font-display)", fontSize: 18, fontWeight: 400, color: "#FBF5EA", lineHeight: 1.05, letterSpacing: "-0.01em" }}>{stage.name}</span>
      <span style={{ fontFamily: "var(--cg-font-mono)", fontSize: 9, color: "#C9BEA8" }}>{stage.locale}</span>
    </div>
  );
}

function Signature({ stage }: { stage: StageData }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", background: "rgba(10,8,6,0.94)", border: `1px solid color-mix(in srgb, ${stage.accent} 35%, transparent)`, borderRadius: 4 }}>
      <span style={{ fontFamily: "var(--cg-font-sans)", fontSize: 9, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: stage.accent, lineHeight: 1 }}>{stage.role}</span>
      <span style={{ fontFamily: "var(--cg-font-display)", fontStyle: "italic", fontSize: 15, color: "#E2D7C1", lineHeight: 1.3 }}>{stage.signature}</span>
    </div>
  );
}

function StageCard({ stage }: { stage: StageData }) {
  const { Scene, Med, theme, accent } = stage;
  return (
    <div style={{ position: "relative", width: "100%", aspectRatio: "380 / 480", overflow: "hidden", borderRadius: 14, isolation: "isolate", border: `1px solid color-mix(in srgb, ${accent} 35%, #2E251D)`, boxShadow: "0 18px 40px -12px rgba(0,0,0,0.75)" }}>
      <div style={{ position: "absolute", inset: 0, zIndex: 0 }}><Scene /></div>
      <div style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column", padding: 16, gap: 12 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <EraBadge stage={stage} />
          <ChampionPlate stage={stage} />
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 4 }}>
          <StageBoard theme={theme} medallion={<Med />} />
        </div>
        <Signature stage={stage} />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StagesPage() {
  return (
    <main style={{ background: "var(--cg-bg-0)", minHeight: "100vh", color: "var(--cg-fg-1)", fontFamily: "var(--cg-font-sans)", WebkitFontSmoothing: "antialiased" }}>
      <div style={{ maxWidth: 412, margin: "0 auto", padding: 16, display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontFamily: "var(--cg-font-sans)", fontSize: 10, fontWeight: 600, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--cg-fg-3)" }}>ChainGammon · Stages</span>
          <h1 style={{ margin: 0, fontFamily: "var(--cg-font-display)", fontSize: 30, fontWeight: 400, lineHeight: 1.05, letterSpacing: "-0.01em", color: "var(--cg-fg-1)" }}>Six masters. Six tables.</h1>
          <p style={{ margin: 0, fontFamily: "var(--cg-font-sans)", fontSize: 13, lineHeight: 1.45, color: "var(--cg-fg-3)" }}>Every stage is a flat 2D playfield set into a scene from the era it belongs to. The board geometry is identical across all six — only the materials and the world around them change.</p>
        </div>

        {STAGES.map(s => <StageCard key={s.id} stage={s} />)}

        <div style={{ fontFamily: "var(--cg-font-mono)", fontSize: 10, color: "var(--cg-fg-4)", textAlign: "center", paddingTop: 8, borderTop: "1px solid var(--cg-line-1)" }}>
          2600 BCE → today · 24 points · 30 checkers
        </div>
      </div>
    </main>
  );
}
