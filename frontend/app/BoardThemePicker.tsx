"use client";

import { useI18n } from "./i18n";
import { BOARD_THEMES, THEME_ORDER, type BoardThemeKey } from "./boardThemes";

interface Props {
  value: BoardThemeKey;
  onChange: (key: BoardThemeKey) => void;
}

export function BoardThemePicker({ value, onChange }: Props) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{
        fontSize: 11,
        fontFamily: "var(--cg-font-sans)",
        color: "var(--cg-fg-4)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}>
        {t('board_theme')}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        {THEME_ORDER.map((key) => {
          const t = BOARD_THEMES[key];
          const active = key === value;
          return (
            <button
              key={key}
              title={t.label}
              onClick={() => onChange(key)}
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                border: active
                  ? "2px solid var(--cg-brass)"
                  : "1.5px solid rgba(255,255,255,0.12)",
                padding: 0,
                cursor: "pointer",
                overflow: "hidden",
                background: "none",
                boxShadow: active
                  ? "0 0 0 1px var(--cg-brass-lo)"
                  : "none",
                flexShrink: 0,
                position: "relative",
              }}
              aria-label={t.label}
              aria-pressed={active}
            >
              {t.backgroundImageUrl ? (
                /* Image thumbnail for image-based themes.
                   When backgroundImageCrop is set, use CSS background-size
                   + background-position to show only the relevant crop. */
                <span style={(() => {
                  const crop = t.backgroundImageCrop;
                  if (crop) {
                    // Scale so that the crop section fills the 28×28 thumbnail.
                    const sx = 28 / crop.srcW;
                    const sy = 28 / crop.srcH;
                    return {
                      position: "absolute" as const, top: 0, left: 0,
                      width: "100%", height: "100%",
                      backgroundImage: `url(${t.backgroundImageUrl})`,
                      backgroundSize: `${crop.totalSrcW * sx}px ${crop.totalSrcH * sy}px`,
                      backgroundPosition: `${-crop.srcX * sx}px ${-crop.srcY * sy}px`,
                      backgroundRepeat: "no-repeat",
                    };
                  }
                  return {
                    position: "absolute" as const, top: 0, left: 0,
                    width: "100%", height: "100%",
                    backgroundImage: `url(${t.backgroundImageUrl})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  };
                })()} />
              ) : (
                <>
                  {/* Left half: felt color */}
                  <span style={{
                    position: "absolute", top: 0, left: 0,
                    width: "50%", height: "100%",
                    background: t.felt,
                  }} />
                  {/* Right half: frame color */}
                  <span style={{
                    position: "absolute", top: 0, right: 0,
                    width: "50%", height: "100%",
                    background: `linear-gradient(180deg, ${t.frameStart}, ${t.frameEnd})`,
                  }} />
                  {/* Point color stripe */}
                  <span style={{
                    position: "absolute",
                    top: "25%", left: "20%",
                    width: "30%", height: "50%",
                    background: t.pointDark,
                    opacity: 0.85,
                  }} />
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
